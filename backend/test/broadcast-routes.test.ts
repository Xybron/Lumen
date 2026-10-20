import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

test('Broadcast routes protect stream keys and never mutate production on configuration or rejected starts', { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-routes-'));
  const previous = process.env.LUMEN_DATA_DIR; process.env.LUMEN_DATA_DIR = dir;
  const { initDb } = await import('../src/db.js'); const db = initDb();
  const { createUser, login, setGrant } = await import('../src/auth.js');
  const { createProduction } = await import('../src/production.js');
  const { createMediaRouter } = await import('../src/media-routes.js');
  const service = await createProduction({ backendUrl: 'http://127.0.0.1:1', development: false }, undefined, { watchRelay: null });
  const app = express(); app.use(express.json()); app.use('/api', service.router);
  app.use('/api', createMediaRouter({} as Parameters<typeof createMediaRouter>[0]));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); instance.once('error', reject); });
  t.after(async () => {
    await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close();
    if (previous === undefined) delete process.env.LUMEN_DATA_DIR; else process.env.LUMEN_DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  createUser('broadcast-admin', 'Admin', 'test-password', true);
  const author = createUser('broadcast-author', 'Operator', 'test-password'); setGrant(author.id, '*', 'author');
  createUser('broadcast-reader', 'Reader', 'test-password');
  const cookie = (username: string) => `lumen_session=${login(username, 'test-password')!.sessionId}`;
  const adminCookie = cookie('broadcast-admin'), authorCookie = cookie('broadcast-author'), readerCookie = cookie('broadcast-reader');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (endpoint: string, method = 'GET', body?: unknown, session = adminCookie) => fetch(`${base}${endpoint}`, { method, headers: { ...(session ? { Cookie: session } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const original = await fs.readFile(path.join(dir, 'production.json'));
  const snapshot = async () => await (await request('/studio/broadcast')).json();
  await t.test('anonymous users and non-Studio viewers cannot read or control Broadcast', async () => {
    assert.equal((await request('/studio/broadcast', 'GET', undefined, '')).status, 401);
    assert.equal((await request('/studio/broadcast', 'GET', undefined, readerCookie)).status, 403);
    assert.equal((await request('/studio/broadcast', 'GET', undefined, authorCookie)).status, 200);
    for (const endpoint of ['/studio/broadcast/start', '/studio/broadcast/stop', '/studio/broadcast/destinations/watch/retry']) assert.equal((await request(endpoint, 'POST', {}, '')).status, 401);
  });
  await t.test('only administrators configure secrets, responses are redacted and private files are restricted', async () => {
    const settings = { profile: '720p', recordOnStart: true, destinations: [{ id: 'youtube', enabled: true, streamKey: 'fixture-never-publish-this-private-key' }] };
    const denied = await request('/studio/broadcast/config', 'PUT', settings, authorCookie); assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'Only an administrator can change stream destinations and stream keys.');
    const response = await request('/studio/broadcast/config', 'PUT', settings); assert.equal(response.status, 200);
    const body = await response.text(); assert.doesNotMatch(body, /fixture-never-publish|streamKey|"key"/);
    const config = JSON.parse(body).config; assert.equal(config.destinations.find((item: { id: string }) => item.id === 'youtube').configured, true);
    const privateFile = path.join(dir, 'broadcast', 'broadcast-private.json');
    assert.equal((await fs.stat(privateFile)).mode & 0o777, 0o600);
    assert.match(await fs.readFile(privateFile, 'utf8'), /fixture-never-publish-this-private-key/);
  });
  await t.test('arbitrary URLs, unknown destinations and malformed start payloads are rejected without echoing keys', async () => {
    for (const settings of [{ url: 'http://127.0.0.1/private' }, { destinations: [{ id: 'custom', enabled: true, streamKey: 'private' }] }, { destinations: [{ id: 'youtube', enabled: true, streamKey: 'https://evil.invalid/key' }] }]) {
      const response = await request('/studio/broadcast/config', 'PUT', settings); assert.equal(response.status, 422); assert.doesNotMatch(await response.text(), /evil\.invalid|127\.0\.0\.1|"private"/);
    }
    assert.equal((await request('/studio/broadcast/start', 'POST', { record: true, url: 'https://evil.invalid' })).status, 422);
    const response = await request('/studio/broadcast/start', 'POST', { record: false }); assert.equal(response.status, 409, 'A prepared Program is required, so the encoder/network must not start.');
    assert.equal((await snapshot()).session, null);
  });
  await t.test('unconfigured independent Watch fails preflight and engine-only ingest is not a public upload API', async () => {
    assert.equal((await request('/studio/broadcast/config', 'PUT', { destinations: [{ id: 'youtube', enabled: false }], watch: { enabled: true } })).status, 200);
    const preflight = await (await request('/studio/broadcast/preflight')).json();
    assert.equal(preflight.ready, false); assert.equal(preflight.checks.find((item: { id: string }) => item.id === 'watch').ok, false);
    assert.equal((await request('/studio/engine/broadcast/forged/chunks/0', 'PUT', { bytes: 'not-media' })).status, 401);
    assert.equal((await request('/studio/engine/broadcast/forged/error', 'POST', { error: 'forged' })).status, 401);
    assert.equal((await request('/studio/broadcast/stop', 'POST', { stopRecording: false })).status, 200);
    const status = await (await request('/studio/status')).json(); assert.equal(status.state, 'offline'); assert.equal(status.recording, null);
  });
  await t.test('legacy simulated streaming cannot be started by an old controller', async () => {
    for (const action of ['target', 'start', 'stop']) {
      const response = await request(`/media/stream/old_destination/${action}`, 'POST', {}); assert.equal(response.status, 410);
      const message = (await response.json()).error; assert.match(message, /^Use Go Live in Studio/); assert.doesNotMatch(message, /\bbroadcast\b/i);
    }
    const state = await (await request('/media/stream/status')).json(); assert.equal(state.enabled, false); assert.deepEqual(state.egress, []);
  });
  assert.deepEqual(await fs.readFile(path.join(dir, 'production.json')), original, 'Scenes, sources, Preview, Program and Main audio settings are untouched.');
});
