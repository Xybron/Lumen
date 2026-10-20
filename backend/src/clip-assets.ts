import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { atomicWriteJson } from './atomic.js';
import type { SessionUser } from './auth.js';
import type { ClipAsset } from '../../shared/clips.js';

export const CLIP_UPLOAD_BYTES = 512 * 1024 * 1024;
export const CLIP_INPUT_FORMATS = 'mov,matroska,webm,mp3,wav,ogg,image2,png_pipe,jpeg_pipe,webp_pipe';
const schema = z.object({
  id: z.string().regex(/^asset_[\w-]+$/), name: z.string().min(1).max(160),
  kind: z.enum(['video', 'image', 'audio']), mime: z.string().max(80), bytes: z.number().int().positive(),
  durationMs: z.number().int().min(0).max(86400000), width: z.number().int().min(0).max(16384), height: z.number().int().min(0).max(16384),
  ownerId: z.string().min(1).max(150), ownerName: z.string().min(1).max(150), createdAt: z.string().datetime(),
  extension: z.enum(['mp4', 'webm', 'mp3', 'wav', 'ogg', 'png', 'jpg', 'webp']),
}).strict();
type SavedAsset = z.infer<typeof schema>;
export class ClipAssetError extends Error { constructor(public status: number, message: string) { super(message); } }
function signature(bytes: Buffer, mime: string): Pick<SavedAsset, 'kind' | 'mime' | 'extension'> | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: 'image', mime: 'image/png', extension: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { kind: 'image', mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', extension: 'webp' };
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return { kind: mime.startsWith('audio/') ? 'audio' : 'video', mime: mime.startsWith('audio/') ? 'audio/mp4' : 'video/mp4', extension: 'mp4' };
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return { kind: mime.startsWith('audio/') ? 'audio' : 'video', mime: mime.startsWith('audio/') ? 'audio/webm' : 'video/webm', extension: 'webm' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', extension: 'wav' };
  if (bytes.toString('ascii', 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', extension: 'ogg' };
  if (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224) return { kind: 'audio', mime: 'audio/mpeg', extension: 'mp3' };
  return null;
}

// Imported editing media stays private and never enters Studio's public media
// mount or live source/audio graph. Browser metadata enables editing during a
// service; the bounded export worker independently verifies the real streams.
export async function createClipAssets(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  const incoming = path.join(dir, 'incoming'); await fs.mkdir(incoming, { recursive: true });
  const indexPath = path.join(dir, 'assets.json');
  let assets: SavedAsset[] = [];
  try { assets = z.array(schema).max(2000).parse(JSON.parse(await fs.readFile(indexPath, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The imported-media index could not be read. Existing files are preserved.'); }
  let writes: Promise<unknown> = Promise.resolve(), uploading = 0, closed = false;
  const pending = new Set<Promise<unknown>>();
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    const operation = fn(req, res); pending.add(operation);
    void operation.catch(next).finally(() => { pending.delete(operation); });
  };
  function serial<T>(fn: () => Promise<T>) { const run = writes.then(fn); writes = run.catch(() => {}); return run; }
  const list = (): ClipAsset[] => assets.map(({ extension: _, ...asset }) => ({ ...asset }));
  function requireAsset(id: string) { const asset = assets.find(value => value.id === id); if (!asset) throw new ClipAssetError(404, 'Imported media not found.'); return asset; }
  function resolve(id: string) { const asset = requireAsset(id); return { asset, path: path.join(dir, `${asset.id}.${asset.extension}`) }; }
  const upload = multer({ storage: multer.diskStorage({ destination: incoming, filename: (_req, _file, done) => done(null, `${randomUUID()}.upload`) }),
    limits: { fileSize: CLIP_UPLOAD_BYTES, files: 1, fields: 3, fieldSize: 1000 },
  });
  const router = Router();
  router.post('/clips/assets', (req, res, next) => {
    if (closed) { res.status(503).json({ error: 'Clips is shutting down. Please retry shortly.' }); return; }
    if (uploading >= 2) { res.status(429).json({ error: 'Two imports are already in progress. Try again shortly.' }); return; }
    uploading++; let released = false;
    const release = () => { if (!released) { released = true; uploading--; } };
    res.once('finish', release); res.once('close', release); next();
  }, wrap(async (req, _res) => {
    const disk = await fs.statfs(dir);
    // Reserve for both bounded imports, not just this request. Two simultaneous
    // uploads must not each consume the same remaining free space.
    if (disk.bavail * disk.bsize < CLIP_UPLOAD_BYTES * uploading + 128 * 1024 * 1024) throw new ClipAssetError(507, 'Free some station storage before importing media.');
    await new Promise<void>((resolve, reject) => upload.single('file')(req, _res, error => error ? reject(error) : resolve()));
    try {
      if (!req.file) throw new ClipAssetError(422, 'Choose a video, image or audio file.');
      const handle = await fs.open(req.file.path, 'r'); const bytes = Buffer.alloc(64);
      try { await handle.read(bytes, 0, bytes.length, 0); } finally { await handle.close(); }
      const format = signature(bytes, req.file.mimetype);
      if (!format) throw new ClipAssetError(415, 'Use MP4/WebM video, PNG/JPEG/WebP images, or MP3/WAV/Ogg audio.');
      const metadata = z.object({ durationMs: z.coerce.number().int().min(0).max(86400000), width: z.coerce.number().int().min(0).max(16384), height: z.coerce.number().int().min(0).max(16384) }).parse(req.body);
      if (format.kind === 'image') {
        const info = await sharp(req.file.path, { limitInputPixels: 33554432 }).metadata().catch(() => { throw new ClipAssetError(422, 'This image is unreadable or too large. Try another PNG, JPEG or WebP image.'); });
        if (!info.width || !info.height || info.width < 2 || info.height < 2 || info.width * info.height > 33554432) throw new ClipAssetError(422, 'Use an image at least 2 × 2 pixels and no larger than 32 megapixels.');
        metadata.width = info.width; metadata.height = info.height; metadata.durationMs = 0;
      } else if (metadata.durationMs < 100 || format.kind === 'video' && (metadata.width < 2 || metadata.height < 2)) throw new ClipAssetError(422, 'The browser could not read this media. Try another supported file.');
      if (metadata.width * metadata.height > 33554432) throw new ClipAssetError(422, 'Media above 32 megapixels is not supported.');
      const user = (req as Request & { user: SessionUser }).user;
      const saved = await serial(async () => {
        if (closed) throw new ClipAssetError(503, 'Clips is shutting down. Please retry the import shortly.');
        if (assets.length >= 2000 || assets.filter(value => value.ownerId === user.id).length >= 500) throw new ClipAssetError(409, 'The imported media limit has been reached.');
        const asset: SavedAsset = { id: `asset_${randomUUID()}`, name: req.file!.originalname.replace(/[\x00-\x1f]/g, '').slice(0, 160) || 'Imported media',
          ...format, ...metadata, bytes: req.file!.size, ownerId: user.id, ownerName: user.displayName || user.username, createdAt: new Date().toISOString() };
        const target = path.join(dir, `${asset.id}.${asset.extension}`);
        const handle = await fs.open(req.file!.path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(req.file!.path, target); assets.push(asset);
        try { await atomicWriteJson(indexPath, assets); }
        catch (error) { assets.pop(); await fs.unlink(target).catch(() => {}); throw error; }
        const { extension: _, ...result } = asset; return result;
      });
      _res.status(201).json(saved);
    } finally { if (req.file) await fs.unlink(req.file.path).catch(() => {}); }
  }));
  router.get('/clips/assets/:id/media', (req, res, next) => {
    try { const resolved = resolve(String(req.params.id)); res.type(resolved.asset.mime).set('Cache-Control', 'private, max-age=3600').sendFile(path.resolve(resolved.path), error => { if (error && !res.headersSent) next(error); }); }
    catch (error) { next(error); }
  });
  return { router, list, resolve, async close() { closed = true; await Promise.allSettled([...pending]); await writes; } };
}
