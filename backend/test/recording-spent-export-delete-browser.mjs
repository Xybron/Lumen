// A delivered temporary export must not pin its original recording forever.
// This test uses an isolated station and never opens operator data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { ContentSchema } = await import('../dist/schema.js');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-spent-export-clear-'));
const port = Number(process.env.LUMEN_SPENT_EXPORT_TEST_PORT ?? 3493), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
const none = () => ({ bibles: [], songs: [], presentations: [], media: [], scenes: [], recordings: [], setlists: [], clips: [], settings: false });
let server, browser, admin, logs = '';
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
async function post(endpoint, data) {
  const response = await admin.request.post(`${base}/api/${endpoint}`, { data });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function exists(file) { return fs.stat(file).then(() => true, () => false); }
try {
  await start();
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  admin = await browser.newContext();
  await post('auth/login', { username: 'admin', password: 'admin' });
  await stop();

  const now = '2026-10-19T09:00:00.000Z', settings = { inMs: 0, outMs: 15000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5 };
  const content = ContentSchema.parse({ version: 2, updatedAt: now, settings: {}, music: { mode: 'off' },
    playlists: [], channels: [], sources: [], destinations: [], routes: [], program: { programSourceId: null, previewSourceId: null } });
  await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify(content));
  const recordingDir = path.join(dir, 'recordings');
  for (const id of ['rec_spent', 'rec_retained']) {
    const folder = path.join(recordingDir, id); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'recording.webm'), 'synthetic recording');
    await fs.writeFile(path.join(folder, 'recording.json'), JSON.stringify({ id, name: id, status: 'complete', createdAt: now, durationMs: 15000, bytes: 19, nextChunk: 0 }));
  }
  const draft = { ...settings, id: 'clip_retained', recordingId: 'rec_retained', name: 'Retained project', revision: 0,
    ownerId: 'usr_fixture', ownerName: 'Fixture editor', createdAt: now, updatedAt: now };
  const spent = { id: 'export_spent', draftId: 'clip_deleted', draftRevision: 0, recordingId: 'rec_spent',
    name: 'Delivered temporary export', ownerId: 'usr_fixture', status: 'complete', progress: 1, bytes: 19,
    createdAt: now, completedAt: now, deliveredAt: now, temporary: true, settings };
  const retained = { ...spent, id: 'export_retained', draftId: draft.id, recordingId: 'rec_retained',
    name: 'Retained saved export', temporary: false, deliveredAt: undefined };
  delete retained.deliveredAt;
  await fs.writeFile(path.join(dir, 'clips', 'clips.json'), JSON.stringify({ version: 1, drafts: [draft], exports: [spent, retained],
    media: { rec_spent: { durationMs: 15000, width: 1920, height: 1080 } } }));
  await fs.mkdir(path.join(dir, 'clips', 'exports'), { recursive: true });
  await fs.writeFile(path.join(dir, 'clips', 'exports', 'export_retained.mp4'), 'retained export');
  await start();
  await post('auth/login', { username: 'admin', password: 'admin' });

  const blocked = await post('data-transfer/clear/preview', { selection: { ...none(), recordings: ['rec_retained'] } });
  assert.match(blocked.blockers.join(' '), /saved project or export/i, 'A usable saved project/export still blocks deletion');
  const review = await post('data-transfer/clear/preview', { selection: { ...none(), recordings: ['rec_spent'] } });
  assert.deepEqual(review.blockers, [], 'Delivered temporary export does not block its original');
  const cleared = await post('data-transfer/clear', { token: review.token, confirmation: 'CLEAR' });
  assert.equal(cleared.removed.recordings, 1);
  assert.equal(await exists(path.join(recordingDir, 'rec_spent')), false, 'Selected recording moved to backup');
  assert.equal(await exists(path.join(recordingDir, 'rec_retained')), true, 'Other recording remains');
  assert.equal(await exists(path.join(dir, 'clips', 'exports', 'export_retained.mp4')), true, 'Retained saved export remains');
  assert.ok(cleared.backupPath.startsWith(dir + path.sep));
  assert.equal(await exists(path.join(cleared.backupPath, 'removed')), true, 'Recovery backup exists');
  const workspace = await (await admin.request.get(`${base}/api/clips`)).json();
  assert.deepEqual(workspace.exports.map(job => job.id), ['export_retained'], 'Spent hidden metadata is pruned');
  assert.equal(workspace.drafts.length, 1, 'Retained project remains');
  assert.equal(workspace.recordings.some(recording => recording.id === 'rec_spent'), false);
  await stop(); await start(); await post('auth/login', { username: 'admin', password: 'admin' });
  const durable = await (await admin.request.get(`${base}/api/clips`)).json();
  assert.deepEqual(durable.exports.map(job => job.id), ['export_retained'], 'Cleanup persists across restart');
  console.log(JSON.stringify({ result: 'PASS', checks: ['spent temporary export does not block recording', 'usable project/export still blocks', 'recording and stale metadata cleared with backup', 'other recording and export preserved', 'durable restart'] }, null, 2));
} catch (error) {
  console.error(error); console.error(logs.slice(-5000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally { await browser?.close(); await stop(); }
