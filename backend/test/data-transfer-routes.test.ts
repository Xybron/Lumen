import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import express from 'express';

test('aborted binary archive uploads release the transfer gate and leave the station unchanged', { timeout: 20_000 }, async t => {
  // Load every station-path consumer only after redirecting it to this fixture.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-transfer-routes-'));
  const previous = process.env.LUMEN_DATA_DIR;
  process.env.LUMEN_DATA_DIR = dir;
  let server: http.Server | undefined;
  let transfer: { close(): Promise<void> } | undefined;
  let identity: { close(): void } | undefined;
  let library: { close(): void } | undefined;
  const pending = new Set<http.ClientRequest>();
  t.after(async () => {
    for (const request of pending) request.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    await transfer?.close();
    library?.close(); identity?.close();
    if (previous === undefined) delete process.env.LUMEN_DATA_DIR;
    else process.env.LUMEN_DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const { DATA_DIR } = await import('../src/paths.js');
  assert.equal(DATA_DIR, dir, 'This test must never open the real station.');
  const { initDb } = await import('../src/db.js'); identity = initDb();
  const { login, createUser } = await import('../src/auth.js');
  const { WorshipLibrary } = await import('../src/worship-library.js');
  const { ContentSchema } = await import('../src/schema.js');
  const { createDataTransferRouter } = await import('../src/data-transfer-routes.js');
  const worship = new WorshipLibrary(path.join(dir, 'worship.db')); library = worship;
  const content = ContentSchema.parse({ version: 2, updatedAt: '2026-01-01T00:00:00.000Z', settings: {}, playlists: [], channels: [], sources: [], destinations: [], routes: [], music: {}, program: {} });
  const original = JSON.stringify(content);
  await fs.writeFile(path.join(dir, 'content.json'), original);
  const notifications: unknown[] = [];
  const handler = createDataTransferRouter(worship, dir, { injectRemote: value => {
    notifications.push(value);
    throw new Error('Synthetic notification failure after persistence');
  } } as Parameters<typeof createDataTransferRouter>[2]);
  transfer = handler;
  const app = express(); app.use(express.json()); app.use('/api', handler.router);
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/data-transfer`;
  const cookie = `lumen_session=${login('admin', 'admin')!.sessionId}`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-Lumen-Filename': encodeURIComponent('Église library.lumen') };
  const catalog = () => fetch(`${base}/catalog`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2000) });
  async function expectCatalog(status: number) {
    const deadline = Date.now() + 3000;
    let actual = 0;
    do {
      const response = await catalog(); actual = response.status; await response.arrayBuffer();
      if (actual === status) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    } while (Date.now() < deadline);
    assert.equal(actual, status, 'The transfer gate did not reach the expected state.');
  }

  // Keep the request incomplete, observe the global gate, then disconnect as a
  // browser AbortController does when its upload dialog closes mid-transfer.
  const request = http.request(`${base}/preview`, { method: 'POST', headers: { ...headers, 'Content-Length': String(8 * 1024 * 1024) } });
  pending.add(request); request.on('error', () => {});
  request.on('response', response => response.resume());
  request.write(Buffer.alloc(32 * 1024, 0x61));
  await expectCatalog(409);
  request.destroy(); pending.delete(request);
  await expectCatalog(200);
  assert.equal(await fs.readFile(path.join(dir, 'content.json'), 'utf8'), original);
  assert.equal((worship.db.prepare('SELECT COUNT(*) AS n FROM songs').get() as { n: number }).n, 0);
  assert.equal((await fs.readdir(dir)).includes('backups'), false);

  const bytes = gzipSync(JSON.stringify({ format: 'lumen', version: 1, createdAt: '2026-01-02T00:00:00.000Z', payload: {
    bibles: [], songs: [{ id: 'cancel_retry_song', title: 'A synthetic upload retry', author: 'Fixture', copyright: 'Synthetic fixture', sections: [{ id: 'verse', label: 'Verse', text: 'A test archive remains usable after a cancelled upload.' }] }], presentations: [], media: [], settings: null,
  } }));
  const upload = (body: Buffer, filename = headers['X-Lumen-Filename']) => fetch(`${base}/preview`, { method: 'POST', headers: { ...headers, 'X-Lumen-Filename': filename }, body, signal: AbortSignal.timeout(3000) });
  const wrongName = await upload(bytes, 'not-an-archive.txt'); assert.equal(wrongName.status, 422); await wrongName.arrayBuffer();
  const malformedName = await upload(bytes, '%E0%A4%A'); assert.equal(malformedName.status, 422); await malformedName.arrayBuffer();
  const encoded = await fetch(`${base}/preview`, { method: 'POST', headers: { ...headers, 'Content-Encoding': 'gzip' }, body: gzipSync(bytes), signal: AbortSignal.timeout(3000) });
  assert.equal(encoded.status, 415); await encoded.arrayBuffer();
  const invalid = await upload(Buffer.from('not a gzip archive')); assert.equal(invalid.status, 422); await invalid.arrayBuffer();
  const ready = await upload(bytes); assert.equal(ready.status, 200, await ready.clone().text());
  const preview = await ready.json(); assert.equal(preview.catalog.songs.length, 1);
  const imported = await fetch(`${base}/import`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token, selection: { bibles: [], songs: ['cancel_retry_song'], presentations: [], media: [], settings: false } }), signal: AbortSignal.timeout(3000) });
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal((await imported.json()).imported.songs, 1);
  assert.equal(worship.song('cancel_retry_song').title, 'A synthetic upload retry');
  assert.deepEqual(notifications, [{ t: 'library-updated' }]);
  await expectCatalog(200);

  const selected = { bibles: [], songs: ['cancel_retry_song'], presentations: [], media: [], settings: false };
  const exported = await fetch(`${base}/export`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(selected) });
  assert.equal(exported.status, 200, await exported.clone().text());
  const ticket = await exported.json(); assert.match(ticket.filename, /\.lumen$/); assert.match(ticket.downloadUrl, /^\/api\/data-transfer\/download\//);
  const downloadUrl = new URL(ticket.downloadUrl, base).toString();
  createUser('other-transfer-admin', 'Another operator', 'test-password', true);
  const otherCookie = `lumen_session=${login('other-transfer-admin', 'test-password')!.sessionId}`;
  const denied = await fetch(downloadUrl, { headers: { Cookie: otherCookie } }); assert.equal(denied.status, 410); await denied.arrayBuffer();
  const download = await fetch(downloadUrl, { headers: { Cookie: cookie } }); assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition')!, /attachment/); assert.equal(download.headers.get('cache-control'), 'private, no-store');
  const archive = Buffer.from(await download.arrayBuffer()); assert.equal(archive.subarray(0, 8).toString(), 'LUMEN2\r\n');
  const replay = await fetch(downloadUrl, { headers: { Cookie: cookie } }); assert.equal(replay.status, 410); await replay.arrayBuffer();
  const v2 = await upload(archive); assert.equal(v2.status, 200, await v2.clone().text());
  const v2Preview = await v2.json(); assert.equal(v2Preview.catalog.songs[0].exists, true);
  const discarded = await fetch(`${base}/preview/${v2Preview.token}`, { method: 'DELETE', headers: { Cookie: cookie } }); assert.equal(discarded.status, 204);
});
