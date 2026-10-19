import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rendererCandidates, rendererFailureMessage, RendererStartupError, resolveRendererOrigin, waitForStationEngine } from '../src/renderer-startup.js';

async function station(options: { stationId?: string; page?: boolean } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/studio/engine/probe') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ station: options.stationId ?? 'this-station' }));
    } else if (req.url === '/studio/engine' && options.page !== false) {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div id="app"></div>');
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('Studio follows the actual local frontend port and does not trust remote request origins', () => {
  const options = { backendUrl: 'http://127.0.0.1:3000', development: true, requestOrigin: 'http://localhost:5180', requestReferer: 'http://localhost:5180/studio' };
  assert.equal(rendererCandidates(options)[0], 'http://localhost:5180');
  assert.equal(rendererCandidates({ ...options, development: false })[0], options.backendUrl);
  assert.ok(!rendererCandidates({ ...options, requestOrigin: 'https://untrusted.example', requestReferer: 'https://untrusted.example/studio', requestHost: 'untrusted.example' }).includes('https://untrusted.example'));
  assert.throws(() => rendererCandidates({ ...options, configuredUrl: 'file:///private/studio' }), RendererStartupError);
  assert.throws(() => rendererCandidates({ ...options, configuredUrl: 'http://user:password@localhost:5173' }), RendererStartupError);
});

test('a refused stale frontend address falls back to the backend-served build', async t => {
  const backend = await station(); t.after(backend.close);
  const stopped = await station(); await stopped.close();
  const result = await resolveRendererOrigin({ backendUrl: backend.origin, configuredUrl: stopped.origin, development: false }, 'this-station');
  assert.equal(result.origin, backend.origin);
  assert.equal(result.attempts[0].origin, stopped.origin);
  assert.match(result.attempts[0].error!, /fetch failed/);
  assert.equal(result.attempts[1].error, undefined);
});

test('a changed development port is used when the backend has no built frontend', async t => {
  const backend = await station({ page: false }); t.after(backend.close);
  const frontend = await station(); t.after(frontend.close);
  const result = await resolveRendererOrigin({ backendUrl: backend.origin, development: true, requestOrigin: frontend.origin }, 'this-station');
  assert.equal(result.origin, frontend.origin);
  assert.equal(result.attempts.length, 1);
});

test('a frontend belonging to another station is skipped before renderer authorization', async t => {
  const other = await station({ stationId: 'other-station' }); t.after(other.close);
  const backend = await station(); t.after(backend.close);
  const result = await resolveRendererOrigin({ backendUrl: backend.origin, configuredUrl: other.origin, development: false }, 'this-station');
  assert.equal(result.origin, backend.origin);
  assert.match(result.attempts[0].error!, /does not connect to this Lumen station/);
});

test('reachable but stale frontend code falls back when its renderer cannot become ready', async t => {
  const stale = await station(); t.after(stale.close);
  const backend = await station(); t.after(backend.close);
  const activated: string[] = [];
  const result = await resolveRendererOrigin({ backendUrl: backend.origin, configuredUrl: stale.origin, development: false }, 'this-station', async candidate => {
    activated.push(candidate);
    if (candidate === stale.origin) throw new Error('Renderer bootstrap failed: missing application module.');
  });
  assert.deepEqual(activated, [stale.origin, backend.origin]);
  assert.equal(result.origin, backend.origin);
  assert.match(result.attempts[0].error!, /Renderer bootstrap failed/);
});

test('a window readiness flag cannot substitute for this station’s renderer WebSocket', async t => {
  const wrongSocket = await station(); t.after(wrongSocket.close);
  const backend = await station(); t.after(backend.close);
  const result = await resolveRendererOrigin({ backendUrl: backend.origin, configuredUrl: wrongSocket.origin, development: false }, 'this-station', async candidate => {
    await waitForStationEngine(() => candidate === backend.origin, 30);
  });
  assert.equal(result.origin, backend.origin);
  assert.match(result.attempts[0].error!, /WebSocket did not connect to this station/);
  let connected = false;
  const timer = setTimeout(() => { connected = true; }, 10);
  t.after(() => clearTimeout(timer));
  await waitForStationEngine(() => connected, 100);
});

test('an unavailable renderer produces actionable public errors and retains separate diagnostics', async t => {
  const backend = await station({ page: false }); t.after(backend.close);
  await assert.rejects(resolveRendererOrigin({ backendUrl: backend.origin, development: false }, 'this-station'), (error: unknown) => {
    assert.ok(error instanceof RendererStartupError);
    assert.match(rendererFailureMessage(error, 'selecting'), /display page is unavailable/);
    assert.doesNotMatch(error.message, /127\.0\.0\.1|page\.goto|Call log|\u001b/);
    assert.equal(error.attempts[0].origin, backend.origin);
    assert.match(error.attempts[0].error!, /not being served/);
    return true;
  });
  const raw = new Error('page.goto: net::ERR_CONNECTION_REFUSED\u001b[2m Call log: http://127.0.0.1:5173');
  assert.match(rendererFailureMessage(raw, 'loading'), /Restart Lumen/);
  assert.doesNotMatch(rendererFailureMessage(raw, 'loading'), /page\.goto|Call log|\u001b/);
  assert.match(rendererFailureMessage(raw, 'ready'), /did not become ready/);
});
