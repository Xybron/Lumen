// Isolated project deletion: no operator recordings or real station data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-project-delete-'));
const port = Number(process.env.LUMEN_PROJECT_DELETE_TEST_PORT ?? 3491), base = `http://127.0.0.1:${port}`;
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
try {
  await start();
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  admin = await browser.newContext(); owner = await browser.newContext({ viewport: { width: 1512, height: 982 } }); teammate = await browser.newContext();
  await login(admin, 'admin', 'admin');
  for (const username of ['projectowner', 'projectother']) {
    const response = await admin.request.post(`${base}/api/users`, { data: { username, displayName: username, password: 'test-project-password' } });
    assert.equal(response.status(), 200, await response.text());
  }
  const ownerUser = await login(owner, 'projectowner', 'test-project-password');
  const otherUser = await login(teammate, 'projectother', 'test-project-password');
  await stop();

  const now = '2026-10-19T09:00:00.000Z';
  const settings = { inMs: 0, outMs: 15000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5 };
  const mine = { id: 'clip_delete_me', recordingId: 'rec_delete_fixture', name: 'Super Test', revision: 2,
    ownerId: ownerUser.id, ownerName: ownerUser.displayName, createdAt: now, updatedAt: now, ...settings };
  const others = { ...mine, id: 'clip_keep_other', name: 'Other project', revision: 0, ownerId: otherUser.id, ownerName: otherUser.displayName };
  const exported = { id: 'export_keep', draftId: mine.id, draftRevision: 1, recordingId: mine.recordingId,
    name: mine.name, ownerId: ownerUser.id, status: 'complete', progress: 1, bytes: 19, createdAt: now, completedAt: now, settings };
  await fs.writeFile(path.join(dir, 'clips', 'clips.json'), JSON.stringify({ version: 1, drafts: [mine, others], exports: [exported], media: {} }));
  await fs.mkdir(path.join(dir, 'clips', 'exports'), { recursive: true });
  await fs.writeFile(path.join(dir, 'clips', 'exports', 'export_keep.mp4'), 'export stays intact');
  await fs.mkdir(path.join(dir, 'recordings', 'rec_delete_fixture'), { recursive: true });
  await fs.writeFile(path.join(dir, 'recordings', 'rec_delete_fixture', 'recording.webm'), 'original stays intact');
  await start();
  await login(owner, 'projectowner', 'test-project-password');
  await login(teammate, 'projectother', 'test-project-password');
  const endpoint = `${base}/api/clips/drafts/${mine.id}`;
  assert.equal((await teammate.request.delete(endpoint, { data: { revision: mine.revision } })).status(), 403, 'Another teammate cannot delete the project');
  assert.equal((await owner.request.delete(endpoint, { data: { revision: mine.revision - 1 } })).status(), 409, 'Stale revision cannot delete newer work');
  assert.equal((await owner.request.delete(endpoint, { data: { revision: mine.revision, path: '/tmp/other' } })).status(), 422, 'Extra file paths are rejected');

  page = await owner.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/recordings?collection=mine`);
  const card = page.getByTestId('project-card').filter({ hasText: mine.name }); await card.waitFor();
  async function openDelete() {
    await card.getByRole('button', { name: `Actions for project ${mine.name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete project', exact: true }).click();
    return page.getByRole('dialog', { name: 'Delete project?', exact: true });
  }
  let dialog = await openDelete(); await dialog.waitFor();
  assert.match(await dialog.innerText(), /original recording and existing exports will stay available/i);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await owner.request.get(`${base}/api/clips`).then(response => response.json())).drafts.some(draft => draft.id === mine.id), true, 'Cancel retains the project');
  dialog = await openDelete(); await dialog.getByRole('button', { name: 'Delete project', exact: true }).click();
  await until(async () => await card.count() === 0, 'project disappears from My projects');
  const workspace = await (await owner.request.get(`${base}/api/clips`)).json();
  assert.deepEqual(workspace.drafts.map(draft => draft.id), [others.id], 'Only the chosen project is removed');
  assert.equal(workspace.exports.some(job => job.id === exported.id), true, 'Existing export remains');
  assert.equal((await owner.request.delete(endpoint, { data: { revision: mine.revision } })).status(), 404, 'Removed project cannot be deleted again');
  await page.goto(`${base}/recordings?collection=exports`);
  const exportCard = page.getByTestId('export-card').filter({ hasText: mine.name }); await exportCard.waitFor();
  assert.equal(await exportCard.getByRole('link', { name: `Open project for ${mine.name}` }).count(), 0, 'Export has no broken project link');
  await page.goto(`${base}/recordings?collection=team`);
  const teamCard = page.getByTestId('project-card').filter({ hasText: others.name }); await teamCard.waitFor();
  await teamCard.getByRole('button', { name: `Actions for project ${others.name}`, exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Delete project', exact: true }).count(), 0, 'Teammate menu has no delete action');
  await stop(); await start();
  await login(owner, 'projectowner', 'test-project-password');
  const durable = await (await owner.request.get(`${base}/api/clips`)).json();
  assert.deepEqual(durable.drafts.map(draft => draft.id), [others.id], 'Deletion persists across restart');
  assert.equal(durable.exports.length, 1);
  assert.equal(await fs.readFile(path.join(dir, 'clips', 'exports', 'export_keep.mp4'), 'utf8'), 'export stays intact');
  assert.equal(await fs.readFile(path.join(dir, 'recordings', 'rec_delete_fixture', 'recording.webm'), 'utf8'), 'original stays intact');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: ['owner-only delete', 'revision guard', 'confirmation cancel and delete', 'one project removed', 'export and original preserved', 'no broken export link', 'durable restart'], directory: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-5000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally { await browser?.close(); await stop(); }
