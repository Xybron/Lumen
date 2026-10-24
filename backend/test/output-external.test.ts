import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createExternalOutput } from '../src/output-external.js';
import { createProtectedOutputRelay, createWatchRelayFanout, createWatchRelayFromEnv, probeProtectedOutput, type WatchRelayAdapter } from '../src/broadcast-relay.js';

const push = randomBytes(48).toString('hex'), viewer = randomBytes(48).toString('hex');
const wait = (milliseconds = 0) => new Promise(resolve => setTimeout(resolve, milliseconds));
const env = (baseUrl: string): NodeJS.ProcessEnv => ({ LUMEN_OUTPUT_RELAY_URL: baseUrl, LUMEN_OUTPUT_RELAY_TOKEN: push, LUMEN_OUTPUT_VIEWER_TOKEN: viewer });
async function relay(handler: http.RequestListener) {
  const server = http.createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { origin: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const adapter = (overrides: Partial<WatchRelayAdapter> = {}): WatchRelayAdapter => ({ configured: true, publicUrl: 'https://watch.example.com/watch/live', async begin() {}, async publish() {}, async finish() {}, ...overrides });

test('external setup is opt-in, fails closed and does not reveal viewer or publishing credentials before explicit verification', async () => {
  assert.deepEqual(createExternalOutput().status().url, null);
  for (const input of [env('http://watch.example.com'), env('https://127.0.0.1'), env('https://10.0.0.1'), env('https://[::1]'), env('https://watch.example.com/path'), env('https://user:password@watch.example.com'), { ...env('https://watch.example.com'), LUMEN_OUTPUT_VIEWER_TOKEN: push }, { ...env('https://watch.example.com'), LUMEN_OUTPUT_RELAY_SLUG: 'live', LUMEN_WATCH_RELAY_SLUG: 'live' }]) {
    const external = createExternalOutput(input);
    assert.equal(external.status().configured, false); assert.equal((await external.verify()).url, null);
    assert.ok(!JSON.stringify(external.status()).includes(push)); assert.ok(!JSON.stringify(external.status()).includes(viewer));
  }
  const readyToVerify = createExternalOutput(env('https://watch.example.com'));
  assert.equal(readyToVerify.status().configured, true); assert.equal(readyToVerify.status().verified, false); assert.equal(readyToVerify.status().url, null);
});

test('explicit verification sends the viewer key only in a header and requires protected matching metadata', async () => {
  let calls = 0, valid = true;
  const fixture = await relay((req, res) => {
    calls++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/api/output/program/info'); assert.equal(req.headers.authorization, `Bearer ${viewer}`);
    assert.ok(!req.url?.includes(viewer)); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ protected: valid, slug: 'program', watchUrl: '/output/program', status: 'offline' }));
  });
  try {
    const external = createExternalOutput(env(fixture.origin), { allowLocalhostForTests: true });
    assert.equal(calls, 0); assert.equal(external.status().url, null);
    const verified = await external.verify(); assert.equal(calls, 1); assert.equal(verified.verified, true);
    const link = new URL(verified.url!); assert.equal(link.pathname, '/output/program'); assert.equal(link.search, ''); assert.equal(new URLSearchParams(link.hash.slice(1)).get('key'), viewer);
    assert.ok(!verified.url?.includes(push)); valid = false;
    assert.equal((await external.verify()).verified, false); assert.equal(external.status().url, null, 'a failed recheck withdraws the private link');
  } finally { await fixture.close(); }
});

test('a response cannot redirect viewers, downgrade protection, or leak secret error bodies', async () => {
  for (const response of [{ protected: true, slug: 'other', watchUrl: '/output/program', status: 'live' }, { protected: true, slug: 'program', watchUrl: 'https://attacker.example', status: 'live' }, { protected: true, slug: 'program', watchUrl: '/output/program', status: 'unknown' }]) {
    const fixture = await relay((_req, res) => res.end(JSON.stringify(response)));
    try { assert.equal((await createExternalOutput(env(fixture.origin), { allowLocalhostForTests: true }).verify()).url, null); }
    finally { await fixture.close(); }
  }
  for (const code of [302, 401, 500]) {
    const fixture = await relay((_req, res) => { res.writeHead(code, { Location: 'http://127.0.0.1/private' }); res.end(`secret response ${push} ${viewer}`); });
    try { const result = await createExternalOutput(env(fixture.origin), { allowLocalhostForTests: true }).verify(); assert.equal(result.url, null); assert.ok(!JSON.stringify(result).includes(viewer)); assert.ok(!JSON.stringify(result).includes(push)); assert.ok(!result.message.includes('secret response')); }
    finally { await fixture.close(); }
  }
});

test('probe uses bounded deadlines, and localhost cannot be granted by an environment flag', async () => {
  const fixture = await relay(() => {});
  try {
    const unsafeEnv = { ...env(fixture.origin), LUMEN_OUTPUT_ALLOW_LOCALHOST: 'true' };
    assert.equal(createExternalOutput(unsafeEnv).status().configured, false);
    const start = Date.now(), external = createExternalOutput(env(fixture.origin), { allowLocalhostForTests: true, timeoutMs: 30 });
    assert.equal((await external.verify()).verified, false); assert.ok(Date.now() - start < 1000);
    await assert.rejects(probeProtectedOutput({ baseUrl: fixture.origin, slug: 'program', token: push, viewerToken: viewer }));
  } finally { await fixture.close(); }
});

test('protected output configuration never disables an otherwise-valid public Watch adapter', () => {
  const base = { LUMEN_WATCH_RELAY_URL: 'https://watch.example.com', LUMEN_WATCH_RELAY_TOKEN: push, LUMEN_WATCH_RELAY_SLUG: 'live' };
  const primary = createWatchRelayFromEnv({ ...base, LUMEN_OUTPUT_VIEWER_TOKEN: push });
  assert.equal(primary.configured, true); assert.equal(primary.publicUrl, 'https://watch.example.com/watch/live');
  const fanout = createWatchRelayFromEnv({ ...base, LUMEN_OUTPUT_VIEWER_TOKEN: viewer });
  assert.equal(fanout.configured, true); assert.equal(fanout.publicUrl, primary.publicUrl);
});

test('protected publishing sends no session or media request when the relay private gate is missing', async () => {
  const requests: string[] = [];
  const fixture = await relay((req, res) => { requests.push(req.url ?? ''); res.end(JSON.stringify({ protected: false, slug: 'program', watchUrl: '/output/program', status: 'offline' })); });
  try {
    const secondary = createProtectedOutputRelay({ baseUrl: fixture.origin, slug: 'program', token: push, viewerToken: viewer, allowLocalhostForTests: true });
    await assert.rejects(secondary.begin({ epoch: 'test-epoch-0001' }), /protected output/);
    assert.deepEqual(requests, ['/api/output/program/info']);
  } finally { await fixture.close(); }
});

test('secondary failures/timeouts never block or reject primary Watch delivery', async () => {
  const primaryCalls: string[] = [], secondarySignals: AbortSignal[] = [];
  const primary = adapter({ async begin() { primaryCalls.push('begin'); }, async publish() { primaryCalls.push('publish'); }, async finish() { primaryCalls.push('finish'); } });
  const secondary = adapter({ async begin({ signal }) { secondarySignals.push(signal!); await new Promise<void>(() => {}); } });
  const fanout = createWatchRelayFanout(primary, secondary, { timeoutMs: 25 });
  const start = Date.now(); await fanout.begin({ epoch: 'test-epoch-0001' });
  await fanout.publish({ directory: '/safe/generated', playlist: 'index.m3u8' }); await fanout.finish();
  assert.ok(Date.now() - start < 100); assert.deepEqual(primaryCalls, ['begin', 'publish', 'finish']);
  await wait(40); assert.ok(secondarySignals[0].aborted);
});

test('fanout keeps only the latest pending playlist and cancels old generation work on finish', async () => {
  const published: string[] = [], releases: (() => void)[] = [], signals: AbortSignal[] = [];
  const secondary = adapter({ async publish({ directory, signal }) { published.push(directory); signals.push(signal!); await new Promise<void>(resolve => releases.push(resolve)); } });
  const fanout = createWatchRelayFanout(adapter(), secondary, { timeoutMs: 100 });
  await fanout.begin({ epoch: 'test-epoch-0001' }); await wait();
  await fanout.publish({ directory: '/first', playlist: 'index.m3u8' }); await wait();
  await fanout.publish({ directory: '/discarded', playlist: 'index.m3u8' });
  await fanout.publish({ directory: '/latest', playlist: 'index.m3u8' });
  assert.deepEqual(published, ['/first']); releases.shift()!(); await wait();
  assert.deepEqual(published, ['/first', '/latest']);
  await fanout.finish(); assert.equal(signals.at(-1)?.aborted, true);
  releases.shift()!(); await wait(); assert.deepEqual(published, ['/first', '/latest']);
});

test('a delayed primary begin cannot start private publishing after finish', async () => {
  let release: (() => void) | undefined, privateBegins = 0;
  const primary = adapter({ async begin() { await new Promise<void>(resolve => { release = resolve; }); } });
  const fanout = createWatchRelayFanout(primary, adapter({ async begin() { privateBegins++; } }));
  const pending = fanout.begin({ epoch: 'test-epoch-0001' });
  await fanout.finish(); release!(); await assert.rejects(pending, /cancelled/); await wait();
  assert.equal(privateBegins, 0);
});

test('a delayed old primary publish cannot enqueue old media into a new private session', async () => {
  let release: (() => void) | undefined;
  const privateDirectories: string[] = [];
  const primary = adapter({ async publish() { await new Promise<void>(resolve => { release = resolve; }); } });
  const fanout = createWatchRelayFanout(primary, adapter({ async publish({ directory }) { privateDirectories.push(directory); } }));
  await fanout.begin({ epoch: 'test-epoch-0001' }); await wait();
  const pending = fanout.publish({ directory: '/old-session', playlist: 'index.m3u8' });
  await fanout.begin({ epoch: 'test-epoch-0002' }); release!(); await pending; await wait();
  assert.deepEqual(privateDirectories, []); await fanout.finish();
});

test('public retry epochs remain independent from ended private replay fences', async () => {
  const epochs: string[] = [];
  const fanout = createWatchRelayFanout(adapter(), adapter({ async begin({ epoch }) { epochs.push(epoch); } }));
  await fanout.begin({ epoch: 'same-public-epoch' }); await wait();
  await fanout.begin({ epoch: 'same-public-epoch' }); await wait();
  assert.equal(epochs.length, 2); assert.notEqual(epochs[0], epochs[1]);
  assert.ok(epochs.every(epoch => /^[a-f0-9-]{36}$/.test(epoch)));
  await fanout.finish();
});
