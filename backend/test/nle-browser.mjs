// An isolated post-production station with generated picture and tones only.
// No physical capture devices, user recordings, or running Lumen station are used.
// Run after the integrated build: node backend/test/nle-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-nle-'));
const port = Number(process.env.LUMEN_NLE_TEST_PORT ?? 3463), base = `http://127.0.0.1:${port}`;
const recordingId = 'rec_nle_fixture', recordingName = 'Sunday service rehearsal';
const original = path.join(directory, 'recordings', recordingId, 'recording.webm');
const importedVideo = path.join(directory, 'Welcome ending.mp4'), importedImage = path.join(directory, 'Church logo.png'), importedAudio = path.join(directory, 'Music bed.wav');
const errors = [], studioMutations = [], clipMutations = [], checks = [];
let browser, server, page, teammate, secondTeammate, admin, anonymous, logs = '';
console.log(JSON.stringify({ phase: 'starting', directory, port }));
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });

async function until(fn, label, timeout = 20000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }), output = [], diagnostics = [];
    child.stdout.on('data', data => output.push(data)); child.stderr.on('data', data => diagnostics.push(data));
    child.once('error', reject); child.once('close', code => code === 0 ? resolve({ output: Buffer.concat(output), diagnostics: Buffer.concat(diagnostics).toString() }) : reject(new Error(Buffer.concat(diagnostics).toString())));
  });
}
async function startServer() {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'disposable station starts', 30000);
}
async function stopServer() {
  const child = server; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 6500).unref(); });
}
async function json(response, expected = 200) { assert.equal(response.status(), expected, await response.text()); return response.json(); }
const workspace = async (request = teammate.request) => json(await request.get(`${base}/api/clips`));
const production = async () => json(await admin.request.get(`${base}/api/studio`));
const engineStatus = async () => json(await admin.request.get(`${base}/api/studio/status`));
const input = draft => Object.fromEntries(['name', 'inMs', 'outMs', 'format', 'fit', 'positionX', 'positionY', 'timeline'].filter(key => draft[key] !== undefined).map(key => [key, draft[key]]));
function monitorPage(target) {
  target.setDefaultTimeout(15000);
  target.on('pageerror', error => errors.push(error.message));
  target.on('dialog', async dialog => { errors.push(`Unexpected native ${dialog.type()}`); await dialog.dismiss(); });
  target.on('request', request => {
    if (!['PUT', 'POST', 'DELETE'].includes(request.method())) return;
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/studio')) studioMutations.push(`${request.method()} ${pathname}`);
    if (pathname.startsWith('/api/clips')) clipMutations.push(`${request.method()} ${pathname}`);
  });
}
async function fill(label, value) { const control = page.getByLabel(label, { exact: true }); await control.fill(String(value)); await control.press('Tab'); }
async function saveDraft() { await page.getByRole('button', { name: 'Save draft', exact: true }).click(); return until(async () => { const id = new URL(page.url()).searchParams.get('draft'), saved = (await workspace()).drafts.find(item => item.id === id); return saved && await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled() && await page.locator('.clips-draft-state').innerText() === 'Saved' && saved; }, 'timeline acknowledges saved revision'); }
async function startDefaultExport() {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your edit', exact: true }); await dialog.waitFor();
  await dialog.getByLabel('Export file format', { exact: true }).selectOption('mp4');
  await dialog.getByLabel('Export resolution', { exact: true }).selectOption('1080p');
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
}
async function dismissRecoveredDeliveries(ids) {
  for (const id of ids) {
    const card = page.locator(`[data-testid="export-progress-card"][data-job-id="${id}"]`);
    await card.waitFor();
    await card.getByRole('button', { name: /^Dismiss export / }).click();
  }
}
async function scrubGeometry() {
  return page.locator('.nle-ruler').evaluate(element => {
    // Read the scale from the actual labelled ruler rather than mirroring the
    // component's zoom formula. This catches coordinate mistakes after scroll.
    const tick = [...element.querySelectorAll('.nle-ruler-tick')].find(item => Number.parseFloat(item.style.left) > 0);
    if (!(tick instanceof HTMLElement)) throw new Error('A labelled ruler tick is required.');
    const parts = (tick.textContent ?? '').trim().split(':').map(Number);
    const timeMs = parts.reduce((total, part) => total * 60 + part, 0) * 1000;
    const rect = element.getBoundingClientRect(), viewport = element.closest('.nle-timeline-scroll');
    return { x: rect.left, y: rect.top + rect.height / 2, scale: Number.parseFloat(tick.style.left) / timeMs, scrollLeft: viewport?.scrollLeft ?? 0 };
  });
}
async function assertSeek(ms, label) {
  await until(async () => {
    const clock = await page.locator('.nle-player-time').evaluate(element => element.textContent?.match(/^\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)?.slice(1).map(Number));
    const media = await page.getByTestId('clip-preview').locator('video').first().evaluate(video => ({ time: video.currentTime * 1000, ready: video.readyState >= 2 && !video.seeking, paused: video.paused }));
    const clockMs = clock && (clock[0] * 3600 + clock[1] * 60 + clock[2]) * 1000;
    return clockMs !== undefined && Math.abs(clockMs - ms) <= 80 && media.ready && media.paused && Math.abs(media.time - ms) <= 100;
  }, `${label}: clock and decoded video seek to ${ms} ms`);
}
async function completedExport(id) { return until(async () => { const job = (await workspace()).exports.find(item => item.id === id); assert.notEqual(job?.status, 'error', job?.error); return job?.status === 'complete' && job; }, 'MP4 compositor completes', 120000); }
async function decodeExport(job, width, height, seconds) {
  const response = await teammate.request.get(`${base}/api/clips/exports/${job.id}/download`);
  assert.equal(response.status(), 200, await response.text()); assert.match(response.headers()['content-disposition'] ?? '', /attachment/);
  const filename = path.join(directory, `${job.id}.mp4`); await fs.writeFile(filename, await response.body());
  const decoded = await runFfmpeg(['-hide_banner', '-i', filename, '-t', '0.15', '-f', 'null', '-']);
  assert.match(decoded.diagnostics, /Video: h264/); assert.match(decoded.diagnostics, /yuv420p/); assert.match(decoded.diagnostics, /Audio: aac/);
  assert.match(decoded.diagnostics, new RegExp(`\\b${width}x${height}\\b`));
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(decoded.diagnostics); assert.ok(duration);
  const measured = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]); assert.ok(Math.abs(measured - seconds) < .25, `Duration ${measured} should be ${seconds}`);
  const audio = await runFfmpeg(['-hide_banner', '-i', filename, '-t', '0.5', '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(audio.diagnostics); assert.ok(peak && Number(peak[1]) > -40, 'Export retains audible source audio');
  return filename;
}

try {
  await fs.mkdir(path.dirname(original), { recursive: true });
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=24,drawbox=x=0:y=0:w=213:h=360:color=blue:t=fill,drawbox=x=427:y=0:w=213:h=360:color=green:t=fill', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-threads', '2', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '250k', '-c:a', 'libopus', original]);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=640x360:r=24', '-t', '2', '-threads', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', importedVideo]);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '2', '-c:a', 'pcm_s16le', importedAudio]);
  await sharp({ create: { width: 160, height: 90, channels: 4, background: '#00ff00' } }).png().toFile(importedImage);
  await fs.mkdir(path.join(directory, 'media', 'music'), { recursive: true });
  await fs.copyFile(importedAudio, path.join(directory, 'media', 'music', 'persistent-main.wav'));
  const originalBytes = await fs.readFile(original), originalHash = createHash('sha256').update(originalBytes).digest('hex');
  await fs.writeFile(path.join(path.dirname(original), 'recording.json'), JSON.stringify({ id: recordingId, name: recordingName, status: 'complete', createdAt: '2026-10-18T08:00:00.000Z', durationMs: 12000, bytes: originalBytes.length, nextChunk: 1 }));
  await startServer();
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  admin = await browser.newContext(); teammate = await browser.newContext({ viewport: { width: 1512, height: 982 } }); secondTeammate = await browser.newContext(); anonymous = await browser.newContext();
  await Promise.all([teammate, secondTeammate].map(context => context.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); })));
  await json(await admin.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  for (const [context, username, displayName] of [[teammate, 'nleeditor', 'Content team'], [secondTeammate, 'nleother', 'Second teammate']]) {
    await json(await admin.request.post(`${base}/api/users`, { data: { username, displayName, password: 'test-editor-password' } }));
    const login = await json(await context.request.post(`${base}/api/auth/login`, { data: { username, password: 'test-editor-password' } })); assert.deepEqual(login.grants, []);
  }
  const fixture = await production(); fixture.sources.push({ id: 'nle_main', name: 'Persistent service audio', kind: 'audio', url: 'media/music/persistent-main.wav', loop: true, audio: { muted: true, volume: .6, mode: 'follow', delayMs: 30 } }); fixture.masterVolume = .7; fixture.masterMuted = false;
  await json(await admin.request.put(`${base}/api/studio`, { data: fixture }));
  async function studioCommand(command) { const document = await production(); return json(await admin.request.post(`${base}/api/studio/command`, { data: { revision: document.revision, command } })); }
  await studioCommand({ type: 'set-main-audio', sourceId: 'nle_main' }); await studioCommand({ type: 'take', sceneId: fixture.scenes[0].id });
  if (fixture.outputs[0]) await studioCommand({ type: 'route', outputId: fixture.outputs[0].id, sceneId: fixture.scenes[1].id });
  const preview = await production(); preview.previewSceneId = preview.scenes[1].id; await json(await admin.request.put(`${base}/api/studio`, { data: preview }));
  const studioBefore = await production(), statusBefore = await engineStatus(), recordingBefore = await json(await admin.request.get(`${base}/api/studio/recordings`));
  assert.equal(studioBefore.mainAudioSourceId, 'nle_main'); assert.notEqual(studioBefore.previewSceneId, studioBefore.programSceneId);
  async function unchangedLive(label) {
    assert.deepEqual(await production(), studioBefore, `${label}: Preview, Program, scenes, outputs and Main audio unchanged`);
    assert.deepEqual(await engineStatus(), statusBefore, `${label}: engine state unchanged`);
    assert.deepEqual(await json(await admin.request.get(`${base}/api/studio/recordings`)), recordingBefore, `${label}: original metadata unchanged`);
    assert.equal(createHash('sha256').update(await fs.readFile(original)).digest('hex'), originalHash, `${label}: original media is byte-for-byte unchanged`);
    assert.deepEqual(studioMutations, [], `${label}: editor never writes live production`);
  }
  assert.equal((await anonymous.request.get(`${base}/api/clips`)).status(), 401);
  assert.equal((await teammate.request.post(`${base}/api/studio/engine/start`)).status(), 403);
  assert.equal((await anonymous.request.post(`${base}/api/clips/assets`, { multipart: { file: { name: 'Music.wav', mimeType: 'audio/wav', buffer: await fs.readFile(importedAudio) }, durationMs: '2000', width: '0', height: '0' } })).status(), 401);
  assert.equal((await teammate.request.get(`${base}/api/studio/recordings/${recordingId}/download`)).status(), 200);
  checks.push('Authenticated standalone editing, no Studio author grants, private asset uploads and original downloads');

  page = await teammate.newPage(); monitorPage(page);
  await page.goto(`${base}/recordings`); await page.getByTestId('recording-library').waitFor();
  const card = page.getByTestId('recording-card').filter({ has: page.getByRole('link', { name: `Edit recording ${recordingName}`, exact: true }) });
  await until(() => card.locator('.clip-thumbnail img').evaluate(image => image.complete && image.naturalWidth > 0), 'real library thumbnail');
  await page.getByLabel('Search recordings', { exact: true }).fill('does not exist'); await page.getByRole('heading', { name: 'No matching recordings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await card.waitFor();
  await page.getByRole('button', { name: 'List view', exact: true }).click(); assert.equal(await page.locator('.library-view-list').count(), 1);
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click(); const picker = page.getByRole('dialog', { name: 'Start a project', exact: true }); await picker.waitFor();
  await until(() => picker.getByLabel('Find a recording for your project', { exact: true }).evaluate(element => document.activeElement === element), 'project picker search autofocus');
  await page.keyboard.press('Escape'); await picker.waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(directory, 'recording-library-desktop.png'), fullPage: true });
  await card.getByRole('link', { name: `Edit recording ${recordingName}`, exact: true }).click(); await page.getByTestId('clip-editor').waitFor();
  await until(() => page.locator('video').first().evaluate(video => video.readyState >= 2 && video.videoWidth === 640), 'real full-window preview');
  if (await page.getByRole('button', { name: 'Pause preview', exact: true }).isVisible()) await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await page.getByRole('button', { name: 'Go to clip start', exact: true }).click();
  await unchangedLive('Library and full-window preview'); checks.push('Library search, grid/list, recording picker, decoded thumbnails and editor opening');

  // Navigation of the picture must not become a timeline edit. Keep a clean,
  // saved single-source project here so real media time equals timeline time.
  const scrubDraft = await saveDraft(), beforeScrub = await workspace(), scrubWrites = clipMutations.length;
  const beforeScrubStyle = await page.locator('.nle-timeline-item').first().getAttribute('style');
  const ruler = page.locator('.nle-ruler');
  let geometry = await scrubGeometry();
  await page.mouse.move(geometry.x + 1000 * geometry.scale, geometry.y); await page.mouse.down();
  await assertSeek(1000, 'Ruler pointer-down');
  for (const target of [4200, 2300, 8100, 1200]) {
    await page.mouse.move(geometry.x + target * geometry.scale, geometry.y, { steps: 5 });
    await assertSeek(target, 'Ruler drag while the pointer stays held');
  }
  await page.mouse.up();
  await page.mouse.move(geometry.x + 5500 * geometry.scale, geometry.y); await assertSeek(1200, 'Pointer-up ends ruler scrubbing');

  // Empty tracks act as additional seek surfaces, never as clip-edit gestures.
  const emptyLane = page.locator('[data-timeline-track][data-kind="text"] .nle-track-lane');
  const emptyRect = await emptyLane.boundingBox(); assert.ok(emptyRect);
  await page.mouse.move(geometry.x + 700 * geometry.scale, emptyRect.y + emptyRect.height / 2); await page.mouse.down();
  await assertSeek(700, 'Empty-lane pointer-down');
  for (const target of [3700, 1100]) {
    await page.mouse.move(geometry.x + target * geometry.scale, emptyRect.y + emptyRect.height / 2, { steps: 5 });
    await assertSeek(target, 'Empty-lane drag');
  }
  await page.mouse.up();
  await emptyLane.dispatchEvent('pointerdown', { pointerId: 77, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: geometry.x + 4800 * geometry.scale, clientY: emptyRect.y + emptyRect.height / 2 });
  assert.equal(await page.getByTestId('clip-timeline').evaluate(element => element.classList.contains('is-scrubbing')), false, 'Empty-lane touch keeps native timeline panning instead of starting a seek');
  assert.equal(await emptyLane.evaluate(element => element.hasPointerCapture(77)), false, 'Empty-lane touch is not captured');
  await assertSeek(1100, 'Empty-lane touch leaves the playhead unchanged');

  const playhead = page.getByRole('slider', { name: 'Timeline playhead', exact: true });
  const playheadRect = await playhead.boundingBox(); assert.ok(playheadRect, 'The playhead exposes a draggable handle');
  await page.mouse.move(playheadRect.x + playheadRect.width / 2, playheadRect.y + playheadRect.height / 2); await page.mouse.down();
  await page.mouse.move(geometry.x + 5400 * geometry.scale, playheadRect.y + playheadRect.height / 2, { steps: 6 }); await assertSeek(5400, 'Playhead-handle drag forward');
  await page.mouse.move(geometry.x + 2200 * geometry.scale, playheadRect.y + playheadRect.height / 2, { steps: 6 }); await assertSeek(2200, 'Playhead-handle drag backward');
  await page.mouse.up();
  assert.equal(await playhead.evaluate(element => document.activeElement === element), true, 'Dragged playhead retains keyboard focus');
  await page.keyboard.press('Space');
  await until(() => page.getByTestId('clip-preview').locator('video').first().evaluate(video => !video.paused), 'Space plays immediately after dragging the focused playhead');
  await page.keyboard.press('Space');
  await until(() => page.getByTestId('clip-preview').locator('video').first().evaluate(video => video.paused), 'Space pauses immediately while the playhead stays focused');
  await playhead.press('Home'); await assertSeek(0, 'Focused playhead Home');
  await playhead.press('ArrowRight'); await assertSeek(33, 'Focused playhead steps one frame');
  await playhead.press('Shift+ArrowRight'); await assertSeek(1033, 'Focused playhead steps one second with Shift');
  await playhead.press('ArrowLeft'); await assertSeek(1000, 'Focused playhead steps backward');
  await playhead.press('End'); await assertSeek(11999, 'Focused playhead End');
  await playhead.press('Home'); await assertSeek(0, 'Focused playhead returns to the beginning');

  await page.getByLabel('Timeline zoom', { exact: true }).fill('4'); await page.getByLabel('Timeline zoom', { exact: true }).press('Tab');
  await page.locator('.nle-timeline-scroll').evaluate(element => { element.scrollLeft = 800; });
  geometry = await scrubGeometry(); assert.ok(geometry.scrollLeft >= 790 && geometry.scale > .2, 'The scrolled ruler is genuinely zoomed');
  await page.mouse.move(geometry.x + 5000 * geometry.scale, geometry.y); await page.mouse.down(); await assertSeek(5000, 'Zoomed and scrolled ruler pointer-down');
  for (const target of [7000, 4200]) {
    await page.mouse.move(geometry.x + target * geometry.scale, geometry.y, { steps: 5 }); await assertSeek(target, 'Zoomed and scrolled drag preserves time coordinates');
  }
  await page.mouse.up();
  await page.locator('.nle-timeline-scroll').evaluate(element => { element.scrollLeft = 0; });
  await page.getByLabel('Timeline zoom', { exact: true }).fill('1'); await page.getByLabel('Timeline zoom', { exact: true }).press('Tab');
  geometry = await scrubGeometry();

  // Pointer capture keeps the gesture alive over track labels and clamps it
  // to the project, not the longer ruler's empty workspace.
  await page.mouse.move(geometry.x + 3000 * geometry.scale, geometry.y); await page.mouse.down();
  await page.mouse.move(2, geometry.y, { steps: 6 }); await assertSeek(0, 'Dragging beyond the left edge clamps at zero');
  await page.mouse.move(page.viewportSize().width - 2, geometry.y, { steps: 6 }); await assertSeek(11999, 'Dragging beyond the project clamps at its last frame');
  await page.mouse.up();
  await ruler.evaluate(element => { element.addEventListener('pointerdown', event => { element.dataset.testPointerId = String(event.pointerId); }, { once: true }); });
  await page.mouse.move(geometry.x + 2000 * geometry.scale, geometry.y); await page.mouse.down(); await assertSeek(2000, 'Cancelable ruler gesture begins');
  const pointerId = Number(await ruler.getAttribute('data-test-pointer-id')); assert.ok(Number.isFinite(pointerId));
  assert.equal(await ruler.evaluate((element, id) => element.hasPointerCapture(id), pointerId), true, 'Ruler has real browser pointer capture');
  await ruler.dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 });
  await page.mouse.move(geometry.x + 6000 * geometry.scale, geometry.y, { steps: 5 }); await assertSeek(2000, 'Pointer cancellation prevents further seeking');
  await page.mouse.up();
  assert.equal(await ruler.evaluate((element, id) => element.hasPointerCapture(id), pointerId), false, 'Cancelled capture is released');
  await page.getByRole('button', { name: 'Go to clip start', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Undo edit', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.clips-draft-state').innerText(), 'Saved');
  assert.equal(await page.locator('.nle-timeline-item').first().getAttribute('style'), beforeScrubStyle, 'Scrubbing never moves or trims a clip');
  const afterScrub = await workspace();
  assert.deepEqual(afterScrub.drafts, beforeScrub.drafts, 'Scrubbing never changes draft settings or revisions');
  assert.deepEqual(afterScrub.exports, beforeScrub.exports); assert.deepEqual(afterScrub.assets, beforeScrub.assets);
  assert.equal(clipMutations.length, scrubWrites, 'Scrubbing never writes the Clips API');
  assert.equal(afterScrub.drafts.find(item => item.id === scrubDraft.id).revision, scrubDraft.revision);
  const previewChrome = await page.getByTestId('clip-preview').evaluate(element => { const style = getComputedStyle(element); return { radius: Number.parseFloat(style.borderTopLeftRadius), overflow: style.overflow }; });
  assert.ok(previewChrome.radius >= 4 && previewChrome.radius <= 16, 'Preview frame uses a subtle rounded corner');
  assert.equal(previewChrome.overflow, 'hidden', 'Preview picture clips neatly inside the rounded frame');
  await unchangedLive('Continuous timeline scrubbing and rounded preview');
  checks.push('Continuous ruler/lane/playhead scrubbing, focused-handle Space and frame/second/Home/End keys, decoded video seeking, zoom/scroll, bounds, cancellation and rounded preview without draft/live writes');

  await fill('Clip name', 'Service highlight with overlays');
  await fill('Clip end time', '6');
  assert.equal(await page.getByLabel('Timeline clip duration', { exact: true }).inputValue(), '6.00');
  await page.locator('.nle-preview-toolbar').click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  await playhead.press('s');
  assert.equal(await page.locator('.nle-timeline-item').count(), 2, 'S splits immediately with the playhead focused');
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click(); assert.equal(await page.locator('.nle-timeline-item').count(), 1);
  await page.locator('.nle-timeline-item').first().click();
  await page.getByRole('button', { name: 'Split selected clip', exact: true }).click(); assert.equal(await page.locator('.nle-timeline-item').count(), 2, 'The Split button has the same result');
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click(); assert.equal(await page.locator('.nle-timeline-item').count(), 1);
  await page.getByRole('button', { name: 'Redo edit', exact: true }).click(); assert.equal(await page.locator('.nle-timeline-item').count(), 2);
  await page.locator('.nle-timeline-item').nth(1).click();
  await fill('Timeline clip name', 'Second half');
  await page.getByRole('slider', { name: 'Clip end handle', exact: true }).press('Shift+ArrowLeft');
  assert.equal(await page.getByLabel('Timeline clip duration', { exact: true }).inputValue(), '2.00', 'Keyboard trim changes selected source range');
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  const second = page.getByRole('button', { name: 'Select clip Second half', exact: true }), first = page.getByRole('button', { name: `Select clip ${recordingName}`, exact: true });
  const secondRect = await second.boundingBox(), firstRect = await first.boundingBox(); assert.ok(secondRect && firstRect);
  await page.mouse.move(secondRect.x + 15, secondRect.y + secondRect.height / 2); await page.mouse.down();
  await page.mouse.move(firstRect.x + 12, firstRect.y + firstRect.height / 2, { steps: 8 }); await page.mouse.up();
  await until(async () => Number(await page.getByLabel('Timeline start', { exact: true }).inputValue()) === 0, 'dragging reorders main sequence');
  await page.getByRole('button', { name: 'Duplicate selected clip', exact: true }).click(); assert.equal(await page.locator('.nle-timeline-item').count(), 3);
  await page.getByRole('button', { name: 'Delete selected clip', exact: true }).click(); assert.equal(await page.locator('.nle-timeline-item').count(), 2);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click(); assert.equal(await page.locator('.nle-timeline-item').count(), 3);
  await page.getByRole('button', { name: 'Redo edit', exact: true }).click(); assert.equal(await page.locator('.nle-timeline-item').count(), 2);
  checks.push('Source trimming, split, sequence drag/rearrangement, duplicate/delete, keyboard edge trims and undo/redo');

  await page.getByLabel('Import media files', { exact: true }).setInputFiles([importedVideo, importedImage, importedAudio]);
  const assets = await until(async () => { const values = (await workspace()).assets ?? []; return values.length === 3 && values; }, 'video, image and audio imports persist');
  assert.deepEqual(assets.map(asset => asset.kind).sort(), ['audio', 'image', 'video']);
  const videoAsset = assets.find(asset => asset.kind === 'video'), imageAsset = assets.find(asset => asset.kind === 'image'), audioAsset = assets.find(asset => asset.kind === 'audio');
  for (const asset of assets) {
    assert.equal((await anonymous.request.get(`${base}/api/clips/assets/${asset.id}/media`)).status(), 401, 'Imported editing media remains private');
    assert.equal((await secondTeammate.request.get(`${base}/api/clips/assets/${asset.id}/media`)).status(), 200, 'Authenticated teammates can reuse editing media');
  }
  await page.getByRole('button', { name: 'Media library', exact: true }).click();
  await page.getByRole('button', { name: `Add ${videoAsset.name} to main sequence`, exact: true }).click();
  assert.equal(await page.getByLabel('Timeline start', { exact: true }).inputValue(), '6.00', 'Imported video appends to the sequence');
  await page.getByRole('button', { name: 'Go to clip start', exact: true }).click();
  await page.getByRole('button', { name: `Overlay ${imageAsset.name}`, exact: true }).click();
  await fill('Timeline clip duration', '2'); await fill('Element width', '20'); await fill('Element height', '20'); await fill('Element x', '0'); await fill('Element y', '0');
  const overlayId = await page.locator('.nle-timeline-item.selected').getAttribute('data-item-id');
  const overlay = page.locator(`[data-preview-item="${overlayId}"]`), overlayRect = await overlay.boundingBox(); assert.ok(overlayRect);
  await page.mouse.move(overlayRect.x + overlayRect.width / 2, overlayRect.y + overlayRect.height / 2); await page.mouse.down(); await page.mouse.move(overlayRect.x + overlayRect.width / 2 + 15, overlayRect.y + overlayRect.height / 2 + 10, { steps: 5 }); await page.mouse.up();
  assert.ok(Number(await page.getByLabel('Element x', { exact: true }).inputValue()) > 0, 'Dragging preview positions the overlay');
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click(); assert.equal(Number(await page.getByLabel('Element x', { exact: true }).inputValue()), 0);
  const resize = await page.getByRole('button', { name: 'Resize selected element', exact: true }).boundingBox(); assert.ok(resize);
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2); await page.mouse.down(); await page.mouse.move(resize.x + resize.width / 2 + 12, resize.y + resize.height / 2 + 8, { steps: 5 }); await page.mouse.up();
  assert.ok(Number(await page.getByLabel('Element width', { exact: true }).inputValue()) > 20, 'Preview corner resizes an overlay');
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click(); assert.equal(Number(await page.getByLabel('Element width', { exact: true }).inputValue()), 20);
  await page.getByRole('button', { name: 'Text tools', exact: true }).click(); await page.getByRole('button', { name: /Add a text layer/ }).click();
  await fill('Overlay text', 'Hope for every day'); await fill('Timeline clip name', 'Sermon title'); await fill('Text size', '92'); await fill('Timeline clip duration', '2');
  await page.getByLabel('Text alignment', { exact: true }).selectOption('left');
  await fill('Element x', '20'); await fill('Element y', '70'); await fill('Element width', '60'); await fill('Element height', '20');
  await page.getByRole('button', { name: 'Audio library', exact: true }).click(); await page.getByRole('button', { name: `Add ${audioAsset.name} to main sequence`, exact: true }).click();
  await page.getByLabel('Clip volume', { exact: true }).fill('0.25'); await page.getByLabel('Clip volume', { exact: true }).press('Tab');
  let editorDraft = await saveDraft();
  assert.equal(editorDraft.timeline.tracks[0].items.length, 3); assert.equal(editorDraft.timeline.tracks[0].items[0].name, 'Second half');
  assert.equal(editorDraft.timeline.tracks.flatMap(track => track.items).length, 6);
  const savedImage = editorDraft.timeline.tracks.flatMap(track => track.items).find(item => item.kind === 'image');
  assert.equal(savedImage.source.id, imageAsset.id); assert.equal(savedImage.width, .2); assert.equal(savedImage.x, 0); assert.equal(savedImage.durationMs, 2000);
  const savedText = editorDraft.timeline.tracks.flatMap(track => track.items).find(item => item.kind === 'text'); assert.equal(savedText.text, 'Hope for every day'); assert.equal(savedText.fontSize, 92);
  const savedAudio = editorDraft.timeline.tracks.flatMap(track => track.items).find(item => item.kind === 'audio'); assert.equal(savedAudio.volume, .25); assert.equal(savedAudio.source.id, audioAsset.id);
  await page.getByRole('button', { name: 'Select clip Sermon title', exact: true }).click();
  const pendingText = 'Hope for every day · Live in hope', previousRevision = editorDraft.revision;
  await page.getByLabel('Overlay text', { exact: true }).fill(pendingText);
  assert.equal(await page.getByRole('button', { name: 'Save draft', exact: true }).isEnabled(), true, 'Typing enables Save immediately without requiring a blur');
  await page.getByLabel('Overlay text', { exact: true }).press('Control+s');
  editorDraft = await until(async () => { const saved = (await workspace()).drafts.find(item => item.id === editorDraft.id); return saved?.revision > previousRevision && saved.timeline.tracks.flatMap(track => track.items).find(item => item.kind === 'text')?.text === pendingText && await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled() && saved; }, 'Ctrl+S flushes the still-focused text field into the saved timeline');
  assert.equal(await page.locator('.clips-draft-state').innerText(), 'Saved');
  await page.getByRole('button', { name: 'Media library', exact: true }).click();
  const importedVideoCard = page.locator('.nle-media-card').filter({ has: page.getByRole('button', { name: `Add ${videoAsset.name} to timeline`, exact: true }) });
  await until(() => importedVideoCard.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), 'imported video has a decoded media-bin thumbnail');
  await page.screenshot({ path: path.join(directory, 'nle-editor-multitrack.png'), fullPage: true });
  await page.reload(); await page.getByTestId('clip-editor').waitFor(); await until(async () => await page.getByLabel('Clip name', { exact: true }).inputValue() === editorDraft.name, 'saved project reopens by URL');
  assert.equal(await page.locator('.nle-timeline-item').count(), 6);
  assert.deepEqual((await workspace()).drafts.find(draft => draft.id === editorDraft.id).timeline, editorDraft.timeline);
  await unchangedLive('Import, multitrack editing, visual transforms and save/reload');
  checks.push('Private video/image/audio imports, appended video, image overlay, text styling, canvas drag/resize, per-clip audio, six-clip persistence and focused-field Ctrl+S/dirty-state regression');

  const timelineBeforeLock = structuredClone(editorDraft.timeline), mainTrack = editorDraft.timeline.tracks[0];
  await page.getByRole('button', { name: `Lock track ${mainTrack.name}`, exact: true }).click();
  assert.equal(await page.getByLabel('Timeline clip name', { exact: true }).isDisabled(), true, 'Locked track protects inspector edits');
  await page.getByRole('button', { name: `Unlock track ${mainTrack.name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Go to clip start', exact: true }).click();
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await until(() => page.locator('video').first().evaluate(video => !video.paused), 'preview playback');
  assert.equal(await page.locator('video').first().evaluate(video => video.muted), true, 'Editor preview starts muted');
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click(); await until(() => page.evaluate(() => !!document.fullscreenElement), 'native editor fullscreen');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await until(() => page.evaluate(() => !document.fullscreenElement), 'leave native fullscreen');
  await fill('Clip name', 'Unsaved work remains in this window'); await page.getByRole('link', { name: 'Back to recordings', exact: true }).click();
  const leave = page.getByRole('dialog', { name: 'Leave this project without saving?', exact: true }); await leave.waitFor(); await leave.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.getByLabel('Clip name', { exact: true }).inputValue(), 'Unsaved work remains in this window');
  await fill('Clip name', editorDraft.name);
  await page.locator('.nle-preview-toolbar').click(); await page.keyboard.press('Space'); await page.keyboard.press('Space'); await page.keyboard.press('Shift+Space'); await page.keyboard.press('Control+1');
  if (await page.getByRole('button', { name: 'Pause preview', exact: true }).isVisible()) await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  assert.deepEqual((await workspace()).drafts.find(draft => draft.id === editorDraft.id).timeline, timelineBeforeLock);
  await unchangedLive('Playback, shortcuts, fullscreen and unsaved-work safeguard');
  checks.push('Track locking, muted preview, fullscreen, keyboard safeguards and styled unsaved-navigation protection');

  const legacyInput = { name: 'Legacy one-second excerpt', inMs: 1000, outMs: 2000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5 };
  let legacy = await json(await teammate.request.post(`${base}/api/clips/drafts`, { data: { recordingId, ...legacyInput } }), 201);
  assert.equal(legacy.timeline, undefined, 'Legacy trim-only drafts remain accepted without forced migration');
  legacy = await json(await teammate.request.put(`${base}/api/clips/drafts/${legacy.id}`, { data: { ...legacyInput, name: 'Legacy revised excerpt', revision: legacy.revision } }));
  const range = await teammate.request.get(`${base}/api/clips/recordings/${recordingId}/media`, { headers: { Range: 'bytes=0-255' } }); assert.equal(range.status(), 206); assert.equal((await range.body()).length, 256); assert.match(range.headers()['content-range'], /^bytes 0-255\//);
  assert.equal((await teammate.request.get(`${base}/api/clips/recordings/${recordingId}/media`, { headers: { Range: 'bytes=99999999999-' } })).status(), 416);
  await startDefaultExport();
  const job = await until(async () => (await workspace()).exports.find(item => item.draftId === editorDraft.id), 'multitrack export queues a saved snapshot');
  assert.equal(job.temporary, true, 'New UI exports are temporary deliveries, not permanent archive copies');
  const cancellationDraft = await json(await teammate.request.post(`${base}/api/clips/drafts`, { data: { recordingId, ...legacyInput, outMs: 12000, name: 'Cancelled render rehearsal' } }), 201);
  const cancellationJob = await json(await teammate.request.post(`${base}/api/clips/drafts/${cancellationDraft.id}/exports`, { data: { revision: cancellationDraft.revision } }), 202);
  await page.goto(`${base}/recordings?collection=exports`); await page.getByRole('heading', { name: 'Previous exports', exact: true }).waitFor();
  const cancelCard = page.getByTestId('export-card').filter({ has: page.getByRole('button', { name: 'Cancel export Cancelled render rehearsal', exact: true }) });
  await cancelCard.getByRole('button', { name: 'Cancel export Cancelled render rehearsal', exact: true }).click();
  await until(async () => (await workspace()).exports.find(item => item.id === cancellationJob.id)?.status === 'cancelled', 'library cancels queued render');
  const complete = await completedExport(job.id), filename = await decodeExport(complete, 1920, 1080, 8);
  const pixel = async (second, crop) => (await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', filename, '-frames:v', '1', '-vf', `crop=${crop},scale=1:1`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])).output;
  const centre = await pixel(.5, '20:20:950:530'); assert.ok(centre[0] > centre[1] + 60 && centre[0] > centre[2] + 60, `Main source stays behind overlays: ${[...centre]}`);
  const logo = await pixel(.5, '20:20:80:40'); assert.ok(logo[1] > logo[0] + 60 && logo[1] > logo[2] + 60, `Placed green overlay appears in export: ${[...logo]}`);
  const ending = await pixel(7, '20:20:950:530'); assert.ok(ending[0] > 160 && ending[1] > 160 && ending[2] < 80, `Added yellow video follows the cuts: ${[...ending]}`);
  const textPixels = (await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', filename, '-frames:v', '1', '-vf', 'crop=1152:216:384:756,scale=192:36', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])).output;
  assert.ok([...Array(textPixels.length / 3).keys()].some(index => textPixels[index * 3] > 170 && textPixels[index * 3 + 1] > 170 && textPixels[index * 3 + 2] > 170), 'Text title is actually composited into the MP4, not just the preview');
  const legacyJob = await json(await teammate.request.post(`${base}/api/clips/drafts/${legacy.id}/exports`, { data: { revision: legacy.revision } }), 202); await decodeExport(await completedExport(legacyJob.id), 1920, 1080, 1);
  const delivery = page.locator(`[data-testid="export-progress-card"][data-job-id="${job.id}"]`);
  await delivery.waitFor();
  // A hard navigation intentionally forgets opaque browser file capabilities.
  // Recovering a temporary job requires an explicit fresh save choice.
  if (!await delivery.getByRole('button', { name: `Download ${editorDraft.name}`, exact: true }).count()) await delivery.getByRole('button', { name: `Choose save location for ${editorDraft.name}`, exact: true }).click();
  const download = page.waitForEvent('download'); await delivery.getByRole('button', { name: `Download ${editorDraft.name}`, exact: true }).click(); assert.match((await download).suggestedFilename(), /\.mp4$/i);
  await until(async () => await delivery.getAttribute('data-state') === 'download-requested', 'Global delivery card honestly reports an unconfirmed browser download');
  assert.equal((await workspace()).exports.find(item => item.id === job.id).deliveredAt, undefined, 'Browser Downloads never acknowledge an unverified save');
  await delivery.getByRole('button', { name: `Dismiss export ${editorDraft.name}`, exact: true }).click();
  assert.equal((await workspace()).exports.find(item => item.id === job.id).deliveredAt, undefined, 'Dismissing progress never releases an unconfirmed browser download');
  await unchangedLive('Rendered MP4, queue cancellation and legacy recording compatibility');
  checks.push('Actual H.264/AAC MP4 decode, timed cuts, image/text compositing, imported ending, audible mix, download, queued cancellation and legacy trim/export/byte-range compatibility');

  const readonly = await secondTeammate.newPage(); monitorPage(readonly);
  await readonly.goto(`${base}/recordings?collection=team`); await readonly.getByRole('heading', { name: 'Team projects', exact: true }).waitFor();
  const projectCard = readonly.getByTestId('project-card').filter({ has: readonly.getByRole('link', { name: `View project ${editorDraft.name}`, exact: true }) }); await projectCard.waitFor();
  await projectCard.getByRole('button', { name: `Actions for project ${editorDraft.name}`, exact: true }).click();
  await readonly.getByRole('menuitem', { name: 'Make your own copy', exact: true }).click();
  const copied = await until(async () => { const id = new URL(readonly.url()).searchParams.get('draft'); return id && id !== editorDraft.id && (await workspace(secondTeammate.request)).drafts.find(draft => draft.id === id); }, 'library creates independent team project copy');
  assert.equal(copied.canEdit, true); assert.deepEqual(copied.timeline, editorDraft.timeline, 'Team copy preserves every cut, source, overlay and audio field');
  await readonly.goto(`${base}/recordings/${recordingId}/editor?draft=${editorDraft.id}`); await readonly.getByTestId('clip-editor').waitFor();
  await until(() => readonly.getByLabel('Clip name', { exact: true }).isDisabled(), 'another teammate original is read-only'); assert.equal(await readonly.getByRole('button', { name: 'Export', exact: true }).isDisabled(), true);
  assert.equal((await secondTeammate.request.put(`${base}/api/clips/drafts/${editorDraft.id}`, { data: { revision: editorDraft.revision, ...input(editorDraft), name: 'Forbidden overwrite' } })).status(), 403);
  assert.equal((await secondTeammate.request.post(`${base}/api/clips/drafts/${editorDraft.id}/exports`, { data: { revision: editorDraft.revision } })).status(), 403);
  await readonly.close();
  await page.goto(`${base}/recordings/${recordingId}/editor?draft=${editorDraft.id}`); await page.getByTestId('clip-editor').waitFor();
  await dismissRecoveredDeliveries([job.id]);
  await fill('Clip name', 'Local edit protected from a conflict');
  const remote = await json(await teammate.request.put(`${base}/api/clips/drafts/${editorDraft.id}`, { data: { revision: editorDraft.revision, ...input(editorDraft), name: 'Acknowledged in another window' } }));
  await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await page.getByRole('button', { name: 'Save a copy', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Clip name', { exact: true }).inputValue(), 'Local edit protected from a conflict');
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click();
  editorDraft = await until(async () => { const id = new URL(page.url()).searchParams.get('draft'); return id && id !== remote.id && (await workspace()).drafts.find(draft => draft.id === id); }, 'conflicting timeline saves as independent project');
  assert.equal((await workspace()).drafts.find(draft => draft.id === remote.id).name, remote.name); assert.deepEqual(editorDraft.timeline, remote.timeline);
  await page.getByRole('button', { name: 'Frame format 9:16', exact: true }).click(); editorDraft = await saveDraft();
  const bounds = await page.getByTestId('clip-preview').boundingBox(); assert.ok(Math.abs(bounds.width / bounds.height - 9 / 16) < .02, 'Preview preserves selected portrait frame');
  await startDefaultExport();
  const portrait = await until(async () => (await workspace()).exports.find(item => item.draftId === editorDraft.id && item.settings.format === '9:16'), 'portrait multi-track export'); await decodeExport(await completedExport(portrait.id), 1080, 1920, 8);
  await unchangedLive('Teammate copies, ownership, conflicting saves and portrait export');
  checks.push('Team-project browsing and independent copies, read-only ownership enforcement, conflict-safe copies and portrait preview/export parity');

  for (const [width, height] of [[1512, 982], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height }); await page.goto(`${base}/recordings/${recordingId}/editor?draft=${editorDraft.id}`); await page.getByTestId('clip-editor').waitFor();
    await dismissRecoveredDeliveries([job.id, portrait.id]);
    await until(() => page.getByTestId('clip-preview').evaluate(element => element.clientWidth > 0 && element.clientHeight > 0), `${width}px preview layout`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `Editor no horizontal overflow at ${width}px`);
    assert.ok(await page.getByRole('button', { name: 'Save draft', exact: true }).isVisible());
    const frame = await page.getByTestId('clip-preview').boundingBox(); assert.ok(Math.abs(frame.width / frame.height - 9 / 16) < .03, `Portrait preview ratio at ${width}px`);
    if (width < 720) {
      await page.getByRole('button', { name: 'Text tools', exact: true }).click();
      assert.ok(await page.getByRole('button', { name: /Add a text layer/ }).isVisible(), 'Phone Text tools opens an actionable editing drawer');
      await page.getByRole('button', { name: 'Close media panel', exact: true }).click();
      await page.getByRole('button', { name: 'Media library', exact: true }).click();
      assert.ok(await page.getByRole('button', { name: `Add ${videoAsset.name} to main sequence`, exact: true }).isVisible(), 'Imported media remains available on phone');
      await page.getByRole('button', { name: 'Close media panel', exact: true }).click();
      await page.locator('.nle-timeline-item').first().click();
      assert.ok(await page.getByLabel('Clip name', { exact: true }).isVisible(), 'Phone selection opens the inspector');
      await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
    }
    await page.screenshot({ path: path.join(directory, `nle-editor-${width}.png`), fullPage: true });
    await page.goto(`${base}/recordings`); await page.getByTestId('recording-library').waitFor(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `Library no overflow at ${width}px`);
    await dismissRecoveredDeliveries([job.id, portrait.id]);
    await until(() => page.getByTestId('recording-card').first().locator('.clip-thumbnail img').evaluate(image => image.complete && image.naturalWidth > 0), `${width}px recording thumbnail decodes before screenshot`);
    assert.ok(await page.getByRole('link', { name: 'Team projects', exact: true }).isVisible(), 'Collapsed icon navigation retains accessible labels');
    await page.screenshot({ path: path.join(directory, `recording-library-${width}.png`), fullPage: true });
  }
  await unchangedLive('Responsive editor and library');
  checks.push('Desktop, tablet and phone layouts, portrait frame ratio, readable library and accessible collapsed collection navigation');
  assert.deepEqual(errors, [], 'No uncaught browser errors or native browser dialogs');
  console.log(JSON.stringify({ ok: true, directory, checks, browserErrors: errors, studioMutations }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'nle-failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ ok: false, directory, error: error.stack ?? error.message, browserErrors: errors, studioMutations, logs: logs.slice(-6000) }, null, 2)); process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {}); await stopServer();
}
