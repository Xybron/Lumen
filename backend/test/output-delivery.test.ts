import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import express from 'express';
import http from 'node:http';
import { WebSocket } from 'ws';
import { ProductionHub } from '../src/production-hub.js';
import { createOutputDelivery, type OutputDeliveryStatus } from '../src/output-delivery.js';
import { initialProduction } from '../src/production-schema.js';

class Engine extends EventEmitter {
  readyState = WebSocket.OPEN;
  messages: Record<string, unknown>[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
  ping() {}
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate() { this.close(); }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${label}`);
}
async function socket(url: string, auth?: unknown, origin?: string) {
  const location = new URL(url), frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(`ws://${location.host}/signal`, { origin: origin ?? location.origin });
  ws.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  if (auth) ws.send(JSON.stringify(auth));
  return { ws, frames };
}

test('output gateway provides capability-scoped media signaling without exposing station APIs or metadata', { timeout: 20000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-output-delivery-'));
  const production = initialProduction();
  production.sources.push({ id: 'private-camera', name: 'Private camera name', kind: 'camera', loop: false, audio: { volume: 1, muted: false, mode: 'always', delayMs: 0 } });
  const productionFile = path.join(dir, 'production.json'), keysFile = path.join(dir, 'saved-keys.json');
  await fs.writeFile(productionFile, JSON.stringify(production)); await fs.writeFile(keysFile, 'unchanged-test-private-keys');
  const before = await fs.readFile(productionFile), keysBefore = await fs.readFile(keysFile);
  const hub = new ProductionHub(req => req.headers['x-test-engine'] === 'yes', () => production,
    () => ({ state: 'running', fps: 30, levels: { 'private-camera': 1 }, sources: { 'private-camera': 'ready' }, sourceErrors: {}, recording: null }));
  const engine = new Engine();
  hub.wss.emit('connection', engine as unknown as WebSocket, { headers: { 'x-test-engine': 'yes' } } as IncomingMessage);
  const engineId = engine.messages[0].peerId;
  const delivery = await createOutputDelivery({ directory: path.join(dir, 'delivery'), hub, getState: () => production, listenPort: 0 });
  const app = express(); app.use(express.json()); app.use('/control', delivery.router);
  app.use((error: Error & { status?: number; issues?: unknown[] }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? (error.issues ? 422 : 500)).json({ error: 'Request rejected' }));
  const control = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); server.once('error', reject); });
  const base = `http://127.0.0.1:${(control.address() as AddressInfo).port}/control`;
  const request = (endpoint: string, method = 'GET', body?: unknown) => fetch(`${base}${endpoint}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    await delivery.close(); hub.close(); control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(((await (await request('')).json()) as OutputDeliveryStatus).running, false, 'No listener or network exposure before explicit enable');
  for (const id of ['preview', 'multiview', 'program-monitor', 'unknown']) assert.equal((await request('/links', 'POST', { outputId: id })).status, 404);
  const created = await request('/links', 'POST', { outputId: 'screen_main' }); assert.equal(created.status, 200);
  const state = await created.json() as OutputDeliveryStatus, link = state.links[0], url = new URL(link.localUrl!);
  assert.equal(state.running, true); assert.equal(state.host, '127.0.0.1'); assert.equal(link.networkUrl, null);
  assert.equal(url.search, ''); assert.match(url.hash, /^#key=[A-Za-z0-9_-]{43}$/);
  const key = new URLSearchParams(url.hash.slice(1)).get('key')!;
  const html = await fetch(url); assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const htmlText = await html.text();
  assert.doesNotMatch(htmlText, /private-camera|Private camera|sources|mainAudioSourceId|recording/);
  assert.match(htmlText, /<body class="idle">/);
  for (const endpoint of ['/api/studio', '/studio/ws', '/api/studio/command', '/media/private', '/output/screen_main?key=anything']) assert.equal((await fetch(`${url.origin}${endpoint}`)).status, 404);
  const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.get(url.origin + url.pathname, { headers: { Host: 'rebinding.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.once('error', reject);
  });
  assert.equal(rebindingStatus, 421);
  const script = await (await fetch(`${url.origin}/viewer.js`)).text(); assert.doesNotThrow(() => new Function(script));
  assert.match(script, /history\.replaceState/); assert.match(script, /socket===connection&&connection\.readyState===WebSocket\.OPEN/);
  assert.doesNotMatch(script, /sessionStorage|localStorage/); assert.match(script, /parameters\.get\('audio'\)==='1'/);
  await assert.rejects(socket(url.toString(), undefined, 'https://untrusted.example'), /socket hang up|Unexpected server response|ECONNRESET/);
  const viewer = await socket(url.toString(), { t: 'auth', outputId: 'screen_main', key }); clients.push(viewer.ws);
  await until(() => viewer.frames.some(frame => frame.t === 'connected'), 'scoped viewer connects');
  assert.deepEqual(Object.keys(viewer.frames[0]).sort(), ['audioEnabled', 'engineState', 'outputId', 'peerId', 't']);
  assert.equal(viewer.frames[0].audioEnabled, false, 'Named output sound remains its existing setting');
  const viewerId = viewer.frames[0].peerId;
  await until(() => engine.messages.some(frame => frame.t === 'watch' && frame.peerId === viewerId && frame.outputId === 'screen_main'), 'viewer is offered only its fixed output');
  engine.messages = [];
  for (const value of [{ t: 'watch', outputId: 'preview' }, { t: 'watch', outputId: 'program' }, { t: 'unwatch', outputId: 'screen_broadcast' }, { t: 'publish', sourceId: 'private-camera' },
    { t: 'signal', peerId: engineId, key: 'out:preview', description: { type: 'answer', sdp: 'private' } },
    { t: 'signal', peerId: engineId, key: 'out:screen_main', description: { type: 'offer', sdp: 'forged' } }]) viewer.ws.send(JSON.stringify(value));
  await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(engine.messages, []);
  viewer.ws.send(JSON.stringify({ t: 'signal', peerId: engineId, key: 'out:screen_main', description: { type: 'answer', sdp: 'valid-answer' } }));
  await until(() => engine.messages.some(frame => (frame.description as { sdp?: string })?.sdp === 'valid-answer'), 'answer reaches renderer');
  hub.broadcast({ t: 'state', state: production }); hub.broadcast({ t: 'status', status: { sources: { private: true } } });
  engine.frame({ t: 'signal', peerId: viewerId, key: 'out:screen_main', description: { type: 'offer', sdp: 'scoped-offer' } });
  await until(() => viewer.frames.some(frame => (frame.description as { sdp?: string })?.sdp === 'scoped-offer'), 'only scoped renderer offer reaches viewer');
  assert.doesNotMatch(JSON.stringify(viewer.frames), /private-camera|Private camera|sources|recording|mainAudioSourceId|animationPresets/);
  const wrong = await socket(url.toString(), { t: 'auth', outputId: 'screen_main', key: 'x'.repeat(43) }); clients.push(wrong.ws);
  await until(() => wrong.ws.readyState === WebSocket.CLOSED, 'wrong key rejected'); assert.deepEqual(wrong.frames, []);
  const cross = await socket(url.toString(), { t: 'auth', outputId: 'screen_broadcast', key }); clients.push(cross.ws);
  await until(() => cross.ws.readyState === WebSocket.CLOSED, 'key cannot authorize another output'); assert.deepEqual(cross.frames, []);
  for (let index = 0; index < 3; index++) { const next = await socket(url.toString(), { t: 'auth', outputId: 'screen_main', key }); clients.push(next.ws); await until(() => next.frames.length > 0, 'per-link viewer'); }
  const excess = await socket(url.toString(), { t: 'auth', outputId: 'screen_main', key }); clients.push(excess.ws);
  await until(() => excess.ws.readyState === WebSocket.CLOSED, 'fifth viewer rejected'); assert.deepEqual(excess.frames, []);
  assert.equal((await request('/network', 'POST', { host: '0.0.0.0' })).status, 422);
  assert.equal((await request('/network', 'POST', { host: '8.8.8.8' })).status, 422);
  if (state.interfaces[0]) {
    const lanResponse = await request('/network', 'POST', { host: state.interfaces[0].address }); assert.equal(lanResponse.status, 200);
    const lan = await lanResponse.json() as OutputDeliveryStatus;
    assert.equal(lan.links[0].localUrl, link.localUrl, 'LAN sharing cannot replace or break the loopback OBS URL');
    assert.equal(new URL(lan.links[0].networkUrl!).hostname, state.interfaces[0].address);
    assert.equal((await fetch(lan.links[0].networkUrl!)).status, 200, 'The explicitly selected private interface serves only the clean output page');
    assert.equal((await fetch(`${new URL(lan.links[0].networkUrl!).origin}/api/studio`)).status, 404);
  }
  const kept = await (await request('/network', 'POST', { host: '127.0.0.1' })).json() as OutputDeliveryStatus;
  assert.equal(kept.links[0].localUrl, link.localUrl, 'Disabling LAN preserves stable loopback links');
  assert.equal(kept.links[0].networkUrl, null);
  assert.equal((await fs.stat(path.join(dir, 'delivery', 'links-private.json'))).mode & 0o777, 0o600);
  assert.equal((await request('/links/screen_main', 'DELETE')).status, 200);
  await until(() => viewer.ws.readyState === WebSocket.CLOSED, 'revocation closes established media signaling');
  await until(() => engine.messages.some(frame => frame.t === 'peer-left' && frame.peerId === viewerId), 'renderer is told to release revoked media peer');
  const revoked = await socket(url.toString(), { t: 'auth', outputId: 'screen_main', key }); clients.push(revoked.ws);
  await until(() => revoked.ws.readyState === WebSocket.CLOSED, 'revoked link cannot reconnect');
  assert.deepEqual(await fs.readFile(productionFile), before); assert.deepEqual(await fs.readFile(keysFile), keysBefore);
});
