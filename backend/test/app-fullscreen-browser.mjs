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
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await until(() => page.evaluate(() => document.fullscreenElement === document.documentElement), 'Studio enters fullscreen');

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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: ['Studio to channel retains fullscreen', 'F toggles from channel toolbar', 'channel to Studio retains fullscreen', 'either screen can exit fullscreen'] }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-5000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill('SIGTERM'); setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 6000).unref(); });
}
