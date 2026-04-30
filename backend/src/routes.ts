import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ContentSchema } from './schema.js';
import { atomicWriteJson, backupContent } from './atomic.js';
import {
  CONTENT_FILE,
  DATA_DIR,
  MEDIA_DIR,
  MEDIA_KINDS,
  safeMediaPath,
  type MediaKind,
} from './paths.js';
import { makeImageThumb, makeVideoThumb } from './thumbs.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const kind = req.params.kind as MediaKind;
      if (!MEDIA_KINDS.includes(kind)) return cb(new Error('bad kind'), '');
      const dir = path.join(MEDIA_DIR, kind);
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      // Keep the original name but defuse traversal/odd chars.
      const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

export const router = Router();

router.get('/content', async (_req, res) => {
  try {
    const raw = await fs.readFile(CONTENT_FILE, 'utf8');
    res.type('application/json').send(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const blank = ContentSchema.parse({
        version: 1,
        updatedAt: new Date().toISOString(),
        settings: {},
        playlists: [],
        music: {},
      });
      await fs.mkdir(DATA_DIR, { recursive: true });
      await atomicWriteJson(CONTENT_FILE, blank);
      return res.json(blank);
    }
    res.status(500).json({ error: 'read failed' });
  }
});

router.put('/content', async (req: Request, res: Response) => {
  const parsed = ContentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: 'invalid content', issues: parsed.error.issues });
  }
  const next = { ...parsed.data, updatedAt: new Date().toISOString() };
  await backupContent();
  await atomicWriteJson(CONTENT_FILE, next);
  res.json(next);
});

router.get('/media/:kind', async (req, res) => {
  const kind = req.params.kind as MediaKind;
  if (!MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'bad kind' });
  const dir = path.join(MEDIA_DIR, kind);
  try {
    const files = await fs.readdir(dir);
    res.json(
      files
        .filter((f) => !f.startsWith('.'))
        .map((f) => ({ name: f, path: `media/${kind}/${f}` })),
    );
  } catch {
    res.json([]);
  }
});

router.post('/media/:kind', upload.single('file'), async (req, res) => {
  const kind = req.params.kind as MediaKind;
  if (!MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'bad kind' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'no file' });
  const rel = `media/${kind}/${file.filename}`;
  let thumbnail: string | null = null;
  if (kind === 'backgrounds') {
    if (/\.(png|jpe?g|webp|gif)$/i.test(file.filename)) {
      thumbnail = await makeImageThumb(file.path, file.filename);
    } else if (/\.(mp4|webm|mov|m4v)$/i.test(file.filename)) {
      thumbnail = await makeVideoThumb(file.path, file.filename);
    }
  }
  res.json({ path: rel, thumbnail });
});

router.delete('/media/:kind/:filename', async (req, res) => {
  const kind = req.params.kind as MediaKind;
  if (!MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'bad kind' });
  const target = safeMediaPath(kind, req.params.filename);
  if (!target) return res.status(400).json({ error: 'bad path' });
  try {
    await fs.unlink(target);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});
