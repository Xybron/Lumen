import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { INCOMING_DIR, MEDIA_DIR, safeIncomingPath } from './paths.js';
import { requireSession, requireAdmin, type SessionUser } from './auth.js';
import { makeImageThumb, makeVideoThumb } from './thumbs.js';
import { addPending, getPending, listPending, markDecided } from './media-staging.js';
import {
  mediaEngineEnabled,
  getStatus,
  registerWhip,
} from './media-engine.js';
import { listTargets } from './stream-targets.js';
import type { RelayHandle } from './ws.js';

// Phone/contributor media flow. Uploads land in media/incoming/ (quarantined,
// never publicly served) as a media_staging row; an operator approves (moves the
// file into the real media kind) or rejects (deletes it). A `media-added` frame
// notifies operators in real time.

const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
const VID_RE = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_RE = /\.(m4a|mp3|wav|aac|ogg|flac)$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await fs.mkdir(INCOMING_DIR, { recursive: true });
      cb(null, INCOMING_DIR);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
      cb(null, `${Date.now()}-${randomBytes(3).toString('hex')}-${safe}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Lightweight in-memory per-IP rate limit for the unauthenticated contribute
// endpoint (disk-fill / spam guard). No external dep.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 10;
const rlHits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rlHits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  hits.push(now);
  rlHits.set(ip, hits);
  return hits.length > RL_MAX;
}

export function createMediaRouter(relay: RelayHandle): Router {
  const router = Router();

  // ── Contribute (UNAUTHENTICATED — phones have no login) ──
  router.post('/contribute', upload.single('file'), async (req, res) => {
    if (rateLimited(req.ip ?? 'unknown')) {
      if (req.file) await fs.unlink(req.file.path).catch(() => {});
      return res.status(429).json({ error: 'too many uploads — slow down' });
    }
    const file = req.file;
    const targetKind = String(req.body?.targetKind ?? '');
    const contributor = typeof req.body?.contributor === 'string' ? req.body.contributor.slice(0, 80) : null;
    if (!file) return res.status(400).json({ error: 'no file' });

    const isMedia =
      (targetKind === 'backgrounds' && (IMG_RE.test(file.filename) || VID_RE.test(file.filename))) ||
      (targetKind === 'music' && AUDIO_RE.test(file.filename));
    if (!isMedia) {
      await fs.unlink(file.path).catch(() => {});
      return res.status(415).json({ error: 'unsupported file type for this kind' });
    }

    let thumbnail: string | null = null;
    if (targetKind === 'backgrounds') {
      if (IMG_RE.test(file.filename)) thumbnail = await makeImageThumb(file.path, file.filename);
      else if (VID_RE.test(file.filename)) thumbnail = await makeVideoThumb(file.path, file.filename);
    }

    const id = `stg_${randomBytes(5).toString('hex')}`;
    addPending({
      id,
      filename: file.filename,
      origName: file.originalname,
      mime: file.mimetype ?? null,
      size: file.size ?? null,
      targetKind,
      contributor,
      thumbnail,
    });

    // Notify operators (global frame; not cached — the authoritative list is
    // GET /api/staging, fetched on the signal).
    relay.injectRemote({ t: 'media-added', kind: targetKind, pendingId: id, contributor: contributor ?? undefined });

    res.json({ id, status: 'pending' });
  });

  // ── Operator: list pending ──
  router.get('/staging', requireSession, (_req, res) => {
    res.json({
      pending: listPending().map((r) => ({
        id: r.id,
        origName: r.orig_name,
        mime: r.mime,
        size: r.size,
        targetKind: r.target_kind,
        contributor: r.contributor,
        thumbnail: r.thumbnail,
        createdAt: r.created_at,
        // preview is served through the authenticated raw endpoint, not /media
        rawUrl: `/api/staging/${r.id}/raw`,
      })),
    });
  });

  // ── Operator: authenticated preview of a pending file ──
  router.get('/staging/:id/raw', requireSession, (req, res) => {
    const row = getPending(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found' });
    const abs = safeIncomingPath(row.filename);
    if (!abs) return res.status(400).json({ error: 'bad path' });
    res.sendFile(abs);
  });

  // ── Operator: approve → move into the real media kind ──
  router.post('/staging/:id/approve', requireSession, async (req, res) => {
    const user = (req as typeof req & { user?: SessionUser }).user!;
    const row = getPending(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'already decided' });
    const src = safeIncomingPath(row.filename);
    if (!src) return res.status(400).json({ error: 'bad path' });

    const destDir = path.join(MEDIA_DIR, row.target_kind);
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, row.filename);
    try {
      await fs.rename(src, dest);
    } catch (err) {
      // Cross-device fallback (EXDEV): copy then unlink.
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await fs.copyFile(src, dest);
        await fs.unlink(src).catch(() => {});
      } else {
        return res.status(500).json({ error: 'move failed' });
      }
    }
    markDecided(row.id, 'approved', user.id);
    res.json({ path: `media/${row.target_kind}/${row.filename}`, thumbnail: row.thumbnail });
  });

  // ── Operator: reject → delete the incoming file ──
  router.post('/staging/:id/reject', requireSession, async (req, res) => {
    const user = (req as typeof req & { user?: SessionUser }).user!;
    const row = getPending(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'already decided' });
    const abs = safeIncomingPath(row.filename);
    if (abs) await fs.unlink(abs).catch(() => {});
    markDecided(row.id, 'rejected', user.id);
    res.json({ ok: true });
  });

  // ── Stream egress control (Phase 4) — proxies the media sidecar, gated ──
  router.get('/media/stream/status', requireSession, async (_req, res) => {
    if (!mediaEngineEnabled()) return res.json({ enabled: false, egress: [], ingest: [] });
    const s = await getStatus();
    res.json({ enabled: false, egress: [], ingest: s?.ingest ?? [] });
  });

  // Non-secret list of configured RTMP targets (stream keys never returned).
  router.get('/media/stream/targets', requireSession, (_req, res) => {
    res.json({ targets: listTargets() });
  });

  // Retired sidecar egress used a channel page, not Studio's composed Program,
  // and shipped with simulated Live status. Preserve old credentials, but never
  // let an older controller start that path or report a fictitious broadcast.
  for (const action of ['target', 'start', 'stop']) router.post(`/media/stream/:destinationId/${action}`, requireAdmin, (_req, res) => {
    res.status(410).json({ error: 'Use Go Live in Studio or the channel top bar. Legacy sidecar streaming has been retired.' });
  });

  // WHIP ingest URL for a phone/browser camera to POST its SDP to.
  router.get('/media/ingest/whip-url', requireSession, async (req, res) => {
    if (!mediaEngineEnabled()) return res.status(503).json({ error: 'media engine offline' });
    const sourceId = String(req.query.sourceId ?? '');
    if (!sourceId) return res.status(400).json({ error: 'sourceId required' });
    const result = await registerWhip(sourceId);
    if (!result) return res.status(502).json({ error: 'sidecar unavailable' });
    res.json(result);
  });

  return router;
}
