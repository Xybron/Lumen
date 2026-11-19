import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireSession, userCan, type SessionUser } from './auth.js';
import { atomicWriteJson } from './atomic.js';
import { withContentLock } from './content-writer.js';
import { ContentSchema, type Content } from './schema.js';
import { ensureChannels } from './migrate-content.js';
import { DATA_DIR, MEDIA_DIR, CONTENT_FILE } from './paths.js';
import { listMediaLibrary, mediaFileKind, mediaVideoAliases } from './media-library.js';
import { sourceVideoStatus, withSourceVideoDeletion, MediaVideoBusyError } from './media-video.js';
import { mediaAliasFile, readMediaAliases } from './media-metadata.js';
import { ProductionError, type ProductionStore } from './production-store.js';
import type { ClipIndex, ClipTransferAccess, ClipTransferSession } from './clips.js';
import { resolveMediaUsage, type MediaUsageIndex } from './media-usage.js';
import type { MediaLibraryAsset, MediaLibraryResponse, MediaDeleteResult, MediaUsage } from '../../shared/media-library.js';

const mediaIdSchema = z.string().min(1).max(500).refine(value => {
  if (value.startsWith('clip:')) return /^clip:asset_[\w-]+$/.test(value);
  const name = value.slice(value.startsWith('music:') ? 6 : 8);
  return (value.startsWith('library:') || value.startsWith('music:')) && !!name && !name.startsWith('.') && !name.includes('..')
    && !/[\/\\\x00-\x1f]/.test(name) && !!mediaFileKind(name);
}, 'Choose an asset from the media library.');
const publicKey = (id: string) => id.startsWith('library:') ? `media/backgrounds/${id.slice(8)}` : id.startsWith('music:') ? `media/music/${id.slice(6)}` : id;
const url = (relative: string) => `/${relative.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
export class MediaUsageError extends ProductionError {
  constructor(message: string, public usage: MediaUsage[]) { super(409, message); }
}

/** Deletes originals and unambiguous derived previews, never unrelated files. */
export async function removeLibraryFile(mediaDir: string, kind: string, filename: string) {
  if (!['backgrounds', 'music', 'thumbnails'].includes(kind) || !filename || filename !== path.basename(filename) || /[\/\\\x00-\x1f]/.test(filename) || filename.includes('..')) throw new ProductionError(400, 'Choose a valid media file.');
  if (kind === 'backgrounds') {
    const aliases = await mediaVideoAliases(mediaDir);
    if (aliases.some(([, prepared]) => prepared === `media/backgrounds/${filename}`)) throw new ProductionError(409, 'This file is a prepared copy of a MOV video. Manage the original video in Media.');
  }
  try {
    return await withSourceVideoDeletion(kind === 'backgrounds' ? [path.join(mediaDir, kind, filename)] : [], () => removeLibraryFileUnlocked(mediaDir, kind, filename));
  } catch (error) {
    if (error instanceof MediaVideoBusyError) throw new ProductionError(409, error.message);
    throw error;
  }
}

async function removeLibraryFileUnlocked(mediaDir: string, kind: string, filename: string) {
  const directory = path.join(mediaDir, kind), target = path.join(directory, filename);
  if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) throw new ProductionError(400, 'This media directory is unavailable.');
  if (!(await fs.lstat(target)).isFile()) throw new ProductionError(400, 'Choose a regular media file.');
  await fs.unlink(target);
  if (kind !== 'backgrounds') return;
  if (/\.mov$/i.test(filename)) await fs.unlink(target.replace(/\.mov$/i, '.mp4')).catch(() => {});
  const stem = filename.replace(/\.[^.]+$/, '');
  // A legacy JPEG thumbnail can be shared by same-stem originals. Preserve it
  // until the last original is gone, including video/image filename collisions.
  const remaining = await fs.readdir(directory).catch(() => [filename]);
  if (!remaining.some(name => name.replace(/\.[^.]+$/, '') === stem)) {
    const thumb = path.join(mediaDir, 'thumbnails', `${stem}.jpg`);
    try {
      const folder = await fs.lstat(path.dirname(thumb));
      if (folder.isDirectory() && !folder.isSymbolicLink()) await fs.unlink(thumb);
    } catch { /* Original removal succeeded; inaccessible derivatives can be cleaned later. */ }
  }
}

export class MediaCatalog {
  private readonly dir: string;
  private readonly mediaDir: string;
  private readonly contentFile: string;
  constructor(private store: ProductionStore, private clips: ClipTransferAccess | undefined,
    options: { dir?: string; mediaDir?: string; contentFile?: string } = {}) {
    this.dir = options.dir ?? DATA_DIR; this.mediaDir = options.mediaDir ?? MEDIA_DIR; this.contentFile = options.contentFile ?? CONTENT_FILE;
  }
  private async content(): Promise<Content> {
    try { return ContentSchema.parse(ensureChannels(JSON.parse(await fs.readFile(this.contentFile, 'utf8')))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ContentSchema.parse(ensureChannels({ version: 2, updatedAt: new Date().toISOString(), settings: {}, playlists: [], music: {} }));
      throw new ProductionError(503, 'Media usage could not be checked. Repair or reload the content library before deleting assets.');
    }
  }
  private async usages(clips?: ClipIndex, retainedExports?: Set<string>): Promise<MediaUsageIndex> {
    const snapshot = clips ? undefined : this.clips?.snapshot();
    const index = resolveMediaUsage(await this.content(), this.store.get(), clips ?? snapshot?.data, this.store.mediaTransitionSnapshots(),
      retainedExports ?? new Set([...(snapshot?.activeExportIds ?? []), ...(snapshot?.downloads ?? [])]));
    for (const keys of await mediaVideoAliases(this.mediaDir)) {
      const usage = [...new Map(keys.flatMap(key => index.get(key) ?? []).map(value => [value.id, value])).values()];
      for (const key of keys) index.set(key, usage);
    }
    return index;
  }
  async list(): Promise<MediaLibraryResponse> {
    const [backgrounds, music, aliases] = await Promise.all([listMediaLibrary('backgrounds', this.mediaDir), listMediaLibrary('music', this.mediaDir), readMediaAliases(this.dir)]);
    let index: MediaUsageIndex = new Map(), warning: string | undefined;
    try {
      if (!this.clips) throw new Error('Clips unavailable');
      index = await this.usages();
    } catch { warning = 'Usage is unavailable. Deletion is disabled until every content library can be checked.'; }
    const asset = (value: Omit<MediaLibraryAsset, 'usage' | 'usageStatus' | 'displayName'>, key: string): MediaLibraryAsset => ({
      ...value, displayName: aliases[value.id] ?? value.name.replace(/^\d{13}-/, ''), usageStatus: warning ? 'unavailable' : 'known', usage: index.get(key) ?? [],
    });
    const assets: MediaLibraryAsset[] = [];
    for (const file of [...backgrounds, ...music]) {
      const kind = mediaFileKind(file.name); if (!kind) continue;
      const entry = asset({
        id: `${file.path.startsWith('media/music/') ? 'music' : 'library'}:${file.name}`, kind, name: file.name, libraryPath: file.path,
        url: url(file.path), thumbnail: file.thumbnail ? url(file.thumbnail) : null,
        bytes: file.bytes, modifiedAt: file.modifiedAt, origin: 'library',
      }, file.path);
      if (/\.mov$/i.test(file.name)) {
        const status = await sourceVideoStatus(path.join(this.mediaDir, file.path.slice(6)), { resume: false });
        entry.preparation = status.status;
        if (status.status === 'ready' && status.path) {
          entry.playbackPath = file.path.replace(/\.mov$/i, '.mp4');
          entry.playbackUrl = url(entry.playbackPath);
        }
      }
      assets.push(entry);
    }
    for (const file of this.clips?.snapshot().assets ?? []) assets.push(asset({
      id: `clip:${file.id}`, name: file.name, url: `/api/clips/assets/${encodeURIComponent(file.id)}/media`, thumbnail: null,
      kind: file.kind, bytes: file.bytes, modifiedAt: file.createdAt, origin: 'clip', width: file.width, height: file.height, durationMs: file.durationMs,
    }, `clip:${file.id}`));
    return { assets: assets.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) || a.name.localeCompare(b.name)), ...(warning ? { warning } : {}) };
  }
  async rename(id: string, displayName: string): Promise<MediaLibraryAsset> {
    mediaIdSchema.parse(id);
    const name = z.string().trim().min(1).max(160).refine(value => !/[\x00-\x1f]/.test(value), 'Use a display name without control characters.').parse(displayName);
    return withContentLock(async () => {
      const asset = (await this.list()).assets.find(value => value.id === id);
      if (!asset) throw new ProductionError(404, 'This asset was already removed.');
      const aliases = await readMediaAliases(this.dir); aliases[id] = name;
      await atomicWriteJson(mediaAliasFile(this.dir), aliases);
      return { ...asset, displayName: name };
    });
  }
  /** Content -> Studio -> Clips matches the data-transfer lock order. */
  private withUsageLock<T>(operation: (index: MediaUsageIndex, session: ClipTransferSession) => Promise<T>): Promise<T> {
    return withContentLock(() => this.store.withTransferLock(async () => {
      if (!this.clips) throw new ProductionError(503, 'Usage is unavailable while the Clips workspace is offline. No assets were deleted.');
      const lock = this.clips.withMediaLock?.bind(this.clips) ?? this.clips.withLock.bind(this.clips);
      return lock(async session => operation(await this.usages(session.data, new Set([...session.downloads, ...(session.activeExportIds ?? [])])), session));
    }));
  }
  async delete(ids: string[]): Promise<MediaDeleteResult> {
    const chosen = z.array(mediaIdSchema).min(1).max(200).parse(ids);
    return this.withUsageLock(async (index, session) => {
      const result: MediaDeleteResult = { deleted: [], blocked: [] };
      for (const id of new Set(chosen)) {
        const key = publicKey(id);
        const usage = index.get(key) ?? [];
        if (usage.length) { result.blocked.push({ id, error: 'This asset is in use. Remove or replace it in every listed location first.', usage }); continue; }
        try {
          if (id.startsWith('library:')) await removeLibraryFile(this.mediaDir, 'backgrounds', id.slice(8));
          else if (id.startsWith('music:')) await removeLibraryFile(this.mediaDir, 'music', id.slice(6));
          else await this.removeClipAsset(id.slice(5), session);
          result.deleted.push(id);
        } catch (error) {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          result.blocked.push({ id, error: missing ? 'This asset was already removed. Refresh the library.' : error instanceof ProductionError ? error.message : 'This asset could not be deleted. Please try again.', usage: [] });
        }
      }
      // Stale aliases are harmless if cleanup fails; never report a successful
      // original deletion as a failure because display-name cleanup failed.
      if (result.deleted.length) try {
        const aliases = await readMediaAliases(this.dir); result.deleted.forEach(id => { delete aliases[id]; });
        await atomicWriteJson(mediaAliasFile(this.dir), aliases);
      } catch { /* A future rename can repair metadata without losing an image. */ }
      return result;
    });
  }
  private async removeClipAsset(id: string, session: ClipTransferSession) {
    if (session.withAssetDeletion) return session.withAssetDeletion(id, () => this.removeClipAssetFile(id, session));
    return this.removeClipAssetFile(id, session);
  }
  private async removeClipAssetFile(id: string, session: ClipTransferSession) {
    const asset = session.assets.find(value => value.id === id);
    if (!asset) throw new ProductionError(404, 'This asset was already removed. Refresh the library.');
    const original = path.join(session.assetDir, `${asset.id}.${asset.extension}`);
    if (!(await fs.lstat(original)).isFile()) throw new ProductionError(400, 'Choose a regular media file.');
    const tombstone = path.join(session.assetDir, `.delete-${randomUUID()}`);
    await fs.rename(original, tombstone);
    const next = session.assets.filter(value => value.id !== id);
    try { await atomicWriteJson(session.assetFile, next); }
    catch (error) { await fs.rename(tombstone, original); throw error; }
    session.assets = next; session.replaceSync(session.data, next);
    await fs.unlink(tombstone).catch(() => {});
  }
  /** Existing media-delete callers receive the same complete dependency guard. */
  withUnusedMedia<T>(ids: string[], operation: () => Promise<T>): Promise<T> {
    return this.withUsageLock(async index => {
      const usage = ids.flatMap(id => index.get(id.replace(/^\/+/, '')) ?? []);
      if (usage.length) throw new MediaUsageError('This media is in use. Remove it from its sources, presentations and live outputs first.', usage);
      return operation();
    });
  }
}

export function requireMediaAuthor(req: Request, res: Response, next: NextFunction) {
  const user = (req as Request & { user: SessionUser }).user;
  if (!userCan(user, '*', 'author')) return res.status(403).json({ error: 'Managing shared media requires author access to all channels.' });
  next();
}
export function createMediaCatalogRouter(catalog: MediaCatalog) {
  const router = Router();
  router.use('/media-library', requireSession, requireMediaAuthor, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
  router.get('/media-library', wrap(async (_req, res) => res.json(await catalog.list())));
  router.patch('/media-library/:id', wrap(async (req, res) => {
    const body = z.object({ displayName: z.string() }).strict().parse(req.body);
    res.json(await catalog.rename(String(req.params.id), body.displayName));
  }));
  router.post('/media-library/delete', wrap(async (req, res) => {
    const body = z.object({ ids: z.array(z.string()) }).strict().parse(req.body);
    res.json(await catalog.delete(body.ids));
  }));
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof z.ZodError) { res.status(422).json({ error: error.issues[0]?.message ?? 'Choose valid media.' }); return; }
    if (error instanceof ProductionError) { res.status(error.status).json({ error: error.message }); return; }
    console.error('[media-library] The library operation could not be completed.');
    res.status(503).json({ error: 'The media library is unavailable. Existing assets were preserved; please try again.' });
  });
  return router;
}
