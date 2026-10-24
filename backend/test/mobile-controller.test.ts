import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkServerIdentity } from 'node:tls';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';
import { createMobileController } from '../src/mobile-controller.js';
import { initialProduction } from '../src/production-schema.js';
import { ProductionError, ProductionStore } from '../src/production-store.js';
import { ContentSchema } from '../src/schema.js';
import type { SessionUser } from '../src/auth.js';
import type { RelayHandle } from '../src/ws.js';
import type { MobileAction, MobileSnapshot, MobilePermissions } from '../../shared/mobile-controller.js';
import type { StudioStatus } from '../../shared/production.js';
import type { WorshipWorkspace } from '../../shared/worship.js';

const all: MobilePermissions = { studio: true, channels: true, audio: true };
const teamId = '11111111-1111-4111-8111-111111111111';
const user: SessionUser = { id: 'operator', username: 'qa', displayName: 'QA operator', isAdmin: true };
const parseCookie = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? '';

async function fixture(options: { gateway?: boolean } = {}) {
  let now = Date.now(), authorized = true, sourceOwned = true;
  const channelOwners: Record<string, string> = {};
  let state = initialProduction();
  state.sources.push({ id: 'main', name: 'Service microphone', kind: 'microphone', loop: false, audio: { volume: .7, muted: false, mode: 'always', delayMs: 125 } },
    { id: 'private-video', name: 'Unrelated input', kind: 'video', url: 'media/backgrounds/private.mp4', loop: true, audio: { volume: .4, muted: true, mode: 'follow', delayMs: 70 } });
  state.mainAudioSourceId = 'main'; state.masterVolume = .8; state.masterMuted = false;
  state.program = structuredClone(state.scenes[0]); state.previewSceneId = state.scenes[1].id;
  const status: StudioStatus = { state: 'running', fps: 30, levels: { main: .45 }, sources: { main: 'ready' }, sourceErrors: { other: 'secret-device-error' }, recording: null };
  const content = ContentSchema.parse({ version: 2, updatedAt: new Date(now).toISOString(), settings: {}, music: {}, channels: [
    { id: 'scripture', name: 'Scripture', kind: 'scripture', playlistId: '' },
    { id: 'lyrics', name: 'Lyrics', kind: 'lyrics', playlistId: '' },
    { id: 'slides', name: 'Slides', kind: 'presentation', playlistId: 'slides-list' },
  ], playlists: [{ id: 'slides-list', name: 'Presentation', items: [{ id: 'slide-one', type: 'text', title: 'Welcome', body: 'First slide' }, { id: 'slide-two', type: 'text', title: 'Notices', body: 'Second slide' }] }] });
  const worship = new Map<string, WorshipWorkspace>(['scripture', 'lyrics'].map(channelId => [channelId, { channelId, revision: 0, versionId: 'KJV', setlist: [], recent: [], live: null, blanked: false, theme: { background: '#111111', color: '#ffffff', size: 'lg', align: 'center' } }]));
  const events: Record<string, unknown>[] = [], callbacks = new Set<(message: Record<string, unknown>) => void>(), viewerConnections: WebSocket[] = [];
  const relay = { injectRemote(message) { events.push(message); for (const cb of callbacks) cb(message); }, setAuthoritativeChannel(channel, payload) { const message = { t: 'state', channel, payload }; events.push(message); for (const cb of callbacks) cb(message); }, onLocalMessage(callback) { callbacks.add(callback); return () => callbacks.delete(callback); } } as RelayHandle;
  let hold: (() => Promise<void>) | undefined;
  const mutations: string[] = [];
  async function mutate(revision: number, name: string, authorize: () => void, update: () => void) {
    if (revision !== state.revision) throw new ProductionError(409, 'Changed');
    if (hold) await hold();
    authorize();
    if (revision !== state.revision) throw new ProductionError(409, 'Changed');
    update(); state.revision++; mutations.push(name);
  }
  const app = express(); app.use(express.json());
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-mobile-unit-'));
  let gateway: { origin: string; key: Buffer; cert: Buffer; host: string; port: number } | undefined;
  if (options.gateway) {
    const reserved = http.createServer(); await new Promise<void>(resolve => reserved.listen(0, '127.0.0.1', resolve));
    const port = (reserved.address() as AddressInfo).port; await new Promise<void>(resolve => reserved.close(() => resolve()));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    gateway = { origin: `https://127.0.0.1:${port}`, key: await fs.readFile(path.join(directory, 'key.pem')), cert: await fs.readFile(path.join(directory, 'cert.pem')), host: '127.0.0.1', port };
  }
  const frontend = path.join(directory, 'frontend'); await fs.mkdir(path.join(frontend, 'assets'), { recursive: true });
  await fs.writeFile(path.join(frontend, 'index.html'), '<!doctype html><title>Mobile QA</title><script src="/assets/mobile.js"></script>');
  await fs.writeFile(path.join(frontend, 'assets', 'mobile.js'), 'window.mobileQa=true;');
  await fs.writeFile(path.join(frontend, 'secret.json'), '{"private":"not-served"}');
  const controller = await createMobileController({
    workspaceId: teamId, now: () => now, allowedLocalOrigins: [origin], frontendDir: frontend, gateway, owners: () => channelOwners,
    attachProgramViewer: ws => { viewerConnections.push(ws); ws.send(JSON.stringify({ t: 'program-ready' })); },
    resolveOperator: header => header?.includes('lumen_session=operator-session') && authorized ? { sessionId: 'operator-session', user } : null,
    resolveSession: id => id === 'operator-session' && authorized ? user : null,
    can: (_who, channelId) => authorized && (channelId === '*' || sourceOwned),
    content: async () => structuredClone(content), relay,
    production: {
      get: () => structuredClone(state), status: () => structuredClone(status),
      select: (revision, sceneId, authorize) => mutate(revision, 'preview', authorize, () => { if (!state.scenes.some(scene => scene.id === sceneId)) throw new ProductionError(404, 'Missing'); state.previewSceneId = sceneId; }),
      take: (revision, sceneId, transition, durationMs, authorize) => mutate(revision, transition, authorize, () => { const scene = state.scenes.find(scene => scene.id === sceneId); if (!scene) throw new ProductionError(404, 'Missing'); const old = state.program?.id; state.program = structuredClone(scene); state.previewSceneId = old ?? sceneId; state.programTransition = { id: `transition_${state.revision}`, kind: transition, durationMs: transition === 'fade' ? durationMs : 0 }; }),
      audio: (revision, patch, authorize) => mutate(revision, 'audio', authorize, () => { const main = state.sources.find(source => source.id === state.mainAudioSourceId); if (!main) throw new ProductionError(409, 'No Main audio'); Object.assign(main.audio, patch); }),
    },
    worship: {
      workspace: id => structuredClone(worship.get(id)!),
      search: (_id, query) => ({ scripture: () => ({ verses: query ? [{ versionId: 'KJV', book: 43, bookName: 'John', chapter: 3, verse: 16, text: 'For God so loved the world' }] : [], reference: null, resolution: { kind: 'text', label: null, match: null, suggestions: [] }, keywordMode: 'keywords', ignoredWords: [] }), lyrics: () => [] }),
      command: async (id, revision, command, authorize) => { if (hold) await hold(); authorize(); const current = worship.get(id)!; if (current.revision !== revision) throw new ProductionError(409, 'Channel changed'); if (command.type === 'take') current.live = { selection: command.selection, title: 'Prepared passage', text: 'A channel cue', reference: 'John 3:16', attribution: 'KJV', takenAt: new Date(now).toISOString() }; if (command.type === 'blank') current.blanked = command.value; current.revision++; mutations.push('channel'); return structuredClone(current); },
    },
  });
  app.use('/api', controller.router);
  server.on('upgrade', (req, socket, head) => controller.handleUpgrade(req, socket, head));
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: error.message }));
  const request = (endpoint: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}) => fetch(`${origin}/api/mobile${endpoint}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function pair(permissions = all, name = 'QA phone') {
    const response = await request('/manage/pair', 'POST', { permissions, name }, 'lumen_session=operator-session'); assert.equal(response.status, 200);
    const pairing = await response.json() as { code: string; expiresAt: number; url?: string };
    const session = await request('/session', 'POST', { code: pairing.code, name }); assert.equal(session.status, 200);
    return { cookie: parseCookie(session), pairing, session: await session.json() as { paired: boolean; device: { id: string } } };
  }
  async function snapshot(cookie: string) { const response = await request('/state', 'GET', undefined, cookie); assert.equal(response.status, 200); return await response.json() as MobileSnapshot; }
  async function lease(cookie: string, takeover = false) { return request('/lease', 'POST', { takeover }, cookie); }
  async function action(cookie: string, action: MobileAction | Record<string, unknown>, supplied?: Partial<{ ticket: string; leaseId: string }>) {
    const state = await snapshot(cookie); return request('/control', 'POST', { ticket: state.ticket, leaseId: state.lease?.id, action, ...supplied }, cookie);
  }
  async function close() { await controller.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); }
  return { origin, gateway, directory, request, pair, snapshot, lease, action, close, mutations, events, controller, viewerConnections,
    get state() { return structuredClone(state); }, status, worship,
    advance(ms: number) { now += ms; }, revoke() { authorized = false; }, revokeChannels() { sourceOwned = false; }, ownChannel(channelId: string, operatorId: string) { channelOwners[channelId] = operatorId; },
    intervene() { state.revision++; }, hold(fn?: () => Promise<void>) { hold = fn; },
  };
}

test('mobile sessions require explicit pairing and management requires the current local operator', async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await f.request('/state')).status, 401);
  assert.equal((await f.request('/manage')).status, 401);
  assert.equal((await f.request('/manage/pair', 'POST', { permissions: all })).status, 401);
  assert.equal((await f.request('/session', 'POST', { code: 'invalid'.repeat(5), name: 'Unknown phone' })).status, 401);
  const phone = await f.pair(); assert.ok(phone.cookie); assert.equal(phone.session.paired, true);
  const session = await f.request('/session', 'GET', undefined, phone.cookie); assert.equal(session.status, 200);
  assert.equal((await f.request('/manage', 'GET', undefined, phone.cookie)).status, 401, 'A phone session is not a station operator session.');
  const serialized = JSON.stringify(await f.snapshot(phone.cookie));
  assert.doesNotMatch(serialized, /private\.mp4|secret-device-error|url|saved.key|sourceErrors|animationPresets/);
  assert.equal((await f.request('/session', 'DELETE', undefined, phone.cookie)).status, 200);
  assert.equal((await f.request('/state', 'GET', undefined, phone.cookie)).status, 401);
});

test('mobile pairing is single-use, expiring and cannot grant unrecognized permissions', async t => {
  const f = await fixture(); t.after(f.close);
  const paired = await f.pair(); assert.ok(paired.pairing.code.length >= 20);
  assert.equal((await f.request('/session', 'POST', { code: paired.pairing.code, name: 'Replay phone' })).status, 401);
  const response = await f.request('/manage/pair', 'POST', { permissions: all, name: 'Expires' }, 'lumen_session=operator-session');
  const code = (await response.json()).code; f.advance(10 * 60_000);
  assert.equal((await f.request('/session', 'POST', { code, name: 'Too late' })).status, 401);
  for (const permissions of [{ ...all, admin: true }, { studio: 'true', channels: true, audio: true }, {}]) {
    assert.equal((await f.request('/manage/pair', 'POST', { permissions }, 'lumen_session=operator-session')).status, 422);
  }
});

test('Origin and Host checks reject cross-site pairing and cookie-bearing control requests', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair();
  for (const badOrigin of ['https://evil.example', f.origin + '.evil.example', 'null', '']) {
    assert.equal((await f.request('/manage/pair', 'POST', { permissions: all }, 'lumen_session=operator-session', { Origin: badOrigin })).status, 403);
    assert.equal((await f.request('/lease', 'POST', {}, phone.cookie, { Origin: badOrigin })).status, 403);
  }
  const hostAttack = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(`${f.origin}/api/mobile/state`, { headers: { Host: 'evil.example', Origin: f.origin, Cookie: phone.cookie } }, response => { response.resume(); resolve(response.statusCode); }); request.once('error', reject);
  });
  assert.equal(hostAttack, 421);
  assert.deepEqual(f.mutations, []);
});

test('a single renewable control lease prevents competing phones and takeover invalidates the former owner', async t => {
  const f = await fixture(); t.after(f.close); const a = await f.pair(all, 'Phone A'), b = await f.pair(all, 'Phone B');
  assert.equal((await f.lease(a.cookie)).status, 200);
  const first = await f.snapshot(a.cookie); assert.equal(first.lease?.deviceId, a.session.device.id);
  assert.equal((await f.lease(b.cookie)).status, 409);
  assert.equal((await f.action(b.cookie, { type: 'take', transition: 'cut' })).status, 409);
  assert.equal((await f.lease(b.cookie, true)).status, 200);
  assert.equal((await f.action(a.cookie, { type: 'take', transition: 'cut' })).status, 409);
  const leaseB = (await f.snapshot(b.cookie)).lease!; assert.notEqual(leaseB.id, first.lease!.id);
  assert.equal((await f.lease(b.cookie)).status, 200); assert.equal((await f.snapshot(b.cookie)).lease?.id, leaseB.id);
  f.advance(31_000);
  assert.equal((await f.action(b.cookie, { type: 'take', transition: 'cut' }, { leaseId: leaseB.id })).status, 409);
  assert.equal((await f.lease(a.cookie)).status, 200);
  assert.deepEqual(f.mutations, []);
});

test('freshness tickets cannot replay, cross sessions, survive stale views or follow desktop intervention', async t => {
  const f = await fixture(); t.after(f.close); const a = await f.pair(), b = await f.pair(); await f.lease(a.cookie);
  const fresh = await f.snapshot(a.cookie);
  const command = { ticket: fresh.ticket, leaseId: fresh.lease!.id, action: { type: 'take', transition: 'cut' } };
  assert.equal((await f.request('/control', 'POST', command, b.cookie)).status, 409);
  assert.equal((await f.request('/control', 'POST', command, a.cookie)).status, 200);
  assert.equal((await f.request('/control', 'POST', command, a.cookie)).status, 409);
  const stale = await f.snapshot(a.cookie); f.advance(6000);
  assert.equal((await f.request('/control', 'POST', { ...command, ticket: stale.ticket }, a.cookie)).status, 409);
  const intervened = await f.snapshot(a.cookie); f.intervene();
  assert.equal((await f.request('/control', 'POST', { ...command, ticket: intervened.ticket }, a.cookie)).status, 409);
  assert.deepEqual(f.mutations, ['cut']);
});

test('overlapping status polls do not invalidate an unconsumed current-view action ticket', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair(); await f.lease(phone.cookie);
  const first = await f.snapshot(phone.cookie), later = await f.snapshot(phone.cookie);
  assert.equal(first.production.revision, later.production.revision);
  assert.equal((await f.request('/control', 'POST', { ticket: first.ticket, leaseId: first.lease!.id, action: { type: 'take', transition: 'cut' } }, phone.cookie)).status, 200, 'A status request that finished after the last accepted browser state must not invalidate the user’s deliberate click.');
  assert.equal((await f.request('/control', 'POST', { ticket: later.ticket, leaseId: later.lease!.id, action: { type: 'take', transition: 'fade' } }, phone.cookie)).status, 409, 'Other pre-action tickets cannot replay an action after the first commit.');
  assert.deepEqual(f.mutations, ['cut']);
});

test('Cut and Fade swap buses without rewriting scenes, outputs, source mix or Main selection', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair(); await f.lease(phone.cookie); const before = f.state;
  assert.equal((await f.action(phone.cookie, { type: 'take', transition: 'cut' })).status, 200);
  assert.equal(f.state.program!.id, before.previewSceneId); assert.equal(f.state.previewSceneId, before.program!.id);
  assert.equal((await f.action(phone.cookie, { type: 'take', transition: 'fade', durationMs: 650 })).status, 200);
  assert.equal(f.state.program!.id, before.program!.id); assert.equal(f.state.previewSceneId, before.previewSceneId);
  assert.equal(f.state.programTransition?.kind, 'fade'); assert.equal(f.state.programTransition?.durationMs, 650);
  for (const key of ['scenes', 'outputs', 'sources', 'mainAudioSourceId', 'masterMuted', 'masterVolume'] as const) assert.deepEqual(f.state[key], before[key]);
  assert.equal((await f.action(phone.cookie, { type: 'preview', sceneId: before.scenes[2].id })).status, 200);
  assert.equal(f.state.previewSceneId, before.scenes[2].id); assert.equal(f.state.program!.id, before.program!.id, 'Scene selection alone never takes it live.');
});

test('Main audio controls affect only the selected source and reject routing, other-source and engine actions', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair(); await f.lease(phone.cookie); const before = f.state;
  assert.equal((await f.action(phone.cookie, { type: 'main-audio', volume: .35, muted: true })).status, 200);
  const main = f.state.sources.find(source => source.id === 'main')!;
  assert.deepEqual(main.audio, { ...before.sources.find(source => source.id === 'main')!.audio, volume: .35, muted: true });
  assert.equal(f.state.mainAudioSourceId, 'main'); assert.deepEqual(f.state.sources.find(source => source.id === 'private-video'), before.sources.find(source => source.id === 'private-video'));
  assert.equal(f.state.masterVolume, before.masterVolume); assert.equal(f.state.masterMuted, before.masterMuted);
  for (const action of [{ type: 'set-main-audio', sourceId: 'private-video' }, { type: 'main-audio', sourceId: 'private-video', muted: false }, { type: 'main-audio', volume: 2 }, { type: 'main-audio', masterMuted: false }, { type: 'engine-stop' }, { type: 'broadcast-stop' }, { type: 'route', outputId: 'screen_main', sceneId: null }]) assert.equal((await f.action(phone.cookie, action)).status, 422);
});

test('paired permissions and current issuing-operator authority are rechecked on every action', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair({ studio: false, channels: true, audio: false }); await f.lease(phone.cookie);
  assert.equal((await f.action(phone.cookie, { type: 'take', transition: 'cut' })).status, 403);
  assert.equal((await f.action(phone.cookie, { type: 'main-audio', muted: true })).status, 403);
  assert.deepEqual(f.mutations, []);
  f.revoke(); assert.equal((await f.request('/state', 'GET', undefined, phone.cookie)).status, 401);
  assert.equal((await f.request('/lease', 'POST', {}, phone.cookie)).status, 401);
});

test('desktop device revocation and session expiry invalidate the cookie and any held lease', async t => {
  const f = await fixture(); t.after(f.close); const a = await f.pair(), b = await f.pair(); await f.lease(a.cookie);
  assert.equal((await f.request(`/manage/devices/${a.session.device.id}`, 'DELETE', undefined, 'lumen_session=operator-session')).status, 200);
  assert.equal((await f.request('/state', 'GET', undefined, a.cookie)).status, 401);
  assert.equal((await f.lease(b.cookie)).status, 200);
  f.advance(8 * 3600_000 + 1);
  assert.equal((await f.request('/state', 'GET', undefined, b.cookie)).status, 401);
  assert.deepEqual(f.mutations, []);
});

test('station-local pairing codes and cookies cannot authorize a different controller instance', async t => {
  const a = await fixture(), b = await fixture(); t.after(a.close); t.after(b.close);
  const phone = await a.pair();
  assert.equal((await b.request('/session', 'POST', { code: phone.pairing.code, name: 'Foreign station' })).status, 401);
  assert.equal((await b.request('/state', 'GET', undefined, phone.cookie)).status, 401);
  assert.equal((await a.request('/state', 'GET', undefined, phone.cookie)).status, 200);
  assert.deepEqual(a.mutations, []); assert.deepEqual(b.mutations, []);
});

test('pairing guesses are bounded while authorized polling budgets are independent for each phone', async t => {
  const f = await fixture(); t.after(f.close); const a = await f.pair(), b = await f.pair();
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await f.request('/session', 'POST', { code: 'wrong-code-with-high-entropy-length', name: 'Unknown' })).status, 401);
  assert.equal((await f.request('/session', 'POST', { code: 'wrong-code-with-high-entropy-length', name: 'Unknown' })).status, 429);
  for (let at = 0; at < 180; at++) assert.equal((await f.request('/state', 'GET', undefined, a.cookie)).status, 200);
  assert.equal((await f.request('/state', 'GET', undefined, a.cookie)).status, 429);
  assert.equal((await f.request('/state', 'GET', undefined, b.cookie)).status, 200, 'Another phone on the same Wi-Fi/IP retains its own polling budget.');
  f.advance(60_001); assert.equal((await f.request('/state', 'GET', undefined, a.cookie)).status, 200);
});

test('changed channel state and channel ownership invalidate a prepared action without changing Program', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair(); await f.lease(phone.cookie); const before = f.state;
  const ticket = await f.snapshot(phone.cookie); f.worship.get('scripture')!.revision++;
  assert.equal((await f.request('/control', 'POST', { ticket: ticket.ticket, leaseId: ticket.lease!.id, action: { type: 'take', transition: 'cut' } }, phone.cookie)).status, 409);
  f.ownChannel('scripture', 'another-operator');
  assert.equal((await f.action(phone.cookie, { type: 'channel-blank', channelId: 'scripture', blanked: true })).status, 409);
  assert.deepEqual(f.state, before); assert.equal(f.worship.get('scripture')!.blanked, false);
});

test('Program monitor upgrades require a paired studio-capable phone and exact Origin, and revoke immediately', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair(), channels = await f.pair({ studio: false, channels: true, audio: false });
  const connect = (cookie?: string, origin: string | undefined = f.origin, endpoint = '/mobile/signal') => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(f.origin.replace('http:', 'ws:') + endpoint, { ...(cookie ? { headers: { Cookie: cookie } } : {}), ...(origin ? { origin } : {}) });
    ws.once('open', () => resolve(ws)); ws.once('error', reject);
  });
  await assert.rejects(connect());
  await assert.rejects(connect(phone.cookie, 'https://untrusted.example'));
  await assert.rejects(connect(phone.cookie, ''));
  await assert.rejects(connect(channels.cookie));
  await assert.rejects(connect(phone.cookie, f.origin, '/studio/ws'));
  const ws = await connect(phone.cookie); const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
  assert.equal(f.viewerConnections.length, 1);
  assert.equal((await f.request(`/manage/devices/${phone.session.device.id}`, 'DELETE', undefined, 'lumen_session=operator-session')).status, 200);
  await closed; assert.equal(ws.readyState, WebSocket.CLOSED);
});

test('channel cues and hide controls never change Studio Program, scenes or persistent Main audio', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair(); await f.lease(phone.cookie); const before = f.state;
  assert.equal((await f.action(phone.cookie, { type: 'channel-take', channelId: 'scripture', selection: { kind: 'scripture', versionId: 'KJV', book: 43, chapter: 3, verse: 16 } })).status, 200);
  assert.equal(f.worship.get('scripture')!.live!.reference, 'John 3:16');
  assert.equal((await f.action(phone.cookie, { type: 'channel-blank', channelId: 'scripture', blanked: true })).status, 200);
  assert.equal(f.worship.get('scripture')!.blanked, true);
  assert.deepEqual(f.state, before);
  assert.equal((await f.action(phone.cookie, { type: 'channel-take', channelId: 'slides', selection: { kind: 'presentation', index: 1 } })).status, 200);
  assert.deepEqual(f.state, before); assert.ok(f.events.some(event => event.channel === 'slides'));
});

test('in-flight actions are not queued or committed after their authority is revoked', async t => {
  const f = await fixture(); t.after(f.close); const phone = await f.pair(); await f.lease(phone.cookie);
  let entered!: () => void, release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.hold(async () => { entered(); await held; });
  const ticket = await f.snapshot(phone.cookie);
  const pending = f.request('/control', 'POST', { ticket: ticket.ticket, leaseId: ticket.lease!.id, action: { type: 'take', transition: 'cut' } }, phone.cookie);
  await waiting;
  assert.equal((await f.action(phone.cookie, { type: 'take', transition: 'fade' })).status, 409, 'A second mutation must not wait behind the first.');
  f.revoke(); release();
  assert.notEqual((await pending).status, 200); assert.deepEqual(f.mutations, []);
});

test('TLS phone gateway exposes only the controller surface and exact static assets, not legacy APIs or management', async t => {
  const f = await fixture({ gateway: true }); t.after(f.close); const gateway = f.gateway!;
  const request = (endpoint: string, options: https.RequestOptions = {}, body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = https.request(gateway.origin + endpoint, { ca: gateway.cert, checkServerIdentity: (_host, certificate) => checkServerIdentity('127.0.0.1', certificate), ...options }, response => { let data = ''; response.on('data', bytes => { data += bytes.toString(); }); response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: data })); }); request.once('error', reject); if (body) request.write(body); request.end();
  });
  const page = await request('/remote'); assert.equal(page.status, 200); assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal((await request('/assets/mobile.js')).status, 200);
  for (const endpoint of ['/api/studio', '/api/content', '/api/auth/login', '/api/mobile/manage', '/api/mobile/manage/pair', '/studio/ws', '/ws', '/media/music/private.mp3', '/secret.json', '/assets/../secret.json', '/assets/mobile.js.map']) assert.equal((await request(endpoint)).status, 404, `${endpoint} must not be reachable through mobile listener.`);
  assert.equal((await request('/remote', { headers: { Host: 'rebinding.example' } })).status, 421);
  const pairing = await f.request('/manage/pair', 'POST', { permissions: all }, 'lumen_session=operator-session').then(response => response.json());
  const paired = await request('/api/mobile/session', { method: 'POST', headers: { Origin: gateway.origin, 'Content-Type': 'application/json' } }, JSON.stringify({ code: pairing.code, name: 'TLS phone' }));
  assert.equal(paired.status, 200); const cookieHeader = paired.headers['set-cookie']?.[0] ?? '';
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookieHeader.includes(attr), `Mobile cookie includes ${attr}.`);
  assert.doesNotMatch(cookieHeader, /Domain=/i);
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await request('/api/mobile/state', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request('/api/mobile/lease', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' } }, '{}')).status, 403);
  assert.equal((await request('/api/mobile/lease', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' } }, '{}')).status, 403);
  const badBody = await request('/not-a-route', { method: 'POST', headers: { Origin: gateway.origin, 'Content-Type': 'application/json' } }, '{bad json');
  assert.notEqual(badBody.status, 200); assert.doesNotMatch(badBody.body, /SyntaxError|node_modules|\/Users\/|stack/i, 'Malformed input cannot expose a development error stack.');
  const missingAsset = await request('/assets/missing.js'); assert.notEqual(missingAsset.status, 200); assert.doesNotMatch(missingAsset.body, /node_modules|\/Users\//i);
});

test('actual revisioned store restricts mobile controls to Preview and current Main audio without changing other settings', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-mobile-store-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ProductionStore(directory); await store.init(); let state = store.get();
  state.sources.push({ id: 'main', name: 'Main input', kind: 'microphone', loop: false, audio: { volume: .8, muted: true, mode: 'follow', delayMs: 80 } }, { id: 'other', name: 'Other input', kind: 'microphone', loop: false, audio: { volume: .4, muted: true, mode: 'always', delayMs: 0 } });
  state.masterMuted = true; state.masterVolume = .65; state = await store.save(state);
  state = await store.command(state.revision, { type: 'set-main-audio', sourceId: 'main' });
  state = await store.command(state.revision, { type: 'take', sceneId: state.scenes[0].id }); const before = structuredClone(state);
  const keysFile = path.join(directory, 'saved-key-qa.txt'); await fs.writeFile(keysFile, 'isolated-qa-key-do-not-touch'); const keys = await fs.readFile(keysFile);
  state = await store.mobileControls(state.revision, { sceneId: state.scenes[1].id }, () => {});
  assert.equal(state.previewSceneId, before.scenes[1].id); assert.deepEqual(state.program, before.program);
  state = await store.mobileControls(state.revision, { muted: true, volume: .25 }, () => {});
  assert.deepEqual(state.sources.find(source => source.id === 'main')!.audio, { ...before.sources.find(source => source.id === 'main')!.audio, muted: true, volume: .25 });
  for (const key of ['scenes', 'outputs', 'mainAudioSourceId', 'masterMuted', 'masterVolume'] as const) assert.deepEqual(state[key], before[key]);
  assert.deepEqual(state.sources.find(source => source.id === 'other'), before.sources.find(source => source.id === 'other'));
  assert.deepEqual(await fs.readFile(keysFile), keys);
  const stable = structuredClone(state);
  await assert.rejects(store.mobileControls(state.revision - 1, { muted: false }, () => {}), { status: 409 });
  await assert.rejects(store.mobileControls(state.revision, { muted: false }, () => { throw new ProductionError(403, 'Revoked'); }), { status: 403 });
  let checks = 0;
  await assert.rejects(store.mobileControls(state.revision, { muted: false }, () => { if (++checks > 1) throw new ProductionError(403, 'Revoked at commit'); }), { status: 403 });
  assert.deepEqual(store.get(), stable); assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'production.json'), 'utf8')), stable, 'A final failed authorization restores the unpublished file.');
});
