// Focused operator-only status UI regression. Real isolated station state and
// Main-selection commands; simulated read-only health telemetry only. No engine,
// physical devices, recordings or dependency on WebRTC video negotiation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-main-audio-status-'));
const port = Number(process.env.LUMEN_MAIN_AUDIO_TEST_PORT ?? 3428), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let browser, page, logs = '';
const server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
async function until(fn, label, timeout = 12000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { if (await fn()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'server start');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const document = await get();
  const mainName = 'Service mixer · Broadcast desk microphone with a deliberately long input name';
  document.sources = [{ id: 'main', name: mainName, kind: 'microphone' }, { id: 'backup', name: 'Backup feed', kind: 'microphone' }].map(source => ({ ...source, loop: false, audio: { volume: .6, muted: true, mode: 'follow', delayMs: 0 } }));
  assert.equal((await request.put(`${base}/api/studio`, { data: document })).status(), 200);
  page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  let telemetry = { state: 'running', fps: 30, levels: {}, sources: { main: 'ready', backup: 'ready' }, sourceErrors: {}, recording: null };
  const sockets = new Set();
  await page.route('**/api/studio/status', route => route.fulfill({ json: telemetry }));
  await page.routeWebSocket('**/studio/ws', ws => {
    const upstream = ws.connectToServer(); sockets.add(ws);
    upstream.onMessage(message => {
      const data = JSON.parse(String(message));
      if (data.status) data.status = telemetry;
      ws.send(JSON.stringify(data));
    });
    ws.onClose(() => { sockets.delete(ws); upstream.close(); });
  });
  function health(patch) {
    telemetry = { ...telemetry, ...patch };
    for (const socket of sockets) socket.send(JSON.stringify({ t: 'status', status: telemetry }));
  }
  await page.goto(`${base}/studio`); await page.getByTestId('output-audio-control').waitFor();
  const sourceRow = id => page.locator(`.source-list .source-row[data-source-id="${id}"]`);
  const labels = { ready: 'Main', muted: 'Main · Muted', disconnected: 'Main · Disconnected', error: 'Main · Error', offline: 'Main · Offline', loading: 'Main · Connecting' };
  async function badge(state, id = 'main') {
    await page.getByRole('button', { name: /^Sources/ }).click();
    const element = sourceRow(id).getByTestId('source-main-audio-badge');
    await until(async () => await element.getAttribute('data-state') === state && (await element.textContent()).trim() === labels[state], `Main badge ${state}`);
    assert.equal(await page.getByTestId('source-main-audio-badge').count(), 1);
    assert.equal(await element.evaluate(node => node.tagName), 'SPAN');
    assert.equal(await page.getByRole('button', { name: /^Set .+ as Main audio$/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Clear Main audio', exact: true }).count(), 0);
    await sourceRow(id).scrollIntoViewIfNeeded();
    return element;
  }
  async function mixer() { await page.getByRole('button', { name: 'Audio mixer', exact: true }).click(); }
  async function screenshot(name) { await page.screenshot({ path: path.join(dir, name), fullPage: true }); }
  await mixer(); await page.getByRole('button', { name: `Set ${mainName} as Main audio`, exact: true }).click();
  await until(async () => (await get()).mainAudioSourceId === 'main', 'real Main selection saved');
  await badge('ready');
  await mixer(); await page.getByRole('button', { name: `Mute ${mainName}`, exact: true }).click();
  await badge('muted'); await screenshot('main-audio-sources-muted.png');
  health({ sources: { main: 'missing', backup: 'ready' } });
  let statusBadge = await badge('disconnected');
  assert.match(await statusBadge.getAttribute('title'), /also muted/i, 'Disconnection takes priority without losing saved mute context');
  await screenshot('main-audio-sources-disconnected.png');
  health({ sources: { main: 'error', backup: 'ready' }, sourceErrors: { main: 'This input has no audio track. Reconnect with audio enabled.' } });
  statusBadge = await badge('error');
  assert.match(await statusBadge.getAttribute('title'), /This input has no audio track/, 'Real source diagnostics remain available in the status tooltip');
  health({ sources: { main: 'ready', backup: 'ready' }, sourceErrors: {} });
  await badge('muted');
  await mixer(); await page.getByRole('button', { name: `Unmute ${mainName}`, exact: true }).click();
  await badge('ready');
  await page.getByRole('button', { name: 'Toggle master mute', exact: true }).click();
  await until(async () => (await get()).masterMuted, 'real final output mute saved');
  await badge('ready');
  health({ sources: { main: 'loading', backup: 'ready' } }); await badge('loading');
  health({ state: 'offline', sources: { main: 'missing', backup: 'missing' } }); await badge('offline');
  health({ state: 'running', sources: { main: 'ready', backup: 'ready' } }); await badge('ready');
  await page.setViewportSize({ width: 390, height: 844 });
  const inspector = page.getByRole('button', { name: 'Collapse inspector', exact: true });
  if (await inspector.isVisible()) await inspector.click();
  await mixer(); await page.getByRole('button', { name: `Mute ${mainName}`, exact: true }).click();
  await badge('muted'); await screenshot('main-audio-sources-muted-mobile.png');
  health({ sources: { main: 'missing', backup: 'ready' } });
  statusBadge = await badge('disconnected');
  const rowBounds = await sourceRow('main').boundingBox(), badgeBounds = await statusBadge.boundingBox();
  assert.ok(rowBounds.x >= 0 && rowBounds.x + rowBounds.width <= 390);
  assert.ok(badgeBounds.width > 80 && badgeBounds.x >= rowBounds.x && badgeBounds.x + badgeBounds.width <= rowBounds.x + rowBounds.width);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Long source names and disconnected labels fit at 390px');
  await screenshot('main-audio-sources-disconnected-mobile.png');
  health({ sources: { main: 'ready', backup: 'ready' } });
  await mixer(); await page.getByRole('button', { name: 'Set Backup feed as Main audio', exact: true }).click();
  await badge('ready', 'backup');
  assert.equal(await sourceRow('main').getByTestId('source-main-audio-badge').count(), 0);
  await mixer(); await page.getByRole('button', { name: 'Clear Main audio', exact: true }).click();
  await until(async () => (await get()).mainAudioSourceId === null, 'real clear persisted');
  await page.getByRole('button', { name: /^Sources/ }).click();
  assert.equal(await page.getByTestId('source-main-audio-badge').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, telemetry: 'Simulated read-only operator telemetry; real isolated station commands', checks: ['ready, muted, disconnected, error, connecting and offline states', 'disconnection priority over mute with tooltip context', 'real source diagnostics preserved', 'unmute and healthy-input recovery', 'final output mute independent of input status', 'read-only source badge; selection remains mixer-only', 'badge follows real selection and clear', 'long-name muted/disconnected labels fit 390px'] }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]);
}
