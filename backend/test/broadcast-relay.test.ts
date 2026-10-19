import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBroadcastRelay, createWatchRelayFromEnv, isPublicRelayAddress, WatchRelayError } from '../src/broadcast-relay.js';

const token = randomBytes(48).toString('hex');
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000000,\nsegment-00000000.ts\n';
async function fixture(handler: http.RequestListener) {
  const server = http.createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-publisher-'));
  await fs.writeFile(path.join(directory, 'index.m3u8'), manifest); await fs.writeFile(path.join(directory, 'segment-00000000.ts'), Buffer.from('generated HLS media'));
  return { directory, server, options: { baseUrl: `http://127.0.0.1:${address.port}`, token, slug: 'sunday', allowLocalhostForTests: true }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); } };
}
const ok = (res: http.ServerResponse, body: object = {}) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('watch URL is a public HTTPS origin and configuration never returns publishing credentials', () => {
  for (const baseUrl of ['http://watch.example.com', 'https://user:pass@watch.example.com', 'https://watch.example.com/path', 'https://watch.example.com?key=x', 'https://127.0.0.1', 'https://10.0.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]']) assert.throws(() => createBroadcastRelay({ baseUrl, token, slug: 'sunday' }), WatchRelayError);
  for (const address of ['127.0.0.1', '10.2.0.1', '169.254.169.254', '100.64.0.1', '172.16.1.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:7f00:1', '2002:7f00:1::1', '2001:db8::1']) assert.equal(isPublicRelayAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicRelayAddress(address), true, address);
  const relay = createBroadcastRelay({ baseUrl: 'https://watch.example.com', token, slug: 'sunday' }); assert.equal(relay.publicUrl, 'https://watch.example.com/watch/sunday'); assert.ok(!JSON.stringify(relay).includes(token));
  assert.equal(createWatchRelayFromEnv({}).configured, false); assert.equal(createWatchRelayFromEnv({ LUMEN_WATCH_RELAY_URL: 'http://localhost', LUMEN_WATCH_RELAY_TOKEN: token, LUMEN_WATCH_RELAY_SLUG: 'sunday' }).configured, false);
});

test('publisher sends actual segment bytes before the playlist, uses header auth, deduplicates media and ends the current session', async () => {
  const calls: Array<{ url: string; body: Buffer }> = [];
  const f = await fixture(async (req, res) => { assert.equal(req.headers.authorization, `Bearer ${token}`); const parts: Buffer[] = []; for await (const chunk of req) parts.push(chunk); calls.push({ url: req.url ?? '', body: Buffer.concat(parts) }); ok(res, req.url?.endsWith('/sessions') ? { sessionId: '11111111-1111-4111-8111-111111111111' } : {}); });
  try {
    const relay = createBroadcastRelay(f.options); await relay.begin({ epoch: 'fixture-epoch-0001' }); await relay.publish({ directory: f.directory, playlist: 'index.m3u8' }); await relay.publish({ directory: f.directory, playlist: 'index.m3u8' }); await relay.finish();
    assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['sessions', 'segment-00000000.ts', 'index.m3u8', 'index.m3u8', 'end']);
    assert.equal(calls[1].body.toString(), 'generated HLS media'); assert.equal(calls[2].body.toString(), manifest); assert.ok(calls.every(call => !call.url.includes(token)));
  } finally { await f.close(); }
});

test('publisher blocks remote HLS paths, symlinks, oversized media and concurrent queues', async () => {
  let respond: (() => void) | undefined;
  const f = await fixture(async (req, res) => { for await (const _chunk of req) {} if (req.url?.endsWith('/sessions')) ok(res, { sessionId: '11111111-1111-4111-8111-111111111111' }); else respond = () => ok(res); });
  try {
    const relay = createBroadcastRelay({ ...f.options, maxSegmentBytes: 32 }); await relay.begin({ epoch: 'fixture-epoch-0001' });
    await fs.writeFile(path.join(f.directory, 'index.m3u8'), manifest.replace('segment-00000000.ts', '../secret.ts')); await assert.rejects(relay.publish({ directory: f.directory, playlist: 'index.m3u8' }), /generated local HLS/);
    await fs.writeFile(path.join(f.directory, 'index.m3u8'), manifest); await fs.writeFile(path.join(f.directory, 'segment-00000000.ts'), Buffer.alloc(33)); await assert.rejects(relay.publish({ directory: f.directory, playlist: 'index.m3u8' }), /too large/);
    await fs.unlink(path.join(f.directory, 'segment-00000000.ts')); await fs.symlink('index.m3u8', path.join(f.directory, 'segment-00000000.ts')); await assert.rejects(relay.publish({ directory: f.directory, playlist: 'index.m3u8' }), /invalid or too large/);
    await fs.unlink(path.join(f.directory, 'segment-00000000.ts')); await fs.writeFile(path.join(f.directory, 'segment-00000000.ts'), 'safe');
    const controller = new AbortController(), pending = relay.publish({ directory: f.directory, playlist: 'index.m3u8', signal: controller.signal });
    while (!respond) await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(relay.publish({ directory: f.directory, playlist: 'index.m3u8' }), (error: unknown) => error instanceof WatchRelayError && error.code === 'busy'); controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof WatchRelayError && error.code === 'cancelled');
  } finally { await f.close(); }
});

test('timeout, connection failure, redirects and stale publishing errors are bounded and never leak remote bodies or tokens', async () => {
  for (const code of [0, 302, 409, 500]) {
    const f = await fixture((req, res) => { req.resume(); if (!code) return; res.writeHead(code, { Location: 'http://127.0.0.1/private' }); res.end(`secret response ${token}`); });
    try { const relay = createBroadcastRelay({ ...f.options, timeoutMs: 50 }); const start = Date.now(); await assert.rejects(relay.begin({ epoch: 'fixture-epoch-0001' }), (error: unknown) => error instanceof WatchRelayError && error.httpStatus === (code === 409 ? 409 : undefined) && !error.message.includes(token) && !error.message.includes('secret response')); assert.ok(Date.now() - start < 1000); }
    finally { await f.close(); }
  }
});
