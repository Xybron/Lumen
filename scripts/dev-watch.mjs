import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url));
const frontendRequire = createRequire(new URL('../frontend/package.json', import.meta.url));

export function parseLocalWatchArgs(args) {
  const options = { backendPort: 3000, studioPort: 5173, watchPort: 3480, help: false };
  const names = { '--backend-port': 'backendPort', '--studio-port': 'studioPort', '--watch-port': 'watchPort' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    const name = Object.hasOwn(names, argument) ? names[argument] : undefined, value = args[++index];
    if (!name || !/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 65535) throw new Error('Use --backend-port, --studio-port or --watch-port followed by a port from 1 to 65535.');
    options[name] = Number(value);
  }
  if (new Set([options.backendPort, options.studioPort, options.watchPort]).size !== 3) throw new Error('Studio, backend and Watch must use different ports.');
  return options;
}

export function localWatchEnvironment(source, backendPort) {
  const environment = { ...source, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(backendPort), LUMEN_DEV_BACKEND_PORT: String(backendPort) };
  // Local rehearsal must never inherit an outward control bridge or a real
  // publishing relay. The one-use local token travels over private child IPC.
  for (const name of Object.keys(environment)) if (name.startsWith('LUMEN_WATCH_RELAY_') || ['LUMEN_VPS_URL', 'LUMEN_VPS_TOKEN', 'LUMEN_MEDIA_CTRL', 'LUMEN_RENDERER_URL'].includes(name)) delete environment[name];
  return environment;
}

export async function assertLocalPortAvailable(port, label) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen({ port, host: '127.0.0.1', exclusive: true }, resolve); });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error(`${label} port ${port} is already in use. Stop the existing Lumen development command first; no running process was changed.`);
    throw new Error(`${label} could not use local port ${port} (${error.code ?? 'unavailable'}).`);
  } finally { if (probe.listening) await new Promise(resolve => probe.close(resolve)); }
}

function childMessages(child, expected, milliseconds = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('The local backend did not become ready in time.')), milliseconds);
    const onMessage = message => { if (message?.t === expected) done(null, message); else if (message?.t === 'local-watch-error') done(new Error(message.message || 'The local backend could not start.')); };
    const onExit = () => done(new Error('The local backend stopped before it became ready.'));
    const onError = () => done(new Error('The local backend could not be started.'));
    function done(error, value) { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); error ? reject(error) : resolve(value); }
    child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
  });
}

function relayOutput(child, label) {
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => process.stdout.write(`[${label}] ${bytes}`));
}

async function waitForFrontend(origin, child, cancelled, milliseconds = 45000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error('Local Watch startup was cancelled.');
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('The Studio development server stopped before it became ready.');
    try { const response = await fetch(origin, { signal: AbortSignal.timeout(1500) }); if (response.ok && (await response.text()).includes('/@vite/client')) return; } catch { /* Await this owned server only. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The Studio development server did not become ready in time.');
}

async function stopChild(child, gracefulMessage) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (gracefulMessage && child.connected) child.send(gracefulMessage, () => {}); else child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 9000); })]); clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}

export async function runLocalWatch(options) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local Watch is a development launcher. Use the normal HTTPS relay configuration in production.');
  // Resolve dependencies and inspect ports before creating any private runtime
  // files or touching the station. Occupied ports are never automatically killed.
  const tsx = backendRequire.resolve('tsx');
  const vite = path.join(path.dirname(frontendRequire.resolve('vite/package.json')), 'bin', 'vite.js');
  const { createWatchRelay } = await import('../watch-relay/server.mjs');
  for (const [label, port] of [['Backend', options.backendPort], ['Studio', options.studioPort], ['Watch', options.watchPort]]) await assertLocalPortAvailable(port, label);

  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-local-watch-'));
  const broadcastDirectory = path.join(runtime, 'broadcast');
  const token = randomBytes(48).toString('hex');
  const backendUrl = new URL(`http://127.0.0.1:${options.backendPort}`).origin, studioUrl = new URL(`http://127.0.0.1:${options.studioPort}`).origin, watchOrigin = new URL(`http://127.0.0.1:${options.watchPort}`).origin;
  let relay, backend, frontend, stopping = false, starting = true, closeTask;
  let complete; const finished = new Promise(resolve => { complete = resolve; });
  const cleanup = () => closeTask ??= (async () => {
    stopping = true;
    const failures = [];
    try {
      for (const stop of [() => stopChild(backend, { t: 'local-watch-stop' }), () => stopChild(frontend), () => relay?.close().catch(error => { if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error; })]) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      // This exact mkdtemp root belongs only to this launcher. Never remove DATA_DIR.
      if (!backend || backend.exitCode !== null || backend.signalCode !== null) await fs.rm(runtime, { recursive: true, force: true });
    } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); complete(); }
    if (failures.length) throw new Error('A local service could not stop cleanly. Its temporary files were preserved if still needed.');
  })();
  function onSignal() { stopping = true; if (!starting) void cleanup().catch(() => { process.exitCode = 1; complete(); }); }
  const assertStarting = () => { if (stopping) throw new Error('Local Watch startup was cancelled.'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    await fs.chmod(runtime, 0o700); assertStarting();
    await fs.mkdir(broadcastDirectory, { mode: 0o700 }); assertStarting();
    relay = await createWatchRelay({ dataDir: path.join(runtime, 'relay'), pushToken: token, allowedSlugs: ['live'] });
    assertStarting();
    await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(options.watchPort, '127.0.0.1', resolve); });
    assertStarting();
    const environment = localWatchEnvironment(process.env, options.backendPort);
    environment.LUMEN_DATA_DIR = path.resolve(process.env.LUMEN_DATA_DIR ?? path.join(root, 'data'));
    environment.LUMEN_DEV_VITE_CACHE_DIR = path.join(runtime, 'vite-cache');
    backend = spawn(process.execPath, ['--import', tsx, path.join(root, 'backend', 'src', 'local-watch-server.ts')], { cwd: root, env: environment, stdio: ['inherit', 'pipe', 'pipe', 'ipc'] });
    relayOutput(backend, 'studio');
    const backendReady = childMessages(backend, 'local-watch-ready');
    backend.send({ t: 'local-watch-config', relayUrl: watchOrigin, token, broadcastDirectory, backendPort: options.backendPort, frontendUrl: studioUrl });
    const ready = await backendReady;
    assertStarting();
    if (ready.backendUrl !== backendUrl || ready.watchUrl !== `${watchOrigin}/watch/live`) throw new Error('The local backend did not confirm the expected private relay.');
    frontend = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(options.studioPort), '--strictPort'], { cwd: path.join(root, 'frontend'), env: environment, stdio: ['inherit', 'pipe', 'pipe'] });
    relayOutput(frontend, 'studio-ui');
    frontend.on('error', () => { if (!stopping) { process.stderr.write('The Studio development server could not start.\n'); process.exitCode = 1; onSignal(); } });
    for (const child of [backend, frontend]) child.once('exit', () => { if (!stopping) { process.stderr.write('A local service stopped; closing the other local services.\n'); process.exitCode = 1; onSignal(); } });
    await waitForFrontend(studioUrl, frontend, () => stopping);
    assertStarting(); starting = false;
    console.log(`\nLocal Watch test ready\nStudio: ${studioUrl}/studio\nWatch:  ${watchOrigin}/watch/live\n\nIn Studio, choose your destinations in Go Live, review, then confirm Go Live.\nEnabled Facebook and YouTube destinations stream publicly; Lumen Watch stays local.\nYour saved streaming setup and keys are reused privately in temporary settings.\nSetup changes in this run do not overwrite your normal saved streaming setup.\nYour scenes and Main audio selection are shared with your normal station.\nReconnect any live microphone, camera or screen share after signing in.\nNothing streams or records until you confirm. Ctrl+C stops all three local services.\n`);
    return { backendUrl, studioUrl, watchUrl: `${watchOrigin}/watch/live`, close: cleanup, finished };
  } catch (error) { starting = false; await cleanup(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseLocalWatchArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: npm run dev:watch -- [--backend-port 3000] [--studio-port 5173] [--watch-port 3480]\nStop npm run dev first. Reuses your saved streaming setup privately and adds local Watch; destinations still require Go Live confirmation.');
    else { const local = await runLocalWatch(options); await local.finished; }
  } catch (error) { console.error(`[local-watch] ${error.message}`); process.exitCode = 1; }
}
