import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-renderer-startup-'));
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
let heldOpen = false, heldClosed = false;
const frontend = http.createServer((req, res) => {
  if (req.url === '/studio/engine') {
    res.setHeader('Content-Type', 'text/html');
    // This reachable page proxies the right API and claims to be ready, but
    // cannot render outputs because its engine WebSocket never connects.
    res.end('<!doctype html><script>new EventSource("/hold"); window.__lumenRendererReady = true;</script>');
  } else if (req.url === '/hold') {
    heldOpen = true; res.setHeader('Content-Type', 'text/event-stream'); res.write('data: waiting\n\n');
    res.on('close', () => { heldClosed = true; });
  } else if (req.url === '/api/studio/engine/probe') {
    const upstream = http.get(`${base}${req.url}`, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.statusCode = 502; res.end(); });
  } else { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve));
const frontendOrigin = `http://127.0.0.1:${frontend.address().port}`;
const backend = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dataDir, LUMEN_RENDERER_URL: frontendOrigin },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
backend.stdout.on('data', data => { logs += data; });
backend.stderr.on('data', data => { logs += data; });

try {
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(`${base}/api/studio/status`)).ok) break; } catch { /* server starting */ }
    if (Date.now() >= deadline) throw new Error(`Backend did not start:\n${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const started = await fetch(`${base}/api/studio/engine/start`, { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(35000) });
  assert.equal(started.status, 200, await started.text());
  const status = await (await fetch(`${base}/api/studio/status`)).json();
  assert.equal(status.state, 'running');
  const diagnostics = await (await fetch(`${base}/api/studio/diagnostics`, { headers: { cookie } })).json();
  assert.equal(diagnostics.startup.origin, base);
  assert.equal(diagnostics.startup.attempts[0].origin, frontendOrigin);
  assert.match(diagnostics.startup.attempts[0].error, /WebSocket did not connect to this station/);
  assert.equal(heldOpen, true, 'the rejected renderer loaded its page');
  assert.equal(heldClosed, true, 'the rejected renderer context closed before fallback completed');
  assert.equal((await fetch(`${base}/api/studio/diagnostics`)).status, 401);
  assert.equal((await fetch(`${base}/api/studio/engine/stop`, { method: 'POST', headers: { cookie } })).status, 200);
  console.log(JSON.stringify({ result: 'PASS', checks: ['reachable stale frontend rejected by station WebSocket readiness', 'failed renderer context closed', 'healthy backend renderer fallback', 'startup diagnostics require operator authentication'], artifacts: dataDir }, null, 2));
} catch (error) {
  console.error(logs); throw error;
} finally {
  backend.kill('SIGTERM');
  await Promise.race([new Promise(resolve => backend.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (backend.exitCode === null) backend.kill('SIGKILL');
  frontend.closeAllConnections();
  await new Promise(resolve => frontend.close(resolve));
}
