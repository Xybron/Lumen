// Constructor-only loopback relay injection for the isolated browser test.
// Production environment validation and the normal server are unchanged.
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import tls from 'node:tls';
import { localRtmpsReceivers } from './helpers/local-rtmps.mjs';
import { createWatchRelay } from '../../watch-relay/server.mjs';
import { createBroadcastRelay } from '../dist/broadcast-relay.js';
import { createProduction } from '../dist/production.js';
import { identityRouter } from '../dist/identity-routes.js';
import { requireSession } from '../dist/auth.js';
import { router } from '../dist/routes.js';
import { initDb } from '../dist/db.js';
import { attachWebSocket } from '../dist/ws.js';
import { attachAgentSocket, createAgentRouter } from '../dist/agent-ws.js';
import { createMediaRouter } from '../dist/media-routes.js';
import { createWorship } from '../dist/worship.js';
import { DATA_DIR, FRONTEND_DIST, INCOMING_DIR, MEDIA_DIR, MEDIA_KINDS } from '../dist/paths.js';

if (process.env.LUMEN_BROADCAST_FIXTURE !== 'yes' || !path.basename(DATA_DIR).startsWith('lumen-broadcast-browser-')) throw new Error('Disposable broadcast fixture directory required.');
// JavaScript callers may otherwise silently pass ignored constructor fields to
// a stale build. Never enable fixture platform keys unless both network/process
// interception hooks are actually wired into the compiled integration.
if (!String(createProduction).includes('broadcastConnectTls') || !String(createProduction).includes('broadcastSpawn')) throw new Error('Build the constructor-injected broadcast integration before running this isolated fixture.');
const port = Number(process.env.PORT ?? 3470), base = `http://127.0.0.1:${port}`;
for (const directory of [DATA_DIR, INCOMING_DIR, ...MEDIA_KINDS.map(kind => path.join(MEDIA_DIR, kind))]) await fs.mkdir(directory, { recursive: true });
initDb();
// The private token stays in this process. Only the public origin is printed.
const token = randomBytes(48).toString('hex');
const relay = await createWatchRelay({ dataDir: path.join(DATA_DIR, 'watch-relay'), pushToken: token, allowedSlugs: ['live'] });
await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
const relayOrigin = `http://127.0.0.1:${relay.server.address().port}`;
const adapter = createBroadcastRelay({ baseUrl: relayOrigin, token, slug: 'live', allowLocalhostForTests: true });
const receivers = await localRtmpsReceivers(path.join(DATA_DIR, 'local-rtmps'), { paths: { youtube: '/live2/fixture-youtube-key-loopback-only', facebook: '/rtmp/fixture-facebook-key-loopback-only' } });
const spawned = [], tlsDials = [];
function broadcastSpawn(file, originalArguments, options) {
  const args = [...originalArguments], target = args.at(-1);
  let kind = target === 'pipe:1' && args.includes('mpegts') && args.includes('-c:v') && args[args.indexOf('-i') + 1] === 'pipe:0' ? 'encoder' : target?.endsWith('index.m3u8') ? 'watch' : 'probe';
  if (typeof target === 'string' && target.startsWith('rtmps:')) throw new Error('Native FFmpeg TLS must not be used for platform egress.');
  if (typeof target === 'string' && target.startsWith('rtmp:')) {
    if (new URL(target).hostname !== '127.0.0.1') throw new Error('Only a private loopback RTMP bridge is permitted.');
    const tcurl = args[args.indexOf('-rtmp_tcurl') + 1], hostname = new URL(tcurl).hostname;
    kind = hostname === 'a.rtmps.youtube.com' ? 'youtube' : hostname === 'live-api-s.facebook.com' ? 'facebook' : '';
    if (!kind) throw new Error('Only the fixed platform authorities may be used by the disposable fixture.');
  }
  const child = spawn(file, args, options);
  const record = { kind, pid: child.pid, codec: args.includes('-c:v') ? args[args.indexOf('-c:v') + 1] : 'copy', startedAt: Date.now(), running: true, diagnostics: '' };
  // Fixture-only generated keys are redacted; production diagnostics remain
  // classified rather than retaining FFmpeg's credential-bearing stderr.
  child.stderr?.on('data', bytes => { record.diagnostics = (record.diagnostics + bytes.toString()).replaceAll('fixture-youtube-key-loopback-only', '[REDACTED]').replaceAll('fixture-facebook-key-loopback-only', '[REDACTED]').slice(-4000); });
  spawned.push(record); child.once('close', code => { record.running = false; record.exitCode = code; });
  return child;
}
function broadcastConnectTls(options) {
  const kind = options.host === 'a.rtmps.youtube.com' ? 'youtube' : options.host === 'live-api-s.facebook.com' ? 'facebook' : '';
  if (!kind || options.servername !== options.host || Number(options.port) !== 443 || options.rejectUnauthorized !== true) throw new Error('The production bridge must request a verified, fixed-platform TLS connection.');
  const endpoint = new URL(receivers.endpoints[kind].url);
  const secure = tls.connect({ ...options, host: '127.0.0.1', port: Number(endpoint.port), servername: 'localhost', ca: receivers.certificate });
  const record = { kind, host: options.host, servername: options.servername, certificateVerification: true, connected: false };
  tlsDials.push(record); secure.once('secureConnect', () => { record.connected = true; record.authorized = secure.authorized; });
  secure.on('error', error => { record.errorCode = error.code ?? 'unknown'; });
  return secure;
}
const app = express(), server = http.createServer(app), messages = attachWebSocket(), worship = await createWorship(messages), agents = attachAgentSocket(messages);
app.use(express.json({ limit: '20mb' }));
// Only this already-guarded disposable fixture may combine local-mode cloning
// with constructor-intercepted social egress. The real launcher has no network
// bypass flag; every social TLS dial above is forced to a local test receiver.
const localWatch = process.env.LUMEN_BROADCAST_FIXTURE_LOCAL_WATCH === 'yes';
const localBroadcastDirectory = path.join(DATA_DIR, 'local-watch-runtime-broadcast');
if (localWatch) {
  if (!String(createProduction).includes('localWatch') || !String(createProduction).includes('initialConfigPath')) throw new Error('Build the local Watch clone integration before running this fixture.');
  await fs.mkdir(localBroadcastDirectory, { mode: 0o700 });
}
const production = await createProduction({ backendUrl: base, configuredUrl: base, development: false }, worship.sceneCueGates, {
  watchRelay: adapter, broadcastSpawn, broadcastConnectTls,
  ...(localWatch ? { localWatch: true, broadcastDirectory: localBroadcastDirectory } : {}),
});
server.on('upgrade', (request, socket, head) => {
  const pathname = (request.url ?? '').split('?')[0], target = pathname === '/ws' ? messages.wss : pathname === '/studio/ws' ? production.wss : pathname === '/agent' ? agents : null;
  if (target) target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request)); else socket.destroy();
});
app.use('/api', identityRouter); app.use('/api', production.router); app.use('/api', worship.router); app.use('/api', router); app.use('/api', createMediaRouter(messages)); app.use('/api', createAgentRouter(messages));
app.get('/__fixture/broadcast', requireSession, async (_request, response) => {
  response.json({ spawned, tlsDials, receivers: await receivers.snapshot(), nodeCpu: process.cpuUsage() });
});
app.use('/media/incoming', (_request, response) => response.status(404).end());
app.use('/media', express.static(MEDIA_DIR, { fallthrough: false }));
app.use(express.static(FRONTEND_DIST)); app.get('*', (_request, response) => response.sendFile(path.join(FRONTEND_DIST, 'index.html')));
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
console.log(JSON.stringify({ phase: 'broadcast-fixture-ready', base, relayOrigin }));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  worship.close(); await production.close().catch(() => {}); await relay.close(); await receivers.close();
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 6000).unref();
}
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
