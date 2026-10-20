// Controller-local shortcuts against an isolated station. No physical inputs,
// operator data or existing browser sessions are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-scene-shortcuts-'));
const port = Number(process.env.LUMEN_SHORTCUT_TEST_PORT ?? 3431), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let logs = '', browser, page;
const server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const checks = [], errors = [];
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station ready', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const save = async mutate => { const state = await get(); mutate(state); const response = await request.put(`${base}/api/studio`, { data: state }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const command = async command => { const state = await get(), response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  assert.equal((await request.put(`${base}/api/content`, { data: { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [{ id: 'scripture', name: 'Scripture', kind: 'scripture', playlistId: 'scripture_list', defaultMode: 'manual' }, { id: 'lyrics', name: 'Lyrics', kind: 'lyrics', playlistId: 'lyrics_list', defaultMode: 'manual' }],
    playlists: [{ id: 'scripture_list', name: 'Scripture', items: [] }, { id: 'lyrics_list', name: 'Lyrics', items: [] }] } })).status(), 200);
  await save(state => {
    state.sources.push({ id: 'shortcut_scripture_source', name: 'Scripture content', kind: 'channel', channelId: 'scripture', loop: false,
      audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } });
    state.scenes = [{ id: 'shortcut_camera', name: 'Camera scene', background: '#123825', layers: [] }, { id: 'shortcut_scripture', name: 'Scripture scene', background: '#241843', layers: [
      { id: 'shortcut_scripture_layer', name: 'Scripture text', kind: 'source', sourceId: 'shortcut_scripture_source', visible: true, locked: false,
        x: 10, y: 20, width: 80, height: 60, opacity: 1, fit: 'contain', text: '', color: '#ffffff', background: '#00000000', fontSize: 60, fontWeight: 500, align: 'center', radius: 0, channelStyle: 'overlay' },
    ] }, { id: 'shortcut_unused', name: 'Unrelated Preview', background: '#25313c', layers: [] }];
    state.previewSceneId = 'shortcut_unused';
  });
  await command({ type: 'take', sceneId: 'shortcut_camera' });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const takeRequests = [];
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/studio/command')) return;
    const payload = request.postDataJSON();
    if (payload?.command?.type === 'take') takeRequests.push(payload.command);
  });
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  const dialog = page.getByTestId('scene-shortcuts-dialog');
  const row = id => dialog.locator(`[data-scene-shortcut="${id}"]`);
  const openDialog = async () => { await page.getByRole('button', { name: 'Scene shortcuts', exact: true }).click(); await dialog.waitFor(); };
  const closeDialog = async () => { await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); await page.evaluate(() => document.activeElement?.blur()); };
  const dispatch = async (code, patch = {}) => page.evaluate(({ code, patch }) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: code.replace(/^(Digit|Key)/, ''), code, ctrlKey: true, shiftKey: true, bubbles: true, ...patch })), { code, patch });
  const stable = async (revision, label) => { await page.waitForTimeout(200); assert.equal((await get()).revision, revision, label); };
  await openDialog();
  assert.equal(await dialog.locator('.scene-shortcut-record.assigned').count(), 0, 'No initial shortcuts');
  assert.equal(await page.evaluate(() => localStorage.getItem('lumen.studio.scene-shortcuts.v1')), null);
  const initial = await get();
  await row('shortcut_scripture').getByRole('button', { name: 'Record shortcut for Scripture scene', exact: true }).click();
  await page.keyboard.press('Control+Shift+r');
  await dialog.getByRole('alert').getByText(/reserved/).waitFor();
  assert.equal(await dialog.locator('.scene-shortcut-record.assigned').count(), 0, 'Reserved reload rejected');
  await page.keyboard.press('Control+Shift+1');
  await until(() => row('shortcut_scripture').locator('.assigned').count(), 'scripture binding saved');
  await row('shortcut_camera').getByRole('button', { name: 'Record shortcut for Camera scene', exact: true }).click();
  await page.keyboard.press('Control+Shift+1');
  await dialog.getByRole('alert').getByText(/Already assigned/).waitFor();
  await page.keyboard.press('Control+Shift+2');
  await until(() => row('shortcut_camera').locator('.assigned').count(), 'camera binding saved');
  await row('shortcut_scripture').getByLabel('Transition for Scripture scene', { exact: true }).selectOption('fade');
  await row('shortcut_scripture').getByLabel('Fade duration for Scripture scene', { exact: true }).fill('650');
  await row('shortcut_scripture').getByLabel('Fade duration for Scripture scene', { exact: true }).press('Tab');
  await page.screenshot({ path: path.join(dir, 'scene-shortcuts-desktop.png') });
  await closeDialog();
  await stable(initial.revision, 'Configuring shortcuts cannot Take or change Studio');
  await dispatch('Digit1'); await stable(initial.revision, 'Engine-off shortcut cannot Take');
  checks.push('unassigned defaults, reserved/duplicate rejection, Cut/Fade configuration and offline guard');

  assert.equal((await request.post(`${base}/api/studio/engine/start`, { timeout: 50000 })).status(), 200);
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).state === 'running', 'engine running', 50000);
  await page.locator('.engine-indicator').getByText('Engine running', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Lumen home', exact: true }).click();
  await page.getByRole('heading', { name: 'Find a passage' }).waitFor();
  const before = await get();
  await page.getByLabel('Search scripture', { exact: true }).focus();
  await page.keyboard.press('Control+Shift+1'); await stable(before.revision, 'Typing cannot Take a scene');
  await page.evaluate(() => document.activeElement?.blur());
  await dispatch('Digit1', { repeat: true }); await stable(before.revision, 'Repeated key cannot Take');
  await dispatch('Digit1');
  const scripture = await until(async () => { const state = await get(); return state.program?.id === 'shortcut_scripture' && state; }, 'Scripture workspace shortcut takes Studio scene');
  assert.equal(before.previewSceneId, 'shortcut_unused', 'Test starts with an unrelated Preview selection');
  assert.equal(scripture.previewSceneId, before.program.id, 'Direct Fade returns the former Program to Preview, not the unrelated selection');
  assert.equal(takeRequests.at(-1)?.swapPreview, true, 'Configured Fade requests the atomic bus swap');
  assert.deepEqual(scripture.scenes, before.scenes, 'Shortcut bus swaps preserve every editable draft');
  assert.equal(scripture.programTransition.kind, 'fade'); assert.equal(scripture.programTransition.durationMs, 650);
  for (const field of ['masterVolume', 'masterMuted', 'mainAudioSourceId', 'sources', 'outputs']) assert.deepEqual(scripture[field], before[field], `Scene shortcut preserves ${field}`);
  const live = await (await request.get(`${base}/api/worship/channels/scripture`)).json(); assert.equal(live.live, null, 'Scene shortcut cannot send a prepared channel cue');
  await dispatch('Digit2', { ctrlKey: false, metaKey: true });
  const camera = await until(async () => { const state = await get(); return state.program?.id === 'shortcut_camera' && state; }, 'Command modifier takes Camera from Scripture');
  assert.equal(camera.previewSceneId, scripture.program.id, 'Configured Cut returns the former Program to Preview');
  assert.equal(takeRequests.at(-1)?.swapPreview, true, 'Configured Cut requests the atomic bus swap');
  assert.equal(camera.programTransition.kind, 'cut');
  assert.deepEqual(camera.scenes, before.scenes, 'Configured Cut preserves every editable draft');
  checks.push('global Ctrl/Command Takes from Scripture, configured Cut/Fade swap former Program into Preview atomically, no cue publication or draft/output/audio edits');

  // Hold the publication POST before the server receives it. Taking the
  // Scripture scene now would expose the old cue unless local publication is
  // a separate guard from Studio's own write queue.
  await page.getByLabel('Search scripture', { exact: true }).fill('John 3:16');
  await until(() => page.locator('.w-verse-result').count(), 'verse result');
  await page.locator('.w-verse-result').first().click();
  await until(() => page.getByTestId('prepared-cue').textContent().then(text => text.includes('For God so loved')), 'prepared cue');
  const send = page.getByTestId('channel-send-live');
  await until(async () => !await send.isDisabled(), 'channel ready to publish');
  let releasePublication, publicationStarted;
  const heldPublication = new Promise(resolve => { releasePublication = resolve; });
  const enteredPublication = new Promise(resolve => { publicationStarted = resolve; });
  const hold = async route => { publicationStarted(); await heldPublication; await route.continue(); };
  await page.route('**/api/worship/channels/scripture/command', hold);
  await send.click(); await enteredPublication;
  const pending = await get();
  await dispatch('Digit1'); await stable(pending.revision, 'Pending Send live cannot be overtaken by the Scripture scene shortcut');
  assert.equal((await get()).program.id, 'shortcut_camera');
  assert.equal((await (await request.get(`${base}/api/worship/channels/scripture`)).json()).live, null, 'Pending publication has not committed old or prepared content');
  await page.getByText('Wait for Send live to finish, then try the scene shortcut again.', { exact: true }).waitFor();
  // An unrelated Camera scene remains available while Scripture publishes.
  await dispatch('Digit2');
  await until(async () => (await get()).programTransition.id !== pending.programTransition.id, 'unrelated Camera Take remains available');
  releasePublication();
  await until(async () => (await (await request.get(`${base}/api/worship/channels/scripture`)).json()).live?.selection.verse === 16, 'publication committed');
  await until(async () => !await send.isDisabled(), 'Send live completed');
  await page.unroute('**/api/worship/channels/scripture/command', hold);
  assert.equal((await get()).program.id, 'shortcut_camera', 'Completing publication never auto-Takes the deferred scene');
  await dispatch('Digit1');
  await until(async () => (await get()).program.id === 'shortcut_scripture', 'explicit retry Takes after publication');
  checks.push('delayed Send live cannot be overtaken by its scene shortcut; unrelated scenes work and explicit retry is required');

  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await openDialog(); assert.equal(await row('shortcut_scripture').getByLabel('Transition for Scripture scene', { exact: true }).inputValue(), 'fade');
  assert.equal(await row('shortcut_scripture').getByLabel('Fade duration for Scripture scene', { exact: true }).inputValue(), '650');
  const modal = await get(); await dispatch('Digit1'); await stable(modal.revision, 'Open dialog suppresses all scene shortcuts');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), 'Shortcut dialog fits phone width');
  await page.screenshot({ path: path.join(dir, 'scene-shortcuts-mobile.png') });
  await closeDialog(); await page.setViewportSize({ width: 1512, height: 982 });
  await save(state => { const scene = state.scenes.find(value => value.id === 'shortcut_scripture'); scene.name = 'Renamed scripture'; state.scenes.reverse(); });
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await page.evaluate(() => document.activeElement?.blur()); await dispatch('Digit1');
  await until(async () => (await get()).program?.name === 'Renamed scripture', 'Bindings survive rename, reorder and reload');
  const latest = await get();
  await page.evaluate(() => { const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.id = 'test-shortcut-menu'; document.body.append(menu); });
  await dispatch('Digit2'); await stable(latest.revision, 'Open menu suppresses scene shortcuts');
  await page.evaluate(() => document.getElementById('test-shortcut-menu').remove());
  await openDialog(); await row('shortcut_scripture').getByRole('button', { name: 'Clear shortcut for Renamed scripture', exact: true }).click();
  await closeDialog(); await dispatch('Digit1'); await stable(latest.revision, 'Cleared binding no longer Takes');
  await openDialog(); await dialog.getByRole('button', { name: 'Clear all', exact: true }).click();
  assert.equal(await dialog.locator('.assigned').count(), 0); await closeDialog();
  checks.push('reload/rename/reorder persistence, modal/menu safeguards, responsive configuration and clearing');

  // Deleted targets cannot silently retarget a different scene by list index.
  await page.evaluate(() => localStorage.setItem('lumen.studio.scene-shortcuts.v1', JSON.stringify([{ sceneId: 'missing_scene', code: 'Digit1', alt: false, transition: 'cut', durationMs: 300 }])));
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  const deleted = await get(); await dispatch('Digit1'); await stable(deleted.revision, 'Deleted scene binding ignored');
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(JSON.stringify({ ok: true, checks, artifacts: dir }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(dir, 'scene-shortcuts-failure.png'), fullPage: true }).catch(() => {});
  console.error(logs); throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
