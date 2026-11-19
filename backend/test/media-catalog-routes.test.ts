import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

test('Media routes enforce author access and legacy deletion cannot bypass presentation usage', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-media-catalog-http-'));
  const previous = process.env.LUMEN_DATA_DIR; process.env.LUMEN_DATA_DIR = dir;
  let server: http.Server | undefined, identity: { close(): void } | undefined, clips: { close(): Promise<void> } | undefined;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await clips?.close(); identity?.close();
    if (previous === undefined) delete process.env.LUMEN_DATA_DIR; else process.env.LUMEN_DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { DATA_DIR, MEDIA_DIR } = await import('../src/paths.js'); assert.equal(DATA_DIR, dir, 'Only use the temporary station.');
  const { initDb } = await import('../src/db.js'); identity = initDb();
  const { login, createUser, setGrant } = await import('../src/auth.js');
  const { ContentSchema } = await import('../src/schema.js');
  const { ProductionStore } = await import('../src/production-store.js');
  const { RecordingStore } = await import('../src/production-recordings.js');
  const { createClips } = await import('../src/clips.js');
  const { MediaCatalog, createMediaCatalogRouter } = await import('../src/media-catalog.js');
  const { createMediaDeleteRouter } = await import('../src/media-delete-routes.js');
  const store = new ProductionStore(dir); await store.init();
  const recordings = new RecordingStore(path.join(dir, 'recordings'), () => {}); await recordings.init();
  const clipService = await createClips({ dir: path.join(dir, 'clips'), recordings, isLive: () => false }); clips = clipService;
  const catalog = new MediaCatalog(store, clipService.transfer);
  const app = express(); app.use(express.json()); app.use('/api', createMediaCatalogRouter(catalog)); app.use('/api', createMediaDeleteRouter(catalog));
  server = http.createServer(app); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const admin = { Cookie: `lumen_session=${login('admin', 'admin')!.sessionId}`, 'Content-Type': 'application/json' };
  const viewer = createUser('media-viewer', 'Viewer', 'test-password')!; setGrant(viewer.id, '*', 'viewer');
  const limited = { Cookie: `lumen_session=${login('media-viewer', 'test-password')!.sessionId}`, 'Content-Type': 'application/json' };
  for (const sub of ['backgrounds', 'thumbnails', 'music']) await fs.mkdir(path.join(MEDIA_DIR, sub), { recursive: true });
  for (const name of ['shared.png', 'free.png']) await fs.writeFile(path.join(MEDIA_DIR, 'backgrounds', name), 'original');
  const content = ContentSchema.parse({ version: 2, updatedAt: new Date().toISOString(), settings: {}, music: {},
    playlists: [{ id: 'deck', name: 'Sunday', items: [{ id: 'slide', type: 'image', title: 'Welcome', background: { kind: 'image', src: 'media/backgrounds/shared.png' } }] }],
    channels: [{ id: 'channel', name: 'Sunday', playlistId: 'deck', kind: 'presentation' }],
  });
  await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify(content));
  assert.equal((await fetch(`${base}/media-library`)).status, 401);
  assert.equal((await fetch(`${base}/media-library`, { headers: limited })).status, 403);
  assert.equal((await fetch(`${base}/media-library/delete`, { method: 'POST', headers: limited, body: JSON.stringify({ ids: ['library:free.png'] }) })).status, 403);
  assert.equal((await fetch(`${base}/media/backgrounds/free.png`, { method: 'DELETE', headers: limited })).status, 403);
  const listed = await (await fetch(`${base}/media-library`, { headers: admin })).json();
  assert.equal(listed.assets.find((a: { id: string }) => a.id === 'library:shared.png').usage[0].type, 'presentation');
  const renamed = await fetch(`${base}/media-library/${encodeURIComponent('library:shared.png')}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ displayName: 'Welcome image' }) });
  assert.equal(renamed.status, 200); assert.equal((await renamed.json()).displayName, 'Welcome image');
  const legacy = await fetch(`${base}/media/backgrounds/shared.png`, { method: 'DELETE', headers: admin });
  assert.equal(legacy.status, 409); assert.equal((await legacy.json()).usage[0].type, 'presentation');
  const result = await (await fetch(`${base}/media-library/delete`, { method: 'POST', headers: admin, body: JSON.stringify({ ids: ['library:shared.png', 'library:free.png'] }) })).json();
  assert.deepEqual(result.deleted, ['library:free.png']); assert.equal(result.blocked[0].id, 'library:shared.png');
  assert.equal((await fetch(`${base}/media-library/delete`, { method: 'POST', headers: admin, body: JSON.stringify({ ids: ['library:../outside.png'] }) })).status, 422);
  content.playlists[0].items = []; await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify(content));
  assert.equal((await fetch(`${base}/media/backgrounds/shared.png`, { method: 'DELETE', headers: admin })).status, 200);
  await assert.rejects(fs.access(path.join(MEDIA_DIR, 'backgrounds/shared.png')));

  for (const name of ['film.MOV', 'film.mp4']) await fs.writeFile(path.join(MEDIA_DIR, 'backgrounds', name), 'video');
  await fs.writeFile(path.join(MEDIA_DIR, 'music', 'song.mp3'), 'audio');
  content.music.queue = ['media/music/song.mp3'];
  content.sources = [{ id: 'video', kind: 'media', ref: 'media/backgrounds/film.MOV' }];
  await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify(content));
  const allMedia = await (await fetch(`${base}/media-library`, { headers: admin })).json();
  assert.equal(allMedia.assets.find((asset: { id: string }) => asset.id === 'music:song.mp3').kind, 'audio');
  assert.equal(allMedia.assets.find((asset: { id: string }) => asset.id === 'library:film.MOV').playbackPath, 'media/backgrounds/film.mp4');
  assert.ok(!allMedia.assets.some((asset: { id: string }) => asset.id === 'library:film.mp4'));
  for (const media of ['music/song.mp3', 'backgrounds/film.MOV', 'backgrounds/film.mp4']) {
    const response = await fetch(`${base}/media/${media}`, { method: 'DELETE', headers: admin });
    assert.equal(response.status, 409, `${media} cannot bypass the usage guard.`);
    assert.ok((await response.json()).usage.length);
  }
  const guarded = await (await fetch(`${base}/media-library/delete`, { method: 'POST', headers: admin, body: JSON.stringify({ ids: ['library:film.MOV', 'music:song.mp3'] }) })).json();
  assert.equal(guarded.blocked.length, 2); assert.deepEqual(guarded.deleted, []);
  content.music.queue = []; content.sources = []; await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify(content));
  const removed = await (await fetch(`${base}/media-library/delete`, { method: 'POST', headers: admin, body: JSON.stringify({ ids: ['library:film.MOV', 'music:song.mp3'] }) })).json();
  assert.deepEqual(removed.deleted, ['library:film.MOV', 'music:song.mp3']);
});
