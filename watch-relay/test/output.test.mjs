import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWatchRelay } from '../server.mjs';

const pushToken = randomBytes(48).toString('hex'), viewerToken = randomBytes(48).toString('hex');
const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000000,\nsegment-00000000.ts\n';
async function fixture(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-private-output-'));
  const options = { dataDir: directory, pushToken, viewerToken, allowedSlugs: ['live', 'program', 'other'], privateSlugs: ['program', 'other'], ...overrides };
  let relay = await createWatchRelay(options);
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${relay.server.address().port}`;
  const get = (route, headers = {}, method = 'GET') => fetch(base + route, { headers, method });
  const authenticate = async (key = viewerToken, slug = 'program') => {
    const response = await fetch(`${base}/api/output/${slug}/session`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: '{}' });
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const publish = async (slug = 'program') => {
    const route = `/api/push/${slug}`;
    const push = (suffix, method = 'POST', body = '{}') => fetch(base + route + suffix, { method, headers: { Authorization: `Bearer ${pushToken}` }, body });
    const response = await push('/sessions', 'POST', JSON.stringify({ epoch: `private-output-${randomBytes(12).toString('hex')}` }));
    assert.equal(response.status, 201);
    const id = (await response.json()).sessionId;
    assert.equal((await push(`/${id}/segment-00000000.ts`, 'PUT', Buffer.from('actual-segment-bytes'))).status, 201);
    assert.equal((await push(`/${id}/index.m3u8`, 'PUT', playlist)).status, 200);
    return id;
  };
  return { options, directory, get, authenticate, publish,
    get base() { return base; },
    async restart(next = {}) {
      await relay.close(); relay = await createWatchRelay({ ...options, ...next });
      await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${relay.server.address().port}`;
    },
    async close() { await relay.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('private output configuration fails closed without a separate viewer key or valid allowed slug', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-output-invalid-'));
  try {
    for (const key of [undefined, '', 'short', pushToken, 'x'.repeat(257), 'x'.repeat(32) + '\n']) {
      await assert.rejects(createWatchRelay({ dataDir: directory, pushToken, privateSlugs: ['program'], viewerToken: key }), /distinct viewer token/);
    }
    await assert.rejects(createWatchRelay({ dataDir: directory, pushToken, viewerToken, allowedSlugs: ['live'], privateSlugs: ['program'] }), /valid allowed relay slugs/);
    await assert.rejects(createWatchRelay({ dataDir: directory, pushToken, viewerToken, privateSlugs: ['../live'] }), /valid allowed relay slugs/);
    assert.deepEqual(await fs.readdir(directory), [], 'Invalid private configuration cannot silently start as public.');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('clean output shell is secret-free and access exchange is header-only, scoped and Secure by default', async () => {
  const f = await fixture();
  try {
    const page = await f.get('/output/program'), html = await page.text();
    assert.equal(page.status, 200); assert.match(html, /Program output/); assert.doesNotMatch(html, /<header|<footer|<iframe|<video[^>]*\scontrols/);
    assert.ok(!html.includes(viewerToken) && !html.includes(pushToken)); assert.match(page.headers.get('cache-control'), /private, no-store/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal((await f.get('/api/watch/program')).status, 401); assert.equal((await f.get('/watch/program')).status, 401);
    assert.equal((await f.get('/api/output/program/info')).status, 401);
    assert.equal((await f.get('/api/output/program/info', { Authorization: `Bearer ${pushToken}` })).status, 401, 'Publishing key is not a viewer credential.');
    assert.equal((await f.get(`/api/output/program/info?key=${viewerToken}`)).status, 404);
    const info = await f.get('/api/output/program/info', { Authorization: `Bearer ${viewerToken}` });
    assert.deepEqual(await info.json(), { protected: true, slug: 'program', watchUrl: '/output/program', status: 'offline' });
    const { response, cookie } = await f.authenticate();
    assert.equal(response.status, 200); const header = response.headers.get('set-cookie');
    for (const directive of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(header.includes(directive));
    assert.ok(!header.includes(viewerToken) && !header.includes(pushToken));
    assert.ok(Number.isFinite(Date.parse((await response.json()).expiresAt)));
    assert.equal((await f.get('/api/output/program/info', { Cookie: cookie })).status, 200);
    assert.equal((await f.get('/api/output/other/info', { Cookie: cookie })).status, 401, 'A Program session cookie cannot authorize another slug.');
    assert.equal((await f.get('/api/output/live/info', { Authorization: `Bearer ${viewerToken}` })).status, 404, 'Public feeds cannot pass protected-output discovery.');
    assert.equal((await f.get('/watch/live')).status, 200); assert.deepEqual(await (await f.get('/api/watch/live')).json(), { status: 'offline' });
  } finally { await f.close(); }
});

test('every protected manifest, segment and legacy Watch status is guarded, including HEAD; public Watch is unchanged', async () => {
  const f = await fixture();
  try {
    const id = await f.publish(), publicId = await f.publish('live');
    const { cookie } = await f.authenticate();
    for (const route of ['/api/watch/program', '/api/output/program/info', `/hls/program/${id}/index.m3u8`, `/hls/program/${id}/segment-00000000.ts`]) {
      for (const method of ['GET', 'HEAD']) assert.equal((await f.get(route, {}, method)).status, 401, `${method} ${route} must not expose media/status.`);
      const response = await f.get(route, { Cookie: cookie });
      assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private, no-store/); assert.match(response.headers.get('vary'), /Cookie/);
    }
    assert.equal(await (await f.get(`/hls/program/${id}/segment-00000000.ts`, { Cookie: cookie })).text(), 'actual-segment-bytes');
    assert.equal(await (await f.get(`/hls/live/${publicId}/segment-00000000.ts`)).text(), 'actual-segment-bytes');
    assert.match((await f.get(`/hls/live/${publicId}/segment-00000000.ts`)).headers.get('cache-control'), /public/);
    assert.equal((await f.get('/api/watch/program', { Cookie: `${cookie.slice(0, -1)}${cookie.endsWith('0') ? '1' : '0'}` })).status, 401);
    assert.equal((await f.get('/api/watch/program', { Cookie: `${cookie}; ${cookie}` })).status, 401, 'Ambiguous duplicate session cookies are rejected.');
    const deniedPush = await fetch(`${f.base}/api/push/program/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${viewerToken}` }, body: '{"epoch":"viewer-cannot-publish"}' });
    assert.equal(deniedPush.status, 401);
  } finally { await f.close(); }
});

test('viewer cookie expires without weakening the relay and key rotation revokes old browser sessions', async () => {
  let time = 1000000;
  const f = await fixture({ now: () => time, outputSessionMs: 1000 });
  try {
    const { cookie } = await f.authenticate();
    assert.equal((await f.get('/api/output/program/info', { Cookie: cookie })).status, 200);
    time += 1001;
    assert.equal((await f.get('/api/output/program/info', { Cookie: cookie })).status, 401);
    const fresh = await f.authenticate(); assert.equal(fresh.response.status, 200);
    const rotated = randomBytes(48).toString('hex');
    await f.restart({ viewerToken: rotated });
    assert.equal((await f.get('/api/output/program/info', { Cookie: fresh.cookie })).status, 401);
    assert.equal((await f.get('/api/output/program/info', { Authorization: `Bearer ${viewerToken}` })).status, 401);
    assert.equal((await f.authenticate(viewerToken)).response.status, 401);
    assert.equal((await f.authenticate(rotated)).response.status, 200);
    assert.equal((await f.get('/api/output/program/info', { Authorization: `Bearer ${rotated}` })).status, 200);
    assert.equal((await f.get('/watch/live')).status, 200);
  } finally { await f.close(); }
});
