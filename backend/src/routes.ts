import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ContentSchema } from './schema.js';
import { ensureChannels } from './migrate-content.js';
import { requireSession } from './auth.js';
import { atomicWriteJson, backupContent } from './atomic.js';
import { withContentLock } from './content-writer.js';
import { pruneOrphanTargets } from './stream-targets.js';
import {
  CONTENT_FILE,
  DATA_DIR,
  MEDIA_DIR,
  MEDIA_KINDS,
  safeMediaPath,
  type MediaKind,
} from './paths.js';
import { makeImageThumb, makeVideoThumb } from './thumbs.js';
import { listMediaLibrary } from './media-library.js';
import { preparePresentationVideo } from './media-video.js';

export const OPERATOR_MEDIA_LIMIT_BYTES = 512 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const kind = req.params.kind as MediaKind;
      if (!MEDIA_KINDS.includes(kind)) return cb(new Error('bad kind'), '');
      const dir = path.join(MEDIA_DIR, kind);
      void fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir), error => cb(error, ''));
    },
    filename: (_req, file, cb) => {
      // Keep the original name but defuse traversal/odd chars.
      const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: OPERATOR_MEDIA_LIMIT_BYTES },
});

export const router = Router();

router.get('/content', async (_req, res) => {
  try {
    const raw = await fs.readFile(CONTENT_FILE, 'utf8');
    // Normalize legacy v1 files forward to the v2 channel shape on read. We parse
    // + re-serialize rather than streaming the raw bytes so a freshly-loaded
    // dashboard always sees channels[] without an on-disk migration write.
    const normalized = ensureChannels(JSON.parse(raw));
    res.json(normalized);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const blank = ContentSchema.parse(
        ensureChannels({
          version: 2,
          updatedAt: new Date().toISOString(),
          settings: {},
          playlists: [],
          music: {},
        }),
      );
      await fs.mkdir(DATA_DIR, { recursive: true });
      await atomicWriteJson(CONTENT_FILE, blank);
      return res.json(blank);
    }
    res.status(500).json({ error: 'read failed' });
  }
});

// Content reads stay public (Live outputs mirror them); only writes are gated.
router.put('/content', requireSession, async (req: Request, res: Response) => {
  const parsed = ContentSchema.safeParse(ensureChannels(req.body ?? {}));
  if (!parsed.success) {
    return res.status(422).json({ error: 'invalid content', issues: parsed.error.issues });
  }
  const next = { ...parsed.data, updatedAt: new Date().toISOString() };
  let stale = false;
  await withContentLock(async () => {
    // Current editors send the version they loaded. In particular, a queued
    // save from another window must not erase newly imported presentations.
    const expected = req.get('X-Lumen-Content-Version');
    if (expected) {
      try {
        const current = JSON.parse(await fs.readFile(CONTENT_FILE, 'utf8'));
        if (current.updatedAt !== expected) { stale = true; return; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await backupContent();
    await atomicWriteJson(CONTENT_FILE, next);
  });
  if (stale) return res.status(409).json({ error: 'Content changed on this station. Your view has been refreshed; please try the edit again.' });
  // Drop secret stream keys for any destination removed by this write.
  pruneOrphanTargets(next.destinations.map((d) => d.id));
  res.json(next);
});

router.get('/media/:kind', async (req, res) => {
  const kind = req.params.kind as MediaKind;
  if (!MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'bad kind' });
  try {
    res.json(await listMediaLibrary(kind));
  } catch {
    res.status(500).json({ error: 'media library unavailable' });
  }
});

router.post('/media/:kind', requireSession, (req, res, next) => {
  if (!MEDIA_KINDS.includes(req.params.kind as MediaKind)) return res.status(400).json({ error: 'Choose a supported media library.' });
  upload.single('file')(req, res, error => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'This file is larger than 512 MB. Choose a smaller file.' });
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC') return res.status(507).json({ error: 'This station is low on storage. Free some space and try again.' });
    if (error) return res.status(400).json({ error: 'This file could not be uploaded. Try selecting it again.' });
    next();
  });
}, async (req, res) => {
  const kind = req.params.kind as MediaKind;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Choose a file to upload.' });
  let savedPath = file.path;
  try {
    if (kind === 'backgrounds') savedPath = await preparePresentationVideo(file.path, file.originalname);
  } catch (error) {
    console.warn('[media] MOV preparation failed:', (error as Error).message);
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC' || /No space left on device/i.test((error as Error).message))
      return res.status(507).json({ error: 'This station is low on storage. Free some space and try again.' });
    return res.status(422).json({ error: 'This MOV video could not be prepared for playback. Export it as MP4 (H.264) and try again.' });
  }
  const filename = path.basename(savedPath), rel = `media/${kind}/${filename}`;
  let thumbnail: string | null = null;
  if (kind === 'backgrounds') {
    if (/\.(png|jpe?g|webp|gif)$/i.test(filename)) {
      thumbnail = await makeImageThumb(savedPath, filename);
    } else if (/\.(mp4|webm|mov|m4v)$/i.test(filename)) {
      thumbnail = await makeVideoThumb(savedPath, filename);
    }
  }
  res.json({ path: rel, thumbnail });
});

router.delete('/media/:kind/:filename', requireSession, async (req, res) => {
  const kind = req.params.kind as MediaKind;
  if (!MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'bad kind' });
  const target = safeMediaPath(kind, String(req.params.filename));
  if (!target) return res.status(400).json({ error: 'bad path' });
  try {
    await fs.unlink(target);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});
