import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWatchRelay, parsePlaylist } from '../server.mjs';

const token = randomBytes(48).toString('hex');
const playlist = (sequence = 0, names = [`segment-${String(sequence).padStart(8, '0')}.ts`]) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n${names.map(name => `#EXTINF:2.000000,\n${name}\n`).join('')}`;
async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-relay-unit-'));
  const relay = await createWatchRelay({ dataDir: directory, pushToken: token, allowedSlugs: ['sunday'], ...options });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const push = async (route, method = 'POST', body = '{}', authorization = token) => fetch(`${base}/api/push/sunday/${route}`, { method, headers: { Authorization: `Bearer ${authorization}` }, body });
  const begin = async (epoch = 'fixture-epoch-0001') => { const response = await push('sessions', 'POST', JSON.stringify({ epoch })); assert.ok(response.ok, await response.clone().text()); return (await response.json()).sessionId; };
  return { directory, relay, base, push, begin, async close() { await relay.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('public surface is isolated, scripts are local, authorization is header-only and secrets never reach the viewer', async () => {
  const f = await fixture();
  try {
    for (const route of ['/api/studio', '/api/clips', '/api/auth', '/session.json', '/watch/unknown', '/assets/../server.mjs', '/hls/sunday/../../session.json']) assert.equal((await fetch(f.base + route)).status, 404);
    const page = await fetch(`${f.base}/watch/sunday`), html = await page.text(); assert.equal(page.status, 200); assert.match(html, /<video /); assert.doesNotMatch(html, /youtube|iframe|https?:\/\//i); assert.ok(!html.includes(token));
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const script = await fetch(`${f.base}/assets/hls.min.js`); assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/); assert.ok((await script.text()).length > 100000);
    assert.equal((await f.push('sessions', 'POST', '{"epoch":"fixture-epoch-0001"}', 'wrong')).status, 401);
    assert.equal((await fetch(`${f.base}/api/push/sunday/sessions?token=${token}`, { method: 'POST', body: '{"epoch":"fixture-epoch-0001"}' })).status, 404);
    assert.deepEqual(await (await fetch(`${f.base}/api/watch/sunday`)).json(), { status: 'offline' });
  } finally { await f.close(); }
});

test('segments precede atomic manifests, sessions fence old uploads, media is immutable and stale frames become Offline', async () => {
  let time = 1000; const f = await fixture({ now: () => time, staleMs: 100, offlineTtlMs: 200 });
  try {
    const first = await f.begin(); assert.equal((await (await fetch(`${f.base}/api/watch/sunday`)).json()).status, 'connecting');
    assert.equal((await f.push(`${first}/index.m3u8`, 'PUT', playlist())).status, 409, 'Missing media must never be publicly referenced');
    assert.equal((await f.push(`${first}/segment-00000000.ts`, 'PUT', Buffer.from('real-media-placeholder'))).status, 201);
    assert.equal((await f.push(`${first}/index.m3u8`, 'PUT', playlist())).status, 200);
    const status = await (await fetch(`${f.base}/api/watch/sunday`)).json(); assert.equal(status.status, 'live');
    const manifest = await fetch(f.base + status.playlistUrl); assert.equal(await manifest.text(), playlist()); assert.match(manifest.headers.get('cache-control'), /no-store/); assert.match(manifest.headers.get('content-type'), /mpegurl/);
    const media = await fetch(`${f.base}/hls/sunday/${first}/segment-00000000.ts`); assert.equal(await media.text(), 'real-media-placeholder'); assert.equal(media.headers.get('content-type'), 'video/mp2t');
    assert.equal((await f.push(`${first}/segment-00000000.ts`, 'PUT', 'changed')).status, 409);
    time += 101;
    assert.equal((await (await fetch(`${f.base}/api/watch/sunday`)).json()).status, 'offline');
    await f.push(`${first}/index.m3u8`, 'PUT', playlist()); assert.equal((await (await fetch(`${f.base}/api/watch/sunday`)).json()).status, 'offline', 'Repeating a frozen playlist cannot pretend fresh video');
    const next = await f.begin('fixture-epoch-0002'); assert.notEqual(first, next);
    assert.equal((await f.push(`${first}/segment-00000001.ts`, 'PUT', 'old')).status, 409);
    assert.equal((await f.push('sessions', 'POST', '{"epoch":"fixture-epoch-0001"}')).status, 409);
    assert.equal((await fetch(f.base + status.playlistUrl)).status, 410);
    assert.equal((await f.push(`${next}/end`)).status, 200); time += 201; await f.relay.cleanup();
    assert.equal((await (await fetch(`${f.base}/api/watch/sunday`)).json()).status, 'offline');
    assert.deepEqual((await fs.readdir(path.join(f.directory, 'sunday'))), ['session.json']);
  } finally { await f.close(); }
});

test('strict paths, playlist URLs/tags, upload sizes and bounded storage reject unsafe or oversized pushes', async () => {
  const f = await fixture({ maxSegmentBytes: 24, maxWindowBytes: 40 });
  try {
    const session = await f.begin();
    for (const filename of ['other.ts', 'segment-00000000.ts%2fsecret', 'index.m3u8%00']) assert.equal((await f.push(`${session}/${filename}`, 'PUT', 'x')).status, 404);
    assert.equal((await f.push(`${session}/segment-00000000.ts`, 'PUT', Buffer.alloc(25))).status, 413);
    assert.equal((await f.push(`${session}/segment-00000000.ts`, 'PUT', Buffer.alloc(24))).status, 201);
    assert.equal((await f.push(`${session}/segment-00000001.ts`, 'PUT', Buffer.alloc(24))).status, 413);
    for (const text of [playlist().replace('segment-00000000.ts', 'https://internal.invalid/a.ts'), playlist().replace('segment-00000000.ts', '../secret.ts'), playlist().replace('#EXT-X-VERSION:3', '#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1"'), playlist().replace('#EXT-X-VERSION:3', '#EXT-X-MAP:URI="local.mp4"'), playlist(0, Array.from({ length: 13 }, (_, i) => `segment-${String(i).padStart(8, '0')}.ts`))]) assert.equal((await f.push(`${session}/index.m3u8`, 'PUT', text)).status, 400);
    assert.throws(() => parsePlaylist(Buffer.from('#EXTM3U\n#EXTINF:2,\nsegment-00000000.ts\n')));
    assert.equal((await f.push(`${session}/index.m3u8`, 'PUT', playlist())).status, 200);
    assert.ok((await fs.readdir(path.join(f.directory, 'sunday', session))).every(name => name === 'index.m3u8' || /^segment-\d{8}\.ts$/.test(name)), 'No temp or arbitrary files remain');
  } finally { await f.close(); }
});

test('relay restart is Offline and retains epoch replay fencing', async () => {
  const f = await fixture(); const session = await f.begin();
  await f.push(`${session}/segment-00000000.ts`, 'PUT', 'bytes'); await f.push(`${session}/index.m3u8`, 'PUT', playlist()); await f.relay.close();
  const relay = await createWatchRelay({ dataDir: f.directory, pushToken: token, allowedSlugs: ['sunday'] }); await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  try { assert.equal((await (await fetch(`${base}/api/watch/sunday`)).json()).status, 'offline'); assert.equal((await fetch(`${base}/api/push/sunday/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{"epoch":"fixture-epoch-0001"}' })).status, 409); }
  finally { await relay.close(); await fs.rm(f.directory, { recursive: true, force: true }); }
});
