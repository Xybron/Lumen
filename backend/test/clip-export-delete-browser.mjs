// Export deletion runs against an isolated station, never operator data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-export-delete-'));
const port = Number(process.env.LUMEN_EXPORT_DELETE_TEST_PORT ?? 3492), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let server, browser, admin, owner, teammate, page, logs = '';
async function until(fn, label, timeout = 15000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { if (await fn()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function start() {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station starts');
}
async function stop() {
  const current = server; if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise(resolve => { current.once('exit', resolve); current.kill('SIGTERM'); setTimeout(() => { if (current.exitCode === null) current.kill('SIGKILL'); }, 6000).unref(); });
}
async function login(context, username, password) {
  const response = await context.request.post(`${base}/api/auth/login`, { data: { username, password } });
  assert.equal(response.status(), 200, await response.text());
  return (await response.json()).user;
}
async function exists(file) { return fs.stat(file).then(() => true, () => false); }
async function workspace(context) { return (await context.request.get(`${base}/api/clips`)).json(); }
try {
  await start();
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  admin = await browser.newContext(); owner = await browser.newContext({ viewport: { width: 1512, height: 982 } }); teammate = await browser.newContext();
  await login(admin, 'admin', 'admin');
  for (const username of ['exportowner', 'exportother']) {
    const response = await admin.request.post(`${base}/api/users`, { data: { username, displayName: username, password: 'test-export-password' } });
    assert.equal(response.status(), 200, await response.text());
  }
  const ownerUser = await login(owner, 'exportowner', 'test-export-password');
  const otherUser = await login(teammate, 'exportother', 'test-export-password');
  await stop();

  const now = '2026-10-19T09:00:00.000Z';
  const settings = { inMs: 0, outMs: 15000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5 };
  const draft = { id: 'clip_export_fixture', recordingId: 'rec_export_fixture', name: 'Saved project', revision: 1,
    ownerId: ownerUser.id, ownerName: ownerUser.displayName, createdAt: now, updatedAt: now, ...settings };
  const jobs = [
    { id: 'export_single', name: 'Single export', ownerId: ownerUser.id, status: 'complete' },
    { id: 'export_selected_a', name: 'Selected export A', ownerId: ownerUser.id, status: 'complete' },
    { id: 'export_selected_b', name: 'Selected export B', ownerId: ownerUser.id, status: 'queued' },
    { id: 'export_other', name: 'Other member export', ownerId: otherUser.id, status: 'complete' },
  ].map(job => ({ ...job, draftId: draft.id, draftRevision: draft.revision, recordingId: draft.recordingId,
    progress: job.status === 'complete' ? 1 : 0, bytes: 19, createdAt: now, completedAt: now, settings }));
  await fs.writeFile(path.join(dir, 'clips', 'clips.json'), JSON.stringify({ version: 1, drafts: [draft], exports: jobs, media: {} }));
  await fs.mkdir(path.join(dir, 'clips', 'exports'), { recursive: true });
  for (const job of jobs) {
    await fs.writeFile(path.join(dir, 'clips', 'exports', `${job.id}.mp4`), 'saved export file');
    if (job.id === 'export_single') await fs.writeFile(path.join(dir, 'clips', 'exports', `${job.id}.thumbnail.jpg`), 'saved export poster');
  }
  await fs.mkdir(path.join(dir, 'recordings', draft.recordingId), { recursive: true });
  await fs.writeFile(path.join(dir, 'recordings', draft.recordingId, 'recording.webm'), 'original recording');
  await start();
  await login(owner, 'exportowner', 'test-export-password');
  await login(teammate, 'exportother', 'test-export-password');

  const endpoint = `${base}/api/clips/exports`;
  assert.equal((await teammate.request.delete(endpoint, { data: { ids: ['export_single'] } })).status(), 403, 'Another member cannot delete an export');
  assert.equal((await owner.request.delete(endpoint, { data: { ids: ['export_single', 'export_other'] } })).status(), 403, 'Mixed ownership cannot partly delete');
  assert.equal((await owner.request.delete(endpoint, { data: { ids: ['export_single'], path: '/tmp/other' } })).status(), 422, 'Extra file paths are rejected');
  assert.equal((await workspace(owner)).exports.length, 4, 'Rejected deletions leave all exports');

  page = await owner.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/recordings?collection=exports`);
  const single = page.getByTestId('export-card').filter({ hasText: 'Single export' }); await single.waitFor();
  const other = page.getByTestId('export-card').filter({ hasText: 'Other member export' });
  assert.equal(await other.getByRole('checkbox').count(), 0, 'Other member export cannot be selected');
  assert.equal(await other.getByRole('button', { name: 'Actions for export Other member export' }).count(), 0, 'Other member has no delete menu');
  await single.getByRole('button', { name: 'Actions for export Single export' }).click();
  await page.getByRole('menuitem', { name: 'Delete export' }).click();
  let dialog = page.getByRole('dialog', { name: 'Delete export?' }); await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await workspace(owner)).exports.length, 4, 'Confirmation cancel retains export');
  await single.getByRole('button', { name: 'Actions for export Single export' }).click();
  await page.getByRole('menuitem', { name: 'Delete export' }).click();
  dialog = page.getByRole('dialog', { name: 'Delete export?' });
  await dialog.getByRole('button', { name: 'Delete export', exact: true }).click();
  await until(async () => await single.count() === 0, 'single export disappears');
  assert.equal(await exists(path.join(dir, 'clips', 'exports', 'export_single.mp4')), false, 'Export artifact removed');
  assert.equal(await exists(path.join(dir, 'clips', 'exports', 'export_single.thumbnail.jpg')), false, 'Export poster removed');

  for (const name of ['Selected export A', 'Selected export B']) await page.getByRole('checkbox', { name: `Select export ${name}` }).check();
  await page.getByRole('button', { name: 'Delete selected (2)' }).click();
  dialog = page.getByRole('dialog', { name: 'Delete selected exports?' });
  await dialog.getByRole('button', { name: 'Delete 2 exports' }).click();
  await until(async () => (await workspace(owner)).exports.length === 1, 'selected exports disappear');
  assert.deepEqual((await workspace(owner)).exports.map(job => job.id), ['export_other'], 'Only selected exports were deleted');
  await until(async () => !await exists(path.join(dir, 'clips', 'exports', 'export_selected_a.mp4')) && !await exists(path.join(dir, 'clips', 'exports', 'export_selected_b.mp4')), 'selected export files removed');

  const adminPage = await admin.newPage(); await adminPage.goto(`${base}/recordings?collection=exports`);
  await adminPage.getByTestId('export-card').filter({ hasText: 'Other member export' }).waitFor();
  await adminPage.getByRole('button', { name: 'Delete all exports' }).click();
  dialog = adminPage.getByRole('dialog', { name: 'Delete all exports?' });
  await dialog.getByRole('button', { name: 'Delete export', exact: true }).click();
  await until(async () => (await workspace(admin)).exports.length === 0, 'all remaining exports disappear');
  assert.equal(await exists(path.join(dir, 'clips', 'exports', 'export_other.mp4')), false);
  assert.equal((await workspace(owner)).drafts.length, 1, 'Saved project remains');
  assert.equal(await exists(path.join(dir, 'recordings', draft.recordingId, 'recording.webm')), true, 'Original recording remains');
  await stop(); await start(); await login(owner, 'exportowner', 'test-export-password');
  assert.equal((await workspace(owner)).exports.length, 0, 'Deletion survives restart');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: ['owner permissions and atomic validation', 'single export and confirmation', 'selected exports', 'all exports', 'artifacts and posters removed', 'project and recording retained', 'durable restart'] }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-5000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally { await browser?.close(); await stop(); }
