// Recording deletion and storage location use a disposable station only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-recording-library-'));
await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify({
  version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 300, fontFamily: 'Inter' },
  music: { mode: 'off' }, playlists: [], channels: [], sources: [], destinations: [], routes: [],
  program: { programSourceId: null, previewSourceId: null },
}));
const recordingId = 'rec_storage_test';
const recordingDir = path.join(dir, 'recordings', recordingId);
await fs.mkdir(recordingDir, { recursive: true });
await fs.writeFile(path.join(recordingDir, 'recording.json'), JSON.stringify({
  id: recordingId, name: 'Storage test recording', status: 'interrupted', createdAt: new Date().toISOString(),
  durationMs: 1000, bytes: 4, nextChunk: 0, error: 'Test recording',
}));
await fs.writeFile(path.join(recordingDir, '00000000.part'), 'test');
const port = Number(process.env.LUMEN_RECORDING_LIBRARY_TEST_PORT ?? 3471), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page;
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => { logs += chunk; });
server.stderr.on('data', chunk => { logs += chunk; });
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station ready', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const request = context.request;
  const login = await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } });
  assert.equal(login.status(), 200, await login.text());
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${base}/recordings`);
  await page.getByTestId('recording-card').waitFor();
  await page.getByRole('button', { name: 'Storage', exact: true }).click();
  const storage = page.getByRole('dialog', { name: 'Recording storage' });
  await storage.waitFor();
  await until(async () => (await storage.textContent()).includes(path.join(dir, 'recordings')), 'exact station recording folder');
  assert.match(await storage.textContent(), /LUMEN_DATA_DIR/);
  await storage.getByRole('button', { name: 'Close storage details' }).click();
  await page.getByRole('button', { name: 'Actions for recording Storage test recording' }).click();
  const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/data-transfer/clear/preview'));
  await page.getByRole('menuitem', { name: 'Delete recording' }).click();
  const reviewResponse = await previewResponse;
  assert.equal(reviewResponse.status(), 200, await reviewResponse.text());
  assert.deepEqual((await reviewResponse.json()).blockers, []);
  const confirmation = page.getByRole('dialog', { name: 'Delete recording?' });
  await confirmation.waitFor();
  assert.match(await confirmation.textContent(), /recovery copy stays in station backups/i);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await request.get(`${base}/api/studio/recordings`)).status(), 200);
  assert.equal((await (await request.get(`${base}/api/studio/recordings`)).json()).length, 1);
  await page.getByRole('button', { name: 'Actions for recording Storage test recording' }).click();
  await page.getByRole('menuitem', { name: 'Delete recording' }).click();
  await confirmation.getByRole('button', { name: 'Delete recording', exact: true }).click();
  await until(async () => (await (await request.get(`${base}/api/studio/recordings`)).json()).length === 0, 'recording removed');
  await until(async () => (await page.getByTestId('recording-card').count()) === 0, 'library refresh');
  await assert.rejects(fs.stat(recordingDir), { code: 'ENOENT' });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: ['storage folder shown', 'cancel keeps recording', 'confirmed removal updates library and moves recording to backup'] }));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
}
