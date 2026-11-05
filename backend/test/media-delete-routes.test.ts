import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

test('media deletion preserves referenced background files including a MOV converted companion', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-media-delete-'));
  const previous = process.env.LUMEN_DATA_DIR;
  process.env.LUMEN_DATA_DIR = dir;
  let server: http.Server | undefined, identity: { close(): void } | undefined;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    identity?.close();
    if (previous === undefined) delete process.env.LUMEN_DATA_DIR;
    else process.env.LUMEN_DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { DATA_DIR } = await import('../src/paths.js');
  assert.equal(DATA_DIR, dir, 'Never use the real station for this test.');
  const { initDb } = await import('../src/db.js'); identity = initDb();
  const { login } = await import('../src/auth.js');
  const { ProductionStore } = await import('../src/production-store.js');
  const { RecordingStore } = await import('../src/production-recordings.js');
  const { ProductionDataTransfer } = await import('../src/production-data-transfer.js');
  const { createMediaDeleteRouter } = await import('../src/media-delete-routes.js');
  const store = new ProductionStore(dir); await store.init();
  const recordings = new RecordingStore(path.join(dir, 'recordings'), () => {}); await recordings.init();
  const adapter = new ProductionDataTransfer(store, recordings, undefined);
  const app = express(); app.use('/api', createMediaDeleteRouter(adapter));
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/media/backgrounds`;
  const headers = { Cookie: `lumen_session=${login('admin', 'admin')!.sessionId}` };
  const mediaDir = path.join(dir, 'media/backgrounds'); await fs.mkdir(mediaDir, { recursive: true });
  for (const name of ['worship.mov', 'worship.mp4']) await fs.writeFile(path.join(mediaDir, name), 'synthetic video');
  let state = store.get();
  state.scenes[0].layers[0].mediaBackground = { kind: 'video', url: '/media/backgrounds/worship.mp4', fit: 'cover', dim: .4, loop: true };
  state = await store.save(state);
  const denied = await fetch(`${base}/worship.mov`, { method: 'DELETE' });
  assert.equal(denied.status, 401);
  const blocked = await fetch(`${base}/worship.mov`, { method: 'DELETE', headers });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /scene background/);
  for (const name of ['worship.mov', 'worship.mp4']) assert.equal(await fs.readFile(path.join(mediaDir, name), 'utf8'), 'synthetic video');
  state.scenes[0].layers[0].mediaBackground = null; await store.save(state);
  const removed = await fetch(`${base}/worship.mov`, { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
  for (const name of ['worship.mov', 'worship.mp4']) await assert.rejects(fs.access(path.join(mediaDir, name)), { code: 'ENOENT' });
  const missing = await fetch(`${base}/worship.mov`, { method: 'DELETE', headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'This media file was already removed.');
});
