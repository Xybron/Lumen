// Fullscreen must belong to the app, not to a route that unmounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-app-fullscreen-'));
const port = Number(process.env.LUMEN_FULLSCREEN_TEST_PORT ?? 3494), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let browser, page, server, logs = '';
async function until(fn, label, timeout = 15000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { if (await fn()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station starts');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } });
  assert.equal(login.status(), 200, await login.text());
  page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/studio`);
  await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  assert.ok((await context.request.post(`${base}/api/studio/engine/start`)).ok());
  const preview = page.locator('.preview-panel'), previewButton = preview.getByRole('button', { name: 'Fullscreen Preview', exact: true });
  await until(() => preview.locator('video').evaluate(video => video.videoWidth > 0 && video.readyState >= 2), 'Preview receives a live picture');
  await preview.locator('video').evaluate(video => { window.originalPreviewStream = video.srcObject; });
  const initialProgram = (await (await context.request.get(`${base}/api/studio`)).json()).program;
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await until(() => page.evaluate(() => document.fullscreenElement === document.documentElement), 'Studio enters fullscreen');
  await previewButton.click();
  await until(() => preview.evaluate(panel => document.fullscreenElement === panel), 'Preview fills the screen inside app fullscreen');
  const size = await preview.locator('.monitor-frame').boundingBox();
  assert.ok(size.width > 1000 && Math.abs(size.width / size.height - 16 / 9) < .015, 'Large picture preserves its aspect ratio');
  assert.equal(await preview.locator('video').evaluate(video => video.srcObject === window.originalPreviewStream && !video.paused), true, 'Fullscreen uses the same playing feed');
  await page.keyboard.press('Tab');
  assert.equal(await preview.evaluate(panel => panel.contains(document.activeElement)), true, 'Preview focus stays away from live controls');
  await preview.getByRole('button', { name: 'Exit Preview fullscreen' }).click();
  await until(() => page.evaluate(() => document.fullscreenElement === document.documentElement), 'Closing Preview restores fullscreen Studio');
  assert.deepEqual((await (await context.request.get(`${base}/api/studio`)).json()).program, initialProgram);

  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByRole('menuitem', { name: 'Presentation' }).click();
  await until(() => new URL(page.url()).pathname === '/', 'channel opens in the same tab');
  assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true, 'Fullscreen survives Studio to channel navigation');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).waitFor();
  await page.getByRole('button', { name: /Presentation — presentation/ }).focus();
  await page.keyboard.press('f');
  await until(() => page.evaluate(() => document.fullscreenElement === null), 'F exits fullscreen from focused channel toolbar');
  await page.keyboard.press('f');
  await until(() => page.evaluate(() => document.fullscreenElement === document.documentElement), 'F enters fullscreen from channel');

  await page.getByRole('button', { name: 'Open Production Studio' }).click();
  await until(() => new URL(page.url()).pathname === '/studio', 'return to Studio');
  await until(() => page.evaluate(() => document.fullscreenElement === document.documentElement), 'Fullscreen survives channel to Studio navigation');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await until(() => page.evaluate(() => document.fullscreenElement === null), 'Studio button exits fullscreen entered on channel');
  await previewButton.click(); await preview.getByRole('button', { name: 'Exit Preview fullscreen' }).waitFor();
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => document.fullscreenElement === null), 'Escape returns to the docked Preview');

  // Simulate station reports only; this fixture never connects to a streaming platform.
  const snapshot = await (await context.request.get(`${base}/api/studio/broadcast`)).json();
  const session = snapshot.session = { id: 'notice-test', profile: '720p', state: 'live', startedAt: new Date().toISOString(),
    chunks: 1, bytes: 1, destinations: ['youtube', 'facebook'].map(id => ({ id, state: 'live', retries: 0, bytes: 1 })),
    watch: { id: 'watch', state: 'disabled', bytes: 0, retries: 0 } };
  let offline = false;
  await page.route('**/api/studio/broadcast', route => offline ? route.abort('failed') : route.fulfill({ json: snapshot }));
  const refresh = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refresh();
  await page.locator('.broadcast-trigger').getByText('Live controls').waitFor();
  await previewButton.click();
  session.destinations[0].state = 'retrying'; session.destinations[0].retries = 1;
  const alert = preview.locator('.stream-alert');
  await alert.getByText(/YouTube is reconnecting.*Facebook/).waitFor(); // picked up by normal polling
  await alert.getByRole('button', { name: 'Stream controls' }).click();
  const panel = page.getByRole('dialog', { name: 'Go Live', exact: true });
  await panel.locator('.broadcast-notice-inline').getByText(/YouTube is reconnecting/).waitFor();
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  await panel.getByRole('button', { name: 'Close Go Live controls' }).click();
  const banner = page.locator('.stream-alert');
  await banner.getByRole('button', { name: 'Dismiss stream notice' }).click();
  await refresh();
  await page.locator('.broadcast-trigger').getByText('Reconnecting').waitFor();
  assert.equal(await banner.count(), 0, 'Acknowledged retry stays in the header without repeating the banner');
  session.destinations[0].state = 'live';
  await refresh(); await banner.getByText('Connection restored').waitFor();
  offline = true;
  await refresh(); await banner.getByText('Stream status unknown').waitFor();
  offline = false; session.state = 'error';
  await refresh(); await banner.getByText('Stream interrupted').waitFor();
  const viewer = await context.newPage();
  await viewer.goto(`${base}/studio/output/program`);
  assert.equal(await viewer.locator('.stream-alert').count(), 0, 'Operator notices do not appear on the public output');
  await viewer.close();
  await context.request.post(`${base}/api/studio/engine/stop`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: ['Preview enlarges the existing live feed and restores fullscreen Studio', 'channel navigation preserves app fullscreen', 'destination loss, recovery, station offline and terminal stream alerts', 'fullscreen alerts open controls, dismissal retains header status'] }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-5000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill('SIGTERM'); setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 6000).unref(); });
}
