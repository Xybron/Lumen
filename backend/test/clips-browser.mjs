// Disposable recording/clip station: generated picture and tone only. Never
// opens an operator recording, physical capture device, or the real station.
// Run after the integrated build finishes: node backend/test/clips-browser.mjs
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clips-'));
const port = Number(process.env.LUMEN_CLIPS_TEST_PORT ?? 3461), base = `http://127.0.0.1:${port}`;
const recordingId = 'rec_clip_fixture', recordingName = 'Sunday service rehearsal';
const original = path.join(directory, 'recordings', recordingId, 'recording.webm');
const checks = [], errors = [], mutations = [];
let server, browser, page, logs = '', admin, teammate, secondTeammate, anonymous;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });

async function until(fn, label, timeout = 15000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [], diagnostics = [];
    process.stdout.on('data', chunk => output.push(chunk)); process.stderr.on('data', chunk => diagnostics.push(chunk));
    process.once('error', reject); process.once('close', code => code === 0 ? resolve({ output: Buffer.concat(output), diagnostics: Buffer.concat(diagnostics).toString() }) : reject(new Error(Buffer.concat(diagnostics).toString())));
  });
}
async function startServer() {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'disposable station startup', 30000);
}
async function stopServer() {
  const current = server; if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise(resolve => { current.once('exit', resolve); current.kill('SIGTERM'); setTimeout(() => { if (current.exitCode === null) current.kill('SIGKILL'); }, 6500).unref(); });
}
async function json(response, expected = 200) { assert.equal(response.status(), expected, await response.text()); return response.json(); }
const workspace = async (request = teammate.request) => json(await request.get(`${base}/api/clips`));
const production = async () => json(await admin.request.get(`${base}/api/studio`));
const engineStatus = async () => json(await admin.request.get(`${base}/api/studio/status`));
const settings = (overrides = {}) => ({ name: 'Clip draft', inMs: 1000, outMs: 5000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5, ...overrides });
const input = value => Object.fromEntries(['name', 'inMs', 'outMs', 'format', 'fit', 'positionX', 'positionY'].map(key => [key, value[key]]));
const createDraft = async (overrides = {}, request = teammate.request) => json(await request.post(`${base}/api/clips/drafts`, { data: { recordingId, ...input(settings(overrides)) } }), 201);
const saveDraft = async (draft, overrides = {}, request = teammate.request, expected = 200) => json(await request.put(`${base}/api/clips/drafts/${draft.id}`, { data: { ...input(settings(draft)), ...overrides, revision: draft.revision } }), expected);
const exportDraft = async draft => json(await teammate.request.post(`${base}/api/clips/drafts/${draft.id}/exports`, { data: { revision: draft.revision } }), 202);
const completedExport = async id => until(async () => { const job = (await workspace()).exports.find(item => item.id === id); assert.notEqual(job?.status, 'error', job?.error); return job?.status === 'complete' && job; }, `export ${id} finishes`, 120000);
async function verifyMp4(job, width, height, durationSeconds, expectedDominant) {
  const response = await teammate.request.get(`${base}/api/clips/exports/${job.id}/download`);
  assert.equal(response.status(), 200, await response.text());
  assert.match(response.headers()['content-disposition'] ?? '', /attachment/);
  const filename = path.join(directory, `checked-${job.id}.mp4`); await fs.writeFile(filename, await response.body());
  const decoded = await runFfmpeg(['-hide_banner', '-i', filename, '-t', '0.15', '-f', 'null', '-']);
  assert.match(decoded.diagnostics, /Video: h264/); assert.match(decoded.diagnostics, /yuv420p/);
  assert.match(decoded.diagnostics, /Audio: aac/); assert.match(decoded.diagnostics, new RegExp(`\\b${width}x${height}\\b`));
  const audio = await runFfmpeg(['-hide_banner', '-i', filename, '-t', '0.5', '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(audio.diagnostics);
  assert.ok(peak && Number(peak[1]) > -40, 'Exported AAC retains the generated audible recording, not silence');
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(decoded.diagnostics);
  assert.ok(duration, 'MP4 includes a finite seekable duration');
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  assert.ok(Math.abs(seconds - durationSeconds) < .2, `Trimmed duration ${seconds}s should be ${durationSeconds}s`);
  if (expectedDominant) {
    const pixel = (await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', filename, '-frames:v', '1', '-vf', 'crop=20:20:(iw-20)/2:(ih-20)/2,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])).output;
    const channel = { red: 0, green: 1, blue: 2 }[expectedDominant];
    assert.ok(pixel[channel] > pixel[(channel + 1) % 3] + 35 && pixel[channel] > pixel[(channel + 2) % 3] + 35, `${expectedDominant} crop should occupy the MP4 centre: ${[...pixel]}`);
  }
  return filename;
}

try {
  await fs.mkdir(path.dirname(original), { recursive: true });
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=960x540:r=24,drawbox=x=0:y=0:w=320:h=540:color=blue:t=fill,drawbox=x=640:y=0:w=320:h=540:color=green:t=fill',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '36', '-threads', '2', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-c:a', 'libopus', original]);
  await fs.mkdir(path.join(directory, 'media', 'music'), { recursive: true });
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', original, '-t', '36', '-vn', '-c:a', 'pcm_s16le', path.join(directory, 'media', 'music', 'clip-test-main.wav')]);
  const originalBytes = await fs.readFile(original), originalHash = createHash('sha256').update(originalBytes).digest('hex');
  await fs.writeFile(path.join(path.dirname(original), 'recording.json'), JSON.stringify({ id: recordingId, name: recordingName, status: 'complete', createdAt: '2026-10-18T08:00:00.000Z', durationMs: 36000, bytes: originalBytes.length, nextChunk: 1 }));
  await startServer();
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  admin = await browser.newContext(); teammate = await browser.newContext({ viewport: { width: 1512, height: 982 } }); secondTeammate = await browser.newContext(); anonymous = await browser.newContext();
  assert.equal((await admin.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  for (const [context, username, displayName] of [[teammate, 'clipeditor', 'Content team'], [secondTeammate, 'othereditor', 'Second teammate']]) {
    await json(await admin.request.post(`${base}/api/users`, { data: { username, displayName, password: 'test-editor-password' } }));
    const login = await json(await context.request.post(`${base}/api/auth/login`, { data: { username, password: 'test-editor-password' } }));
    assert.deepEqual(login.grants, [], 'Editors have no Studio or channel author permission');
  }
  // A genuine committed Program, different Preview, pinned screen and selected
  // persistent Main make unchanged-live checks meaningful rather than empty.
  const productionFixture = await production();
  productionFixture.sources.push({ id: 'clip_test_main', name: 'Persistent service audio', kind: 'audio', url: 'media/music/clip-test-main.wav', loop: true, audio: { muted: true, volume: .6, mode: 'follow', delayMs: 30 } });
  productionFixture.masterVolume = .7; productionFixture.masterMuted = false;
  await json(await admin.request.put(`${base}/api/studio`, { data: productionFixture }));
  const studioCommand = async command => { const document = await production(); return json(await admin.request.post(`${base}/api/studio/command`, { data: { revision: document.revision, command } })); };
  await studioCommand({ type: 'set-main-audio', sourceId: 'clip_test_main' });
  await studioCommand({ type: 'take', sceneId: productionFixture.scenes[0].id });
  if (productionFixture.outputs[0]) await studioCommand({ type: 'route', outputId: productionFixture.outputs[0].id, sceneId: productionFixture.scenes[1].id });
  const separatePreview = await production(); separatePreview.previewSceneId = separatePreview.scenes[1].id;
  await json(await admin.request.put(`${base}/api/studio`, { data: separatePreview }));
  const studioBefore = await production(), statusBefore = await engineStatus(), recordingBefore = await json(await admin.request.get(`${base}/api/studio/recordings`));
  assert.equal(studioBefore.mainAudioSourceId, 'clip_test_main'); assert.notEqual(studioBefore.previewSceneId, studioBefore.programSceneId);
  async function unchangedLive(label, status = statusBefore) {
    assert.deepEqual(await production(), studioBefore, `${label}: clips never alter Preview, Program, scenes, outputs or main audio`);
    if (status) assert.deepEqual(await engineStatus(), status, `${label}: clips never start or stop production`);
    assert.deepEqual(await json(await admin.request.get(`${base}/api/studio/recordings`)), recordingBefore, `${label}: original recording metadata stays untouched`);
    assert.equal(createHash('sha256').update(await fs.readFile(original)).digest('hex'), originalHash, `${label}: original media remains byte-for-byte unchanged`);
  }
  for (const route of ['', `/recordings/${recordingId}/media`, `/recordings/${recordingId}/thumbnail`, '/exports/exp_missing/download']) assert.equal((await anonymous.request.get(`${base}/api/clips${route}`)).status(), 401, `Anonymous ${route || 'workspace'} is private`);
  assert.equal((await anonymous.request.post(`${base}/api/clips/drafts`, { data: { recordingId, ...settings() } })).status(), 401);
  assert.equal((await anonymous.request.get(`${base}/api/studio/recordings/${recordingId}/download`)).status(), 401);
  assert.equal((await teammate.request.post(`${base}/api/studio/engine/start`)).status(), 403, 'Clip teammate cannot start Studio engine');
  const range = await teammate.request.get(`${base}/api/clips/recordings/${recordingId}/media`, { headers: { Range: 'bytes=0-255' } });
  assert.equal(range.status(), 206); assert.equal((await range.body()).length, 256); assert.match(range.headers()['content-range'], /^bytes 0-255\//);
  assert.equal((await teammate.request.get(`${base}/api/clips/recordings/${recordingId}/media`, { headers: { Range: 'bytes=99999999999-' } })).status(), 416);
  assert.equal((await teammate.request.get(`${base}/api/studio/recordings/${recordingId}/download`)).status(), 200, 'Teammates retain original download');
  const first = await createDraft({ name: 'Reusable landscape highlight' }); assert.equal(first.canEdit, true);
  const updated = await saveDraft(first, { name: 'Saved landscape highlight', inMs: 2000, outMs: 6000 }); assert.equal(updated.revision, first.revision + 1);
  assert.equal((await teammate.request.put(`${base}/api/clips/drafts/${first.id}`, { data: { ...settings({ name: 'Stale destructive overwrite' }), revision: first.revision } })).status(), 409);
  assert.equal((await workspace()).drafts.find(draft => draft.id === first.id).name, updated.name, 'Stale edit cannot overwrite acknowledged draft');
  const sharedDraft = (await workspace(secondTeammate.request)).drafts.find(draft => draft.id === first.id); assert.equal(sharedDraft.canEdit, false);
  assert.equal((await secondTeammate.request.put(`${base}/api/clips/drafts/${first.id}`, { data: { ...settings(), revision: updated.revision } })).status(), 403);
  assert.equal((await secondTeammate.request.post(`${base}/api/clips/drafts/${first.id}/exports`, { data: { revision: updated.revision } })).status(), 403);
  const fork = await createDraft({ ...sharedDraft, name: 'Second teammate independent copy' }, secondTeammate.request); assert.notEqual(fork.id, first.id); assert.equal(fork.canEdit, true);
  const invalidCases = [{ inMs: -1 }, { outMs: 37000 }, { inMs: 5000, outMs: 1000 }, { positionX: 2 }, { format: '4:3' }, { name: '' }];
  for (const invalid of invalidCases) assert.equal((await teammate.request.post(`${base}/api/clips/drafts`, { data: { recordingId, ...settings(invalid) } })).status(), 422, `Invalid ${JSON.stringify(invalid)} is rejected`);
  await unchangedLive('Private API, ownership and optimistic revision checks');
  checks.push('Authenticated originals/thumbnails/streaming; byte-range playback; no-grant teammate authoring; own drafts, read-only sharing/forks, stale revision protection and bounds validation');

  const readonlyPage = await secondTeammate.newPage();
  readonlyPage.on('pageerror', error => errors.push(error.message));
  readonlyPage.on('request', request => { const pathname = new URL(request.url()).pathname; if (['PUT', 'POST', 'DELETE'].includes(request.method()) && pathname.startsWith('/api/studio')) mutations.push(`${request.method()} ${pathname}`); });
  await readonlyPage.goto(`${base}/recordings/${recordingId}/editor?draft=${first.id}`);
  await until(() => readonlyPage.getByLabel('Clip name', { exact: true }).isDisabled(), 'other teammate draft renders read-only');
  assert.equal(await readonlyPage.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), true);
  assert.equal(await readonlyPage.getByRole('button', { name: 'Export', exact: true }).isDisabled(), true);
  await readonlyPage.getByRole('button', { name: 'Make a copy', exact: true }).click();
  await until(() => readonlyPage.getByLabel('Clip name', { exact: true }).isEnabled(), 'read-only draft becomes own independent copy');
  assert.equal((await workspace()).drafts.find(draft => draft.id === first.id).name, updated.name);
  await readonlyPage.close();
  checks.push('A teammate without live-production permission sees another editor’s draft read-only and can make their own editable copy');

  // UI assertions are deliberately independent of Studio: the editor never
  // mounts its keyboard controls or sends a Studio mutation while editing.
  page = await teammate.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { errors.push(`Unexpected native ${dialog.type()} dialog`); await dialog.dismiss(); });
  page.on('request', request => { const pathname = new URL(request.url()).pathname; if (['PUT', 'POST', 'DELETE'].includes(request.method()) && pathname.startsWith('/api/studio')) mutations.push(`${request.method()} ${pathname}`); });
  await page.goto(`${base}/recordings`); await page.getByTestId('recording-library').waitFor();
  const card = page.getByTestId('recording-card').filter({ has: page.getByRole('link', { name: `Edit recording ${recordingName}`, exact: true }) });
  await until(() => card.locator('.clip-thumbnail img').evaluate(image => image.complete && image.naturalWidth > 0), 'real recording thumbnail is decoded');
  const thumbnail = await until(async () => { const response = await teammate.request.get(`${base}/api/clips/recordings/${recordingId}/thumbnail`); return response.status() === 200 && response; }, 'server thumbnail generation');
  assert.match(thumbnail.headers()['content-type'], /image\/jpeg/); assert.ok((await thumbnail.body()).length > 500);
  await page.getByLabel('Search recordings').fill('does not exist'); await page.getByRole('heading', { name: 'No matching recordings' }).waitFor();
  await page.getByLabel('Search recordings').fill('Sunday'); await card.waitFor();
  await page.screenshot({ path: path.join(directory, 'recording-library.png'), fullPage: true });
  await card.getByRole('link', { name: `Edit recording ${recordingName}`, exact: true }).click();
  await page.getByTestId('clip-editor').waitFor();
  await until(() => page.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth === 960 && video.duration > 35), 'fullscreen editor opens real seekable media');
  if (new URL(page.url()).searchParams.get('play') === '1') {
    await until(() => page.locator('video').evaluate(video => !video.paused), 'thumbnail tap starts the preview');
    assert.equal(await page.locator('video').evaluate(video => video.muted), true, 'Automatic preview playback is muted and cannot bleed into production audio');
    await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  }
  checks.push('Searchable thumbnail library opens the standalone full-window player/editor with real decoded video');

  // Remaining editor selectors follow the public accessible labels supplied by
  // ClipEditorView rather than testing internal Vue component state.
  await page.getByLabel('Clip name', { exact: true }).fill('Portrait sermon excerpt');
  await page.getByLabel('Clip start time', { exact: true }).fill('2');
  await page.getByLabel('Clip end time', { exact: true }).fill('6');
  await page.getByRole('button', { name: 'Frame format 9:16', exact: true }).click();
  await page.getByLabel('Horizontal framing position', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  let editorDraft = await until(async () => (await workspace()).drafts.find(draft => draft.name === 'Portrait sermon excerpt'), 'new editor draft persists');
  assert.equal(editorDraft.format, '9:16'); assert.equal(editorDraft.inMs, 2000); assert.equal(editorDraft.outMs, 6000); assert.equal(editorDraft.positionX, 1);
  await until(async () => new URL(page.url()).searchParams.get('draft') === editorDraft.id && await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled() && await page.locator('.clips-draft-state').innerText() === 'Saved', 'editor acknowledges the saved revision before reload');
  const portraitBounds = await page.getByTestId('clip-preview').boundingBox();
  assert.ok(Math.abs(portraitBounds.width / portraitBounds.height - 9 / 16) < .02, `Portrait preview must match export framing: ${portraitBounds.width}×${portraitBounds.height}`);
  await page.getByLabel('Image fitting', { exact: true }).selectOption('contain');
  assert.equal(await page.getByLabel('Horizontal framing position', { exact: true }).isDisabled(), true, 'Contain fitting disables ineffective crop controls');
  assert.equal(await page.locator('video').evaluate(video => getComputedStyle(video).objectPosition), '50% 50%', 'Contain preview uses the same centred letterbox as MP4 export');
  await page.getByLabel('Image fitting', { exact: true }).selectOption('cover');
  await page.mouse.move(portraitBounds.x + portraitBounds.width / 2, portraitBounds.y + portraitBounds.height / 2);
  await page.mouse.down(); await page.mouse.move(portraitBounds.x + portraitBounds.width / 2 + 25, portraitBounds.y + portraitBounds.height / 2, { steps: 5 }); await page.mouse.up();
  assert.ok(Number(await page.getByLabel('Horizontal framing position', { exact: true }).inputValue()) < 1, 'Picture dragging adjusts the actual normalised crop');
  await page.getByLabel('Horizontal framing position', { exact: true }).fill('1');
  await page.getByRole('slider', { name: 'Clip start handle', exact: true }).press('Shift+ArrowRight');
  assert.equal(await page.getByLabel('Clip start time', { exact: true }).inputValue(), '00:00:03.000');
  await page.getByRole('slider', { name: 'Clip start handle', exact: true }).press('Shift+ArrowLeft');
  assert.equal(await page.getByLabel('Clip start time', { exact: true }).inputValue(), '00:00:02.000');
  await until(() => page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), 'temporary framing/keyboard rehearsal restores the acknowledged draft');
  await page.reload(); await page.getByTestId('clip-editor').waitFor();
  await until(async () => await page.getByLabel('Clip name', { exact: true }).inputValue() === editorDraft.name, 'draft restores by URL after reload');
  assert.equal(await page.getByLabel('Clip start time', { exact: true }).inputValue(), '00:00:02.000');
  const playhead = page.getByRole('slider', { name: 'Timeline playhead', exact: true });
  await playhead.press('Home'); await playhead.press('Shift+ArrowRight');
  for (let frame = 0; frame < 15; frame++) await playhead.press('ArrowRight');
  await until(() => page.locator('video').evaluate(video => Math.abs(video.currentTime - 3.495) < .3), 'timeline seeking uses project-relative time plus the source trim');
  await page.getByRole('button', { name: 'Play preview', exact: true }).click(); await until(() => page.locator('video').evaluate(video => !video.paused && video.currentTime > 3.5), 'clip playback');
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await until(() => page.evaluate(() => !!document.fullscreenElement), 'native fullscreen enters');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await until(() => page.evaluate(() => !document.fullscreenElement), 'native fullscreen exits');
  await page.getByLabel('Clip name', { exact: true }).fill('Unsaved work stays in this window');
  await page.getByRole('link', { name: 'Back to recordings', exact: true }).click();
  const leaveDialog = page.getByRole('dialog', { name: 'Leave this project without saving?', exact: true });
  await leaveDialog.waitFor(); await leaveDialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.getByLabel('Clip name', { exact: true }).inputValue(), 'Unsaved work stays in this window');
  await page.getByLabel('Clip name', { exact: true }).fill(editorDraft.name);
  await until(() => page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), 'navigation safeguard keeps and restores local unsaved work');
  await page.locator('body').click({ position: { x: 5, y: 150 } }); await page.keyboard.press('Space'); await page.keyboard.press('Shift+Space'); await page.keyboard.press('Control+1');
  assert.deepEqual(mutations, [], 'Editor shortcuts never send Studio scene/audio mutations');
  await page.screenshot({ path: path.join(directory, 'clip-editor-portrait.png'), fullPage: true });
  await unchangedLive('Editor playback, trimming, framing and saved draft reload');
  checks.push('Trim in/out, portrait crop position, timeline seeking/playback and named draft survive reload; local keyboard controls never switch Studio');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export your edit', exact: true }); await exportDialog.waitFor();
  await exportDialog.getByLabel('Export file format', { exact: true }).selectOption('mp4');
  await exportDialog.getByLabel('Export resolution', { exact: true }).selectOption('1080p');
  await exportDialog.getByRole('button', { name: 'Start export', exact: true }).click();
  const portraitJob = await until(async () => (await workspace()).exports.find(job => job.draftId === editorDraft.id), 'editor queues its saved snapshot');
  await page.getByTestId('clip-export-job').filter({ hasText: editorDraft.name }).waitFor();
  const portraitComplete = await completedExport(portraitJob.id);
  await verifyMp4(portraitComplete, 1080, 1920, 4, 'green');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: `Download MP4 ${editorDraft.name}`, exact: true }).click();
  assert.match((await download).suggestedFilename(), /\.mp4$/i, 'Completed export downloads from editor');

  const remoteDraft = await saveDraft(editorDraft, { name: 'Title acknowledged in another editor window' });
  await page.getByLabel('Clip name', { exact: true }).fill('Local edit survives a conflict');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('alert').getByText(/Your edits are still here/).waitFor();
  assert.equal(await page.getByLabel('Clip name', { exact: true }).inputValue(), 'Local edit survives a conflict', '409 keeps unsaved text instead of refreshing it away');
  assert.equal((await workspace()).drafts.find(draft => draft.id === editorDraft.id).name, remoteDraft.name);
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click();
  editorDraft = await until(async () => (await workspace()).drafts.find(draft => draft.name === 'Local edit survives a conflict copy'), 'conflicting local work saves as an independent copy');
  assert.notEqual(editorDraft.id, remoteDraft.id); assert.equal(editorDraft.positionX, 1);
  checks.push('Native fullscreen, editor export/progress/download and revision-conflict recovery keep local edits; Save a copy never overwrites the other window');
  const landscapeJob = await exportDraft(updated); await verifyMp4(await completedExport(landscapeJob.id), 1920, 1080, 4, 'red');
  const square = await createDraft({ name: 'Square blue excerpt', format: '1:1', positionX: 0, inMs: 1000, outMs: 3000 });
  const squareJob = await exportDraft(square); await verifyMp4(await completedExport(squareJob.id), 1080, 1080, 2, 'blue');
  const contained = await createDraft({ name: 'Letterboxed screen-safe excerpt', format: '1:1', fit: 'contain', positionX: 1, positionY: 1, inMs: 1000, outMs: 2000 });
  const containedJob = await exportDraft(contained), containedFile = await verifyMp4(await completedExport(containedJob.id), 1080, 1080, 1, 'red');
  const bar = (await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', containedFile, '-frames:v', '1', '-vf', 'crop=20:20:(iw-20)/2:20,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])).output;
  assert.ok([...bar].every(value => value < 12), `Contain fitting centres the source with true black bars: ${[...bar]}`);
  await unchangedLive('Three decoded MP4 aspect ratios');
  checks.push('Real FFmpeg exports decode as H.264/yuv420p with AAC; precise trim durations, landscape/portrait/square dimensions and left/right crop content are verified');

  let longDraft = await createDraft({ name: 'Long cancellation rehearsal', inMs: 0, outMs: 36000, format: '9:16' });
  const cancelJob = await exportDraft(longDraft);
  await until(async () => ['exporting', 'queued'].includes((await workspace()).exports.find(job => job.id === cancelJob.id)?.status), 'export cancellation opportunity');
  await json(await teammate.request.post(`${base}/api/clips/exports/${cancelJob.id}/cancel`));
  await until(async () => (await workspace()).exports.find(job => job.id === cancelJob.id)?.status === 'cancelled', 'cancelled export is durable');
  assert.equal((await teammate.request.get(`${base}/api/clips/exports/${cancelJob.id}/download`)).status(), 409);
  assert.equal((await secondTeammate.request.post(`${base}/api/clips/exports/${portraitJob.id}/cancel`)).status(), 403);

  // A real, isolated renderer protects live production. Only these explicit
  // admin API calls start/stop it; clip teammates remain unable to do either.
  const pausedJob = await exportDraft(longDraft);
  await until(async () => (await workspace()).exports.find(job => job.id === pausedJob.id)?.status === 'exporting', 'long export starts before live production');
  const starting = admin.request.post(`${base}/api/studio/engine/start`);
  await until(async () => (await workspace()).exports.find(job => job.id === pausedJob.id)?.status === 'waiting-live', 'starting the engine preempts an active export', 30000);
  await json(await starting);
  await until(async () => (await engineStatus()).state === 'running', 'isolated production engine running', 30000);
  await until(async () => (await engineStatus()).levels.master > .01, 'persistent Main audio remains audible during independent clip work', 20000);
  const waitingCancel = await exportDraft(updated);
  await page.getByRole('button', { name: `Cancel export ${updated.name}`, exact: true }).click();
  await until(async () => (await workspace()).exports.find(job => job.id === waitingCancel.id)?.status === 'cancelled', 'editor UI cancels a waiting job without touching live production');
  const protectedJob = await exportDraft(updated);
  await until(async () => (await workspace()).exports.find(job => job.id === protectedJob.id)?.status === 'waiting-live', 'export queues while engine runs');
  longDraft = await saveDraft(longDraft, { name: 'Editing remains available during live production', inMs: 2000, outMs: 8000 });
  await page.reload(); await page.getByTestId('clip-editor').waitFor();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const liveExportDialog = page.getByRole('dialog', { name: 'Export your edit', exact: true });
  await liveExportDialog.getByText(/Live production is protected/).waitFor();
  await liveExportDialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  // Simulate a newly-finalized recording whose server poster must wait for
  // production. The visible client decodes one frame, without a server worker.
  const posterPending = async route => {
    const response = await route.fetch(), document = await response.json();
    document.recordings.forEach(recording => { recording.posterReady = false; });
    await route.fulfill({ response, json: document });
  };
  await page.route('**/api/clips', posterPending); await page.goto(`${base}/recordings`);
  await until(() => card.locator('.clip-thumbnail img').evaluate(image => image.src.startsWith('data:image/jpeg') && image.complete && image.naturalWidth > 0), 'client thumbnail fallback while server processing waits for live production');
  await page.unroute('**/api/clips', posterPending);
  await page.waitForTimeout(1000);
  assert.equal((await workspace()).exports.find(job => job.id === protectedJob.id).status, 'waiting-live');
  assert.equal((await engineStatus()).state, 'running'); await unchangedLive('Export waits, editing remains available during live production', null);
  await json(await admin.request.post(`${base}/api/studio/engine/stop`));
  const resumedJob = await completedExport(pausedJob.id);
  assert.equal(resumedJob.name, 'Long cancellation rehearsal');
  assert.equal(resumedJob.settings.inMs, 0); assert.equal(resumedJob.settings.outMs, 36000, 'Queued exports keep their own snapshot while draft trimming changes');
  await verifyMp4(resumedJob, 1080, 1920, 36, 'red');
  await completedExport(protectedJob.id);
  checks.push('Cancellation is durable/private; a real engine start preempts an active export, queued work waits and visible thumbnail fallback/teammate editing remain usable; both jobs resume after the explicit operator stop');

  const interruptedJob = await exportDraft(longDraft);
  await until(async () => (await workspace()).exports.find(job => job.id === interruptedJob.id)?.status === 'exporting', 'unfinished export before restart');
  const savedWorkspace = await workspace(); await stopServer(); await startServer();
  const restored = await workspace();
  assert.deepEqual(restored.drafts, savedWorkspace.drafts, 'Draft settings, names, revisions and ownership persist a station restart');
  assert.deepEqual(restored.exports.filter(job => job.id !== interruptedJob.id), savedWorkspace.exports.filter(job => job.id !== interruptedJob.id), 'Completed/cancelled export metadata persist a station restart');
  assert.equal(restored.exports.find(job => job.id === interruptedJob.id)?.status, 'interrupted', 'Unfinished export is explicitly interrupted, never silently resumed');
  assert.equal((await teammate.request.get(`${base}/api/clips/exports/${interruptedJob.id}/download`)).status(), 409, 'Partial exports are not downloadable');
  assert.ok(!(await fs.readdir(path.join(directory, 'clips', 'exports'))).some(filename => filename.endsWith('.partial.mp4')), 'Restart cleans partial output without modifying originals');
  await verifyMp4(restored.exports.find(job => job.id === portraitJob.id), 1080, 1920, 4, 'green');
  await unchangedLive('Station restart');
  checks.push('Saved drafts, ownership/revisions, completed/cancelled jobs and playable original/MP4 files survive a station restart');

  for (const [width, height] of [[1512, 982], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height }); await page.goto(`${base}/recordings/${recordingId}/editor?draft=${editorDraft.id}`); await page.getByTestId('clip-editor').waitFor();
    await until(() => page.locator('video').evaluate(video => video.readyState >= 2), `${width}px editor playable`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `Editor must not overflow horizontally at ${width}px`);
    const frame = await page.getByTestId('clip-preview').boundingBox();
    assert.ok(Math.abs(frame.width / frame.height - 9 / 16) < .02, `Portrait preview preserves the output ratio at ${width}px: ${frame.width}×${frame.height}`);
    assert.ok(await page.getByRole('button', { name: 'Save draft', exact: true }).isVisible());
    await page.screenshot({ path: path.join(directory, `clip-editor-${width}.png`), fullPage: true });
    await page.goto(`${base}/recordings`); await page.getByTestId('recording-library').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `Library must not overflow horizontally at ${width}px`);
  }
  checks.push('Desktop, tablet and phone library/editor layouts remain usable with no horizontal overflow');
  // Corrupt optional post-production metadata must not prevent live Studio or
  // originals from loading. Preserve the bad bytes for deliberate recovery.
  await page.close(); page = null; await stopServer();
  const indexPath = path.join(directory, 'clips', 'clips.json'), corrupt = Buffer.from('{ damaged optional Clips metadata for regression');
  await fs.writeFile(indexPath, corrupt); await startServer();
  assert.equal((await admin.request.get(`${base}/api/studio`)).status(), 200, 'Studio remains available when optional Clips index is corrupt');
  assert.equal((await teammate.request.get(`${base}/api/studio/recordings/${recordingId}/download`)).status(), 200, 'Original recording download remains available when Clips is unavailable');
  assert.equal((await teammate.request.get(`${base}/api/clips`)).status(), 503, 'Clips reports its own recoverable startup error');
  assert.deepEqual(await fs.readFile(indexPath), corrupt, 'Corrupt metadata is preserved byte-for-byte, not silently replaced');
  await unchangedLive('Corrupt optional Clips metadata');
  checks.push('Corrupt optional Clips metadata is preserved and isolated: Studio and original downloads remain available while Clips responds 503');
  assert.deepEqual(errors, [], 'No browser errors or native dialogs'); assert.deepEqual(mutations, [], 'No editor/library Studio writes');
  console.log(JSON.stringify({ ok: true, checks, directory }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'clips-failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ ok: false, error: error.stack, checks, errors, mutations, directory, logs: logs.slice(-7000) }, null, 2)); process.exitCode = 1;
} finally { await browser?.close(); await stopServer(); }
