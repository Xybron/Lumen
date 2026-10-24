import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readSession } from './auth.js';
import { DataClear, type ClearPlan } from './data-clear.js';
import { ProductionError } from './production-store.js';
import type { WorshipLibrary } from './worship-library.js';
import type { RelayHandle } from './ws.js';
import type { ProductionTransferAdapter } from './production-data-transfer.js';

const TTL = 10 * 60 * 1000;
export function createDataClearRouter(library: WorshipLibrary, dataDir: string, relay: RelayHandle, production?: ProductionTransferAdapter, onCleared?: (channels: string[]) => void) {
  const router = Router(), service = new DataClear(library, dataDir, production);
  const previews = new Map<string, { owner: string; expires: number; plan: ClearPlan }>();
  let busy = false, closing = false;
  const active = new Set<Promise<unknown>>();
  const purge = () => { for (const [token, value] of previews) if (value.expires <= Date.now()) previews.delete(token); };
  const timer = setInterval(purge, 60000); timer.unref();
  const admin = (req: Request) => {
    const user = readSession(req);
    if (!user) throw new ProductionError(401, 'Sign in to clear station data.');
    if (!user.isAdmin) throw new ProductionError(403, 'Only a station administrator can clear data.');
    return user;
  };
  const route = (operation: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    try { if (closing) throw new ProductionError(503, 'The station is shutting down.'); admin(req); purge(); } catch (error) { next(error); return; }
    res.set('Cache-Control', 'private, no-store');
    if (busy) { res.status(409).json({ error: 'A data clear is in progress. Please wait for it to finish.' }); return; }
    busy = true;
    const pending = Promise.resolve().then(() => operation(req, res)).catch(next).finally(() => { busy = false; active.delete(pending); });
    active.add(pending);
  };
  router.get('/data-transfer/clear/catalog', route(async (_req, res) => res.json(await service.catalog())));
  router.post('/data-transfer/clear/preview', route(async (req, res) => {
    const user = admin(req), input = z.object({ selection: z.unknown() }).strict().parse(req.body);
    for (const [token, preview] of previews) if (preview.owner === user.id) previews.delete(token);
    if (previews.size >= 2) throw new ProductionError(409, 'Two clear reviews are already open. Close one and retry.');
    const plan = await service.preview(input.selection); admin(req);
    const token = randomUUID(), expires = Date.now() + TTL;
    previews.set(token, { owner: user.id, expires, plan });
    const { fingerprint: _fingerprint, ...view } = plan;
    res.json({ ...view, token, expiresAt: new Date(expires).toISOString() });
  }));
  router.delete('/data-transfer/clear/preview/:token', route(async (req, res) => {
    const token = String(req.params.token);
    if (previews.get(token)?.owner === admin(req).id) previews.delete(token);
    res.status(204).end();
  }));
  router.post('/data-transfer/clear', route(async (req, res) => {
    const input = z.object({ token: z.string().uuid(), confirmation: z.literal('CLEAR') }).strict().parse(req.body);
    const preview = previews.get(input.token);
    if (!preview || preview.expires <= Date.now() || preview.owner !== admin(req).id) throw new ProductionError(410, 'This clear review has expired. Review your selection again.');
    previews.delete(input.token);
    const { changedChannels, ...result } = await service.clear(preview.plan, () => {
      if (admin(req).id !== preview.owner) throw new ProductionError(401, 'Your session changed. Review the clear selection again.');
    });
    try { onCleared?.(changedChannels); } catch { /* Persistence already succeeded. */ }
    try {
      const content = JSON.parse(await fs.readFile(path.join(dataDir, 'content.json'), 'utf8'));
      relay.injectRemote({ t: 'content-updated', updatedAt: content.updatedAt });
      if (result.removed.media) relay.injectRemote({ t: 'music', current: content.music.current ?? null, playing: content.music.mode !== 'off' });
      relay.injectRemote({ t: 'data-cleared' });
      relay.injectRemote({ t: 'library-updated' });
    } catch { /* Notification failure does not undo committed data. */ }
    res.json(result);
  }));
  router.use('/data-transfer/clear', (error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof ProductionError ? error.status : error instanceof z.ZodError ? 422 : 500;
    if (!res.headersSent && !res.destroyed) res.status(status).json({ error: error instanceof z.ZodError ? 'Review your selection and type CLEAR to confirm.' : error.message });
  });
  return { router, async close() { closing = true; clearInterval(timer); await Promise.allSettled([...active]); previews.clear(); } };
}
