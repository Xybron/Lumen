import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createWatchRelay, readTenantRegistry } from '../server.mjs';

const idA = '11111111-1111-4111-8111-111111111111', idB = '22222222-2222-4222-8222-222222222222';
const secret = () => randomBytes(48).toString('hex');
const makeTenant = workspaceId => ({ workspaceId, pushToken: secret(), viewerToken: secret(), allowedSlugs: ['live', 'program'], privateSlugs: ['program'] });
const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000000,\nsegment-00000000.ts\n';
async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-relay-tenants-'));
  const a = makeTenant(idA), b = makeTenant(idB), globalToken = secret();
  let tenants = [a, b], relay, base;
  async function start() { relay = await createWatchRelay({ dataDir: directory, pushToken: globalToken, viewerToken: globalToken, tenants, ...options }); await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${relay.server.address().port}`; }
  await start();
  const get = (route, headers = {}, method = 'GET') => fetch(base + route, { headers, method });
  const push = (tenant, slug, suffix, body = '{}', method = 'POST', token = tenant.pushToken) => fetch(`${base}/api/push/${tenant.workspaceId}/${slug}/${suffix}`, { method, headers: { Authorization: `Bearer ${token}` }, body });
  const begin = async (tenant, slug = 'program', epoch = `tenant-${secret().slice(0, 20)}`) => { const response = await push(tenant, slug, 'sessions', JSON.stringify({ epoch })); assert.equal(response.status, 201); return (await response.json()).sessionId; };
  const publish = async (tenant, slug = 'program', bytes = tenant.workspaceId) => { const id = await begin(tenant, slug); assert.equal((await push(tenant, slug, `${id}/segment-00000000.ts`, bytes, 'PUT')).status, 201); assert.equal((await push(tenant, slug, `${id}/index.m3u8`, playlist, 'PUT')).status, 200); return id; };
  const authenticate = async (tenant, token = tenant.viewerToken) => { const response = await fetch(`${base}/api/output/${tenant.workspaceId}/program/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' }); return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] }; };
  return { a, b, directory, globalToken, get, push, begin, publish, authenticate, get base() { return base; },
    async restart(next = tenants) { await relay.close(); tenants = next; await start(); },
    async close() { await relay.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('tenant registry rejects duplicate IDs/keys, unknown fields, invalid scopes and weak/private credentials before touching disk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-invalid-tenants-'));
  const a = makeTenant(idA), b = makeTenant(idB);
  try {
    for (const tenants of [[], [a, { ...b, workspaceId: idA }], [a, { ...b, pushToken: a.pushToken }], [a, { ...b, viewerToken: a.pushToken }],
      [{ ...a, workspaceId: idA.toUpperCase() + 'x' }], [{ ...a, workspaceId: '../other' }], [{ ...a, extra: true }], [{ ...a, allowedSlugs: undefined }],
      [{ ...a, allowedSlugs: ['live', 'live'] }], [{ ...a, privateSlugs: ['not-allowed'] }], [{ ...a, pushToken: 'short' }], [{ ...a, viewerToken: a.pushToken }], [{ ...a, viewerToken: undefined }]]) {
      await assert.rejects(createWatchRelay({ dataDir: directory, tenants }));
    }
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('tenant settings file is bounded, owner-only, non-symlink versioned JSON and never falls back to globals', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-private-tenants-')), filename = path.join(directory, 'tenants.json');
  const tenant = makeTenant(idA), contents = JSON.stringify({ version: 1, tenants: [tenant] });
  try {
    await fs.writeFile(filename, contents, { mode: 0o600 });
    assert.deepEqual(await readTenantRegistry(filename), [tenant]);
    await fs.chmod(filename, 0o644); await assert.rejects(readTenantRegistry(filename), /owner-only/); await fs.chmod(filename, 0o600);
    const link = path.join(directory, 'link.json'); await fs.symlink(filename, link); await assert.rejects(readTenantRegistry(link), /symlinks/);
    await assert.rejects(readTenantRegistry('relative.json'), /absolute/); await assert.rejects(readTenantRegistry(''), /absolute/);
    for (const text of ['{bad', '{"version":2,"tenants":[]}', '{"version":1,"tenants":[],"extra":true}', 'x'.repeat(1024 * 1024 + 1)]) { await fs.writeFile(filename, text); await assert.rejects(readTenantRegistry(filename)); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('two workspaces use the same slugs without sharing credentials, media, cookies, status or publishing authority', async () => {
  const f = await fixture();
  try {
    const aId = await f.publish(f.a), bId = await f.publish(f.b), aLive = await f.publish(f.a, 'live'), bLive = await f.publish(f.b, 'live');
    assert.notEqual(aId, bId);
    assert.equal((await f.push(f.b, 'program', 'sessions', '{"epoch":"cross-workspace-denied"}', 'POST', f.a.pushToken)).status, 401);
    assert.equal((await f.push(f.a, 'program', 'sessions', '{"epoch":"global-key-denied"}', 'POST', f.globalToken)).status, 401);
    const { cookie: aCookie } = await f.authenticate(f.a), { cookie: bCookie } = await f.authenticate(f.b);
    assert.notEqual(aCookie.split('=')[0], bCookie.split('=')[0]);
    for (const method of ['GET', 'HEAD']) for (const route of [`/api/watch/${idB}/program`, `/api/output/${idB}/program/info`, `/hls/${idB}/program/${bId}/index.m3u8`, `/hls/${idB}/program/${bId}/segment-00000000.ts`]) {
      assert.equal((await f.get(route, { Authorization: `Bearer ${f.a.viewerToken}` }, method)).status, 401);
      assert.equal((await f.get(route, { Cookie: aCookie }, method)).status, 401);
      assert.equal((await f.get(route, { Cookie: aCookie.replace(idA, idB) }, method)).status, 401, 'Changing cookie name cannot reuse a signature in another workspace.');
      assert.equal((await f.get(route, { Cookie: bCookie }, method)).status, 200);
    }
    assert.equal((await f.authenticate(f.b, f.a.viewerToken)).response.status, 401);
    assert.equal((await f.authenticate(f.a, f.a.pushToken)).response.status, 401);
    const info = await (await f.get(`/api/output/${idA}/program/info`, { Cookie: aCookie })).json();
    assert.deepEqual(info, { protected: true, workspaceId: idA, slug: 'program', watchUrl: `/output/${idA}/program`, status: 'live' });
    assert.equal(await (await f.get(`/hls/${idA}/program/${aId}/segment-00000000.ts`, { Cookie: aCookie })).text(), idA);
    assert.equal(await (await f.get(`/hls/${idB}/program/${bId}/segment-00000000.ts`, { Cookie: bCookie })).text(), idB);
    assert.equal((await f.get(`/hls/${idB}/program/${aId}/index.m3u8`, { Cookie: bCookie })).status, 410);
    for (const [tenant, id] of [[f.a, aLive], [f.b, bLive]]) {
      assert.equal((await f.get(`/watch/${tenant.workspaceId}/live`)).status, 200);
      assert.deepEqual(await (await f.get(`/api/watch/${tenant.workspaceId}/live`)).json(), { status: 'live', playlistUrl: `/hls/${tenant.workspaceId}/live/${id}/index.m3u8` });
      assert.equal(await (await f.get(`/hls/${tenant.workspaceId}/live/${id}/segment-00000000.ts`)).text(), tenant.workspaceId);
    }
    const privatePage = await (await f.get(`/output/${idA}/program`)).text(); assert.ok(!privatePage.includes(f.a.viewerToken) && !privatePage.includes(f.a.pushToken));
    for (const file of [path.join(f.directory, idA, 'program', 'session.json'), path.join(f.directory, idB, 'program', 'session.json')]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test('tenant mode rejects legacy paths, unknown or malformed namespaces and unregistered slugs; assets stay shared', async () => {
  const f = await fixture();
  try {
    for (const route of ['/watch/live', '/output/program', '/api/watch/live', '/api/output/program/info', '/api/push/live/sessions', '/hls/program/anything/index.m3u8',
      '/watch/33333333-3333-4333-8333-333333333333/live', `/watch/${idA}/missing`, `/api/push/${idA}/missing/sessions`, `/watch/${idA}//live`, `/watch/${idA}/live/`]) assert.equal((await f.get(route)).status, 404, route);
    for (const route of [`/watch/${idA}/../${idA}/live`, `/watch/%31${idA.slice(1)}/live`, `/watch/${idA}%2flive`, `/watch/${idA}\\live`]) {
      const status = await new Promise((resolve, reject) => { http.get(f.base + '/', { path: route }, response => { response.resume(); resolve(response.statusCode); }).once('error', reject); }); assert.equal(status, 404, route);
    }
    assert.equal((await f.get('/assets/watch.js')).status, 200); assert.equal((await f.get('/assets/output.js')).status, 200);
    assert.equal((await fetch(f.base + '/api/push/program/sessions', { method: 'POST', headers: { Authorization: `Bearer ${f.globalToken}` }, body: '{"epoch":"legacy-route-denied"}' })).status, 404);
  } finally { await f.close(); }
});

test('tenant restarts retain separate replay fences and rotating one viewer key revokes only its own workspace', async () => {
  const f = await fixture();
  try {
    const epoch = 'same-epoch-two-workspaces'; await f.begin(f.a, 'program', epoch); await f.begin(f.b, 'program', epoch);
    const { cookie: aCookie } = await f.authenticate(f.a), { cookie: bCookie } = await f.authenticate(f.b);
    const rotated = { ...f.a, viewerToken: secret() }; await f.restart([rotated, f.b]);
    assert.deepEqual(await (await f.get(`/api/watch/${idA}/program`, { Authorization: `Bearer ${rotated.viewerToken}` })).json(), { status: 'offline' });
    assert.equal((await f.push(f.a, 'program', 'sessions', JSON.stringify({ epoch }))).status, 409);
    assert.equal((await f.push(f.b, 'program', 'sessions', JSON.stringify({ epoch }))).status, 409);
    assert.equal((await f.get(`/api/output/${idA}/program/info`, { Cookie: aCookie })).status, 401);
    assert.equal((await f.get(`/api/output/${idB}/program/info`, { Cookie: bCookie })).status, 200);
    assert.equal((await f.authenticate(f.a)).response.status, 401); assert.equal((await f.authenticate(rotated)).response.status, 200);
    assert.equal((await f.authenticate(f.b)).response.status, 200);
  } finally { await f.close(); }
});

test('workspace stream quotas are separate so one workspace cannot consume another workspace allocation', async () => {
  const f = await fixture({ maxStreamsPerTenant: 1 });
  try {
    await f.begin(f.a, 'live'); assert.equal((await f.push(f.a, 'program', 'sessions', '{"epoch":"tenant-over-quota"}')).status, 429);
    await f.begin(f.b, 'live');
  } finally { await f.close(); }
});
