import { Router, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession, userCan } from './auth.js';
import { DataTransfer } from './data-transfer.js';
import { MAX_ARCHIVE_BYTES } from './data-transfer-codec.js';
import { ProductionError } from './production-store.js';
import type { WorshipLibrary } from './worship-library.js';
import type { RelayHandle } from './ws.js';
import type { ProductionTransferAdapter } from './production-data-transfer.js';

const TRANSFER_TTL_MS = 15 * 60 * 1000;
const ImportSchema = z.object({ token: z.string().uuid(), selection: z.unknown() }).strict();

/** File-backed previews and downloads are private, owner-bound and short-lived. */
export function createDataTransferRouter(library: WorshipLibrary, dataDir: string, relay: RelayHandle, production?: ProductionTransferAdapter) {
  const router = Router(), transfer = new DataTransfer(library, dataDir, production);
  type Preview = Awaited<ReturnType<DataTransfer['previewFile']>>;
  const previews = new Map<string, { owner: string; expires: number; value: Preview; dir: string; inUse: boolean }>();
  const downloads = new Map<string, { owner: string; expires: number; file: string; filename: string; dir: string; inUse: boolean }>();
  const active = new Set<Promise<unknown>>(), uploads = new Set<Request>(), downloadStreams = new Set<Response>();
  let busy = false, closing = false;
  async function removePreview(token: string) {
    const entry = previews.get(token); if (!entry) return;
    previews.delete(token);
    await transfer.release(entry.value.archive).catch(() => {});
    await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  }
  async function removeDownload(token: string) {
    const entry = downloads.get(token); if (!entry) return;
    downloads.delete(token); await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  }
  async function purge() {
    for (const [token, entry] of previews) if (!entry.inUse && entry.expires <= Date.now()) await removePreview(token);
    for (const [token, entry] of downloads) if (!entry.inUse && entry.expires <= Date.now()) await removeDownload(token);
  }
  const timer = setInterval(() => { void purge(); }, 60_000); timer.unref();
  function operator(req: Request) {
    const user = readSession(req);
    if (!user) throw new ProductionError(401, 'Sign in to transfer Lumen data.');
    if (!userCan(user, '*', 'author')) throw new ProductionError(403, 'A station-wide author role is required to transfer data.');
    return user;
  }
  router.use('/data-transfer', (req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'private, no-store');
    try { if (closing) throw new ProductionError(503, 'The station is shutting down.'); operator(req); next(); } catch (error) { next(error); }
  });
  const exclusive = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      if (busy) return res.status(409).json({ error: 'Another data transfer is in progress. Please try again when it finishes.' });
      busy = true;
      const operation = Promise.resolve().then(purge).then(() => fn(req, res)).catch(next).finally(() => { busy = false; active.delete(operation); });
      active.add(operation);
    };
  const notify = (message: Record<string, unknown>) => { try { relay.injectRemote(message); } catch { /* Persistence already succeeded. */ } };

  router.get('/data-transfer/catalog', exclusive(async (_req, res) => res.json(await transfer.catalog())));
  router.post('/data-transfer/export', exclusive(async (req, res) => {
    const owner = operator(req).id;
    for (const [token, entry] of downloads) if (entry.owner === owner) {
      if (entry.inUse) throw new ProductionError(409, 'Wait for your current download to finish before exporting again.');
      await removeDownload(token);
    }
    if (downloads.size >= 2) throw new ProductionError(409, 'Two exports are awaiting download. Please try again later.');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-export-'));
    let retained = false;
    try {
      const file = path.join(dir, 'archive.lumen'); await transfer.exportToFile(req.body, file);
      if (operator(req).id !== owner || res.destroyed || closing) return;
      const token = randomUUID(), filename = `lumen-${new Date().toISOString().slice(0, 10)}.lumen`;
      downloads.set(token, { owner, expires: Date.now() + TRANSFER_TTL_MS, file, filename, dir, inUse: false }); retained = true;
      res.json({ downloadUrl: `/api/data-transfer/download/${token}`, filename });
    } finally { if (!retained) await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }));
  router.get('/data-transfer/download/:token', (req, res, next) => {
    try {
      const token = String(req.params.token), entry = downloads.get(token);
      if (!entry || entry.owner !== operator(req).id || entry.expires <= Date.now()) throw new ProductionError(410, 'This download expired. Export the selected content again.');
      if (entry.inUse) throw new ProductionError(409, 'This download is already in progress.');
      entry.inUse = true; downloadStreams.add(res);
      const operation = new Promise<void>(resolve => res.download(entry.file, entry.filename, error => {
        downloadStreams.delete(res);
        void removeDownload(token).finally(() => { if (error && !res.headersSent && !res.destroyed) next(error); resolve(); });
      })).finally(() => active.delete(operation));
      active.add(operation);
    } catch (error) { next(error); }
  });
  router.post('/data-transfer/preview', exclusive(async (req, res) => {
    const owner = operator(req).id;
    for (const [token, entry] of previews) if (entry.owner === owner) await removePreview(token);
    if (previews.size >= 2) throw new ProductionError(409, 'Two import previews are already open. Close a preview and try again.');
    let filename = '';
    try { filename = decodeURIComponent(req.get('X-Lumen-Filename') ?? ''); } catch { /* invalid header */ }
    if (!/\.lumen$/i.test(filename) || !req.is('application/octet-stream')) throw new ProductionError(422, 'Choose a .lumen export file.');
    if (req.get('Content-Encoding') && req.get('Content-Encoding') !== 'identity') throw new ProductionError(415, 'Send the .lumen file without HTTP compression.');
    const declared = req.get('Content-Length');
    const length = declared === undefined ? 0 : Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARCHIVE_BYTES) throw new ProductionError(413, 'This file exceeds the 1 TiB archive limit.');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-preview-'));
    let retained = false;
    try {
      const disk = await fs.statfs(dir);
      if (length + 16 * 1024 * 1024 > disk.bavail * disk.bsize) throw new ProductionError(507, 'There is not enough free disk space for this archive.');
      const file = path.join(dir, 'archive.lumen'); let received = 0, nextDiskCheck = 64 * 1024 * 1024;
      const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_ARCHIVE_BYTES) return callback(new ProductionError(413, 'This file exceeds the 1 TiB archive limit.'));
        if (received >= nextDiskCheck) {
          nextDiskCheck = received + 64 * 1024 * 1024;
          fs.statfs(dir).then(space => callback(space.bavail * space.bsize < 16 * 1024 * 1024 ? new ProductionError(507, 'The station ran out of free space for this archive.') : null, chunk), callback);
        } else callback(null, chunk);
      } });
      uploads.add(req);
      try { await pipeline(req, bound, createWriteStream(file, { flags: 'wx', mode: 0o600 })); }
      finally { uploads.delete(req); }
      if (!received || declared !== undefined && received !== length) throw new ProductionError(422, 'The archive upload is incomplete.');
      const value = await transfer.previewFile(file, path.join(dir, 'assets')); await fs.unlink(file);
      if (operator(req).id !== owner || res.destroyed || closing) { await transfer.release(value.archive); return; }
      const token = randomUUID(), expires = Date.now() + TRANSFER_TTL_MS;
      previews.set(token, { owner, expires, value, dir, inUse: false }); retained = true;
      res.json({ token, createdAt: value.createdAt, expiresAt: new Date(expires).toISOString(), catalog: value.catalog, warnings: value.warnings });
    } finally { if (!retained) await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }));
  router.delete('/data-transfer/preview/:token', (req, res, next) => {
    try {
      const token = String(req.params.token), entry = previews.get(token);
      if (entry?.owner !== operator(req).id) { res.status(204).end(); return; }
      if (entry.inUse) throw new ProductionError(409, 'This archive is being imported.');
      void removePreview(token).then(() => res.status(204).end()).catch(next);
    } catch (error) { next(error); }
  });
  router.post('/data-transfer/import', exclusive(async (req, res) => {
    const input = ImportSchema.parse(req.body), preview = previews.get(input.token), user = operator(req);
    if (!preview || preview.expires <= Date.now() || preview.owner !== user.id) throw new ProductionError(410, 'This import preview expired. Choose the .lumen file again.');
    preview.inUse = true;
    try {
      const result = await transfer.import(preview.value.archive, input.selection, { owner: { id: user.id, name: user.displayName || user.username } });
      await removePreview(input.token);
      if (result.imported.presentations || result.imported.setlists || result.imported.settings) {
        try { const content = JSON.parse(await fs.readFile(path.join(dataDir, 'content.json'), 'utf8')); notify({ t: 'content-updated', updatedAt: content.updatedAt }); } catch { /* No failure after commit. */ }
      }
      if (result.imported.bibles || result.imported.songs || result.imported.setlists) notify({ t: 'library-updated' });
      if (result.imported.media) notify({ t: 'media-added' });
      res.json(result);
    } finally { preview.inUse = false; }
  }));
  router.use('/data-transfer', (error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof ProductionError ? error.status : error instanceof z.ZodError ? 422 : (error as NodeJS.ErrnoException).code === 'ENOSPC' ? 507 : 500;
    const message = error instanceof z.ZodError ? error.issues[0]?.message ?? 'Invalid transfer request.' : error.message;
    if (!res.headersSent && !res.destroyed) res.status(status).json({ error: message });
  });
  return { router, async close() {
    closing = true; clearInterval(timer); for (const req of uploads) req.destroy(); for (const res of downloadStreams) res.destroy();
    await Promise.allSettled([...active]);
    await Promise.allSettled([...previews.keys()].map(removePreview)); await Promise.allSettled([...downloads.keys()].map(removeDownload));
  } };
}
