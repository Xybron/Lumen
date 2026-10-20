// Disposable edit station: generated colours and stereo tones, never operator
// recordings or physical devices. Run only after the integrated app build.
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
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-nle-transitions-'));
const port = Number(process.env.LUMEN_TRANSITIONS_TEST_PORT ?? 3465), base = `http://127.0.0.1:${port}`;
const recordingId = 'rec_transition_fixture', recordingName = 'Service camera · red, blue and green';
const original = path.join(directory, 'recordings', recordingId, 'recording.webm'), tone = path.join(directory, 'stereo-tone.wav');
const errors = [], studioMutations = [], clipMutations = [], checks = [], decoded = [];
let server, browser, page, admin, editor, other, anonymous, draft, logs = '';
console.log(JSON.stringify({ phase: 'starting', directory, port }));
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });

async function until(fn, label, timeout = 30000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }), output = [], diagnostics = [];
    child.stdout.on('data', value => output.push(value)); child.stderr.on('data', value => diagnostics.push(value));
    child.once('error', reject); child.once('close', code => code === 0 ? resolve({ output: Buffer.concat(output), diagnostics: Buffer.concat(diagnostics).toString() }) : reject(new Error(Buffer.concat(diagnostics).toString())));
  });
}
async function writeTone() {
  const rate = 16000, length = rate * 9, data = Buffer.alloc(44 + length * 4);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(length * 4, 40);
  for (let index = 0; index < length; index++) {
    const time = index / rate, frequency = [220, 440, 660][Math.min(2, Math.floor(time / 3))];
    data.writeInt16LE(Math.round(.3 * 32767 * Math.sin(2 * Math.PI * frequency * time)), 44 + index * 4);
    data.writeInt16LE(Math.round(.15 * 32767 * Math.sin(2 * Math.PI * frequency * 1.5 * time)), 46 + index * 4);
  }
  await fs.writeFile(tone, data);
}
async function startServer() {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'disposable transition station starts');
}
async function stopServer() {
  const child = server; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 6500).unref(); });
}
async function json(response, expected = 200) { assert.equal(response.status(), expected, await response.text()); return response.json(); }
const workspace = async () => json(await editor.request.get(`${base}/api/clips`));
const production = async () => json(await admin.request.get(`${base}/api/studio`));
const engineStatus = async () => json(await admin.request.get(`${base}/api/studio/status`));
const fields = value => Object.fromEntries(['name', 'inMs', 'outMs', 'format', 'fit', 'positionX', 'positionY', 'timeline'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const makeItem = (id, name, offset) => ({ id, name, kind: 'video', source: { kind: 'recording', id: recordingId }, startMs: offset, inMs: offset, durationMs: 3000, x: 0, y: 0, width: 1, height: 1, fit: 'cover', positionX: .5, positionY: .5, opacity: 1, volume: .7, muted: false, text: '', fontSize: 64, fontWeight: 600, color: '#ffffff', background: '#00000000', align: 'center' });
const baseTimeline = () => ({ version: 1, background: '#000000', tracks: [
  { id: 'main_track', name: 'Main video', kind: 'video', hidden: false, muted: false, locked: false, items: [makeItem('red_first', 'Red opening', 0), makeItem('blue_second', 'Blue message', 3000), makeItem('green_third', 'Green ending', 6000)] },
  { id: 'overlay_track', name: 'Overlay', kind: 'video', hidden: false, muted: false, locked: false, items: [] },
  { id: 'audio_track', name: 'Audio', kind: 'audio', hidden: false, muted: false, locked: false, items: [] },
] });
const timelineEnd = timeline => Math.max(...timeline.tracks.flatMap(track => track.items.map(item => item.startMs + item.durationMs)));
async function fill(label, value) { const element = page.getByLabel(label, { exact: true }); await element.fill(String(value)); await element.press('Tab'); }
async function selectClip(name = 'Blue message') { await page.getByRole('button', { name: `Select clip ${name}`, exact: true }).click(); }
async function save() {
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  draft = await until(async () => { const id = new URL(page.url()).searchParams.get('draft'), saved = (await workspace()).drafts.find(value => value.id === id); return saved && await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled() && await page.locator('.clips-draft-state').innerText() === 'Saved' && saved; }, 'transition edit acknowledges saved revision');
  return draft;
}
async function mediaSettled() {
  await until(async () => {
    const pending = await page.locator('[data-preview-kind][data-state="loading"], [data-preview-kind][data-state="queued"], [data-preview-kind][data-state="processing"]').count();
    const ready = await page.locator('[data-preview-kind][data-state="ready"] img').evaluateAll(images => images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0));
    return !pending && ready;
  }, 'source-aligned timeline strips and waveforms decode', 90000);
}
async function rulerGeometry() {
  return page.locator('.nle-ruler').evaluate(element => {
    const tick = [...element.querySelectorAll('.nle-ruler-tick')].find(value => Number.parseFloat(value.style.left) > 0);
    const ms = tick.textContent.trim().split(':').map(Number).reduce((sum, value) => sum * 60 + value, 0) * 1000, rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2, scale: Number.parseFloat(tick.style.left) / ms };
  });
}
async function seek(ms, timeline = draft.timeline) {
  const geometry = await rulerGeometry(); await page.mouse.click(geometry.x + ms * geometry.scale, geometry.y);
  const active = timeline.tracks.flatMap(track => track.items.filter(item => item.kind === 'video' && ms >= item.startMs && ms < item.startMs + item.durationMs));
  await until(async () => {
    const clock = await page.locator('.nle-player-time').evaluate(element => element.textContent.match(/^\s*(\d+):(\d+):(\d+(?:\.\d+)?)/).slice(1).map(Number));
    if (Math.abs((clock[0] * 3600 + clock[1] * 60 + clock[2]) * 1000 - ms) > 60) return false;
    for (const item of active) {
      const state = await page.locator(`[data-preview-item="${item.id}"] video`).evaluate(video => ({ ready: video.readyState >= 2 && !video.seeking, paused: video.paused, time: video.currentTime * 1000, muted: video.muted }));
      if (!state.ready || !state.paused || !state.muted || Math.abs(state.time - (item.inMs + ms - item.startMs)) > 130) return false;
    }
    return true;
  }, `Both sides of the overlap seek their true paused source at ${ms} ms`);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function pictureSamples(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Stay away from the exact 25/50/75% wipe boundary, where one frame of
  // quantisation may legitimately choose the opposite neighbouring pixel.
  return [.12, .43, .88].map(fraction => { const index = (Math.floor(info.height / 2) * info.width + Math.floor(info.width * fraction)) * info.channels; return [...data.subarray(index, index + 3)]; });
}
async function picture(ms) { await seek(ms); return pictureSamples(await page.getByTestId('clip-preview').screenshot()); }
async function editorScreenshot(filename) {
  await page.locator('.nle-transition-panel, .nle-inspector-body').evaluateAll(elements => { for (const element of elements) element.scrollTop = 0; });
  await page.screenshot({ path: path.join(directory, filename), fullPage: true });
}
function assertDominant(rgb, name, message) { const channel = { red: 0, green: 1, blue: 2 }[name]; assert.ok(rgb[channel] > rgb[(channel + 1) % 3] + 70 && rgb[channel] > rgb[(channel + 2) % 3] + 70, `${message}: ${rgb}`); }
async function verifyStripAlignment() {
  await mediaSettled(); const { scale } = await rulerGeometry();
  for (const clip of draft.timeline.tracks[0].items) {
    const media = page.locator(`[data-item-id="${clip.id}"] [data-timeline-media]`); assert.equal(await media.count(), 1);
    const values = await media.evaluate(element => ({ windowLeft: Number(element.dataset.windowLeft), frames: [...element.querySelectorAll('[data-preview-kind="frame"]')].map(tile => ({ at: Number(tile.dataset.atMs), x: Number.parseFloat(tile.style.left), width: Number.parseFloat(tile.style.width) })), waves: [...element.querySelectorAll('[data-preview-kind="waveform"]')].map(tile => ({ at: Number(tile.dataset.atMs), x: Number.parseFloat(tile.style.left), width: Number.parseFloat(tile.style.width) })) }));
    assert.ok(values.frames.length > 0 && values.frames.length <= 36); assert.ok(values.waves.length > 0);
    for (const frame of values.frames) { const expected = Math.floor((clip.inMs + Math.min(clip.durationMs - 1, (values.windowLeft + frame.x + frame.width / 2) / scale)) / 100) * 100; assert.ok(Math.abs(frame.at - expected) <= 100, 'Filmstrip positions follow source in-point, not the overlapped timeline start'); }
    for (const wave of values.waves) { assert.ok(Math.abs(wave.x - ((wave.at - clip.inMs) * scale - values.windowLeft)) < .1); assert.ok(Math.abs(wave.width - 30000 * scale) < .1); }
  }
}

// Accessible labels are kept independent of the panel's visual layout.
async function applyTransition(kind, durationMs = 1000) {
  await selectClip(); await page.getByRole('button', { name: 'Transitions', exact: true }).click();
  const names = { dissolve: 'Dissolve', 'wipe-left': 'Wipe left', 'wipe-right': 'Wipe right', 'slide-left': 'Slide left', 'slide-right': 'Slide right' };
  await page.getByRole('button', { name: `Apply ${names[kind]} transition`, exact: true }).click();
  await fill('Transition duration', durationMs / 1000);
}
async function clearTransition() { await selectClip(); await page.getByRole('button', { name: 'Transitions', exact: true }).click(); await page.getByRole('button', { name: 'Remove transition', exact: true }).click(); }
async function exportThroughDialog(container, resolution) {
  const previous = new Set((await workspace()).exports.map(value => value.id));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your edit', exact: true }); await dialog.waitFor();
  const format = dialog.getByLabel('Export file format', { exact: true }), size = dialog.getByLabel('Export resolution', { exact: true });
  assert.deepEqual((await format.locator('option').evaluateAll(options => options.map(option => option.value))).sort(), ['mov', 'mp3', 'mp4', 'wav', 'webm']);
  await format.selectOption(container);
  assert.equal(await size.isDisabled(), container === 'mp3' || container === 'wav', 'Audio-only exports do not imply a video resolution');
  if (!await size.isDisabled()) await size.selectOption(resolution);
  if (container === 'mp4' && previous.size === 0 || container === 'mp3') await page.screenshot({ path: path.join(directory, `export-dialog-${container}.png`), fullPage: true });
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  const job = await until(async () => (await workspace()).exports.find(value => !previous.has(value.id)), `${container} export queues an immutable saved draft`);
  assert.equal(job.temporary, true, 'Destination-first renders are temporary until an explicit confirmed save.');
  assert.equal(job.options.container, container); assert.equal(job.draftRevision, draft.revision); assert.deepEqual(job.settings.timeline, draft.timeline);
  if (!['mp3', 'wav'].includes(container)) assert.equal(job.options.resolution, resolution);
  return job;
}
async function completedExport(id) { return until(async () => { const value = (await workspace()).exports.find(job => job.id === id); assert.notEqual(value?.status, 'error', value?.error); return value?.status === 'complete' && value; }, `Export ${id} completes`, 150000); }
async function decodeExport(job, container, resolution, reference) {
  const response = await editor.request.get(`${base}/api/clips/exports/${job.id}/download`); assert.equal(response.status(), 200, await response.text());
  assert.match(response.headers()['content-disposition'] ?? '', new RegExp(`\\.${container}(?:"|$)`));
  const mime = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' }[container]; assert.ok((response.headers()['content-type'] ?? '').startsWith(mime));
  const filename = path.join(directory, `${job.id}.${container}`); await fs.writeFile(filename, await response.body());
  const probe = await runFfmpeg(['-hide_banner', '-i', filename, '-t', '0.1', '-f', 'null', '-']);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.diagnostics); assert.ok(duration);
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]); assert.ok(Math.abs(seconds - timelineEnd(job.settings.timeline) / 1000) < .25, `Export duration ${seconds} includes a true overlap instead of a repeated cut`);
  const audioCodec = { mp4: 'aac', mov: 'aac', webm: 'opus', mp3: 'mp3', wav: 'pcm_s16le' }[container]; assert.match(probe.diagnostics, new RegExp(`Audio: ${audioCodec}`));
  const audio = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', '2.2', '-i', filename, '-t', '0.5', '-vn', '-ac', '2', '-ar', '16000', '-f', 'f32le', '-']);
  let energy = [0, 0], maximum = 0; const samples = audio.output.length / 8; assert.ok(samples > 5000);
  for (let index = 0; index < samples; index++) for (let channel = 0; channel < 2; channel++) { const value = audio.output.readFloatLE(index * 8 + channel * 4); energy[channel] += value * value; maximum = Math.max(maximum, Math.abs(value)); }
  energy = energy.map(value => Math.sqrt(value / samples)); assert.ok(energy[0] > .035 && energy[1] > .015, 'Overlap exports preserve real stereo audio, not a silent seam'); assert.ok(energy[0] > energy[1] * 1.25 && maximum < .65, 'Audio crossfade preserves channel balance without an overlap volume spike');
  if (container === 'mp3' || container === 'wav') assert.doesNotMatch(probe.diagnostics, /Stream #[^\n]*Video:/, 'Audio-only exports contain no hidden video stream');
  else {
    const width = resolution === '720p' ? 1280 : 1920, height = resolution === '720p' ? 720 : 1080;
    assert.match(probe.diagnostics, new RegExp(`Video: ${container === 'webm' ? 'vp9' : 'h264'}`)); assert.match(probe.diagnostics, new RegExp(`\\b${width}x${height}\\b`));
    for (const [ms, expected] of reference) {
      const frame = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', String(ms / 1000), '-i', filename, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']);
      const actual = await pictureSamples(frame.output);
      for (let point = 0; point < actual.length; point++) for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(actual[point][channel] - expected[point][channel]) <= 45, `${container} transition at ${ms} ms matches the real browser preview (${actual[point]} vs ${expected[point]})`);
    }
  }
  assert.equal((await anonymous.request.get(`${base}/api/clips/exports/${job.id}/download`)).status(), 401);
  const range = await editor.request.get(`${base}/api/clips/exports/${job.id}/download`, { headers: { Range: 'bytes=0-255' } }); assert.equal(range.status(), 206); assert.equal((await range.body()).length, 256);
  assert.equal((await workspace()).exports.find(value => value.id === job.id).deliveredAt, undefined, 'Reading a browser download never claims native file delivery.');
  // Completed progress cards are operator chrome. Dismiss them before the next
  // pixel comparison; this does not acknowledge or release the temporary file.
  const progressCard = page.locator(`[data-testid="export-progress-card"][data-job-id="${job.id}"]`);
  await until(async () => await progressCard.getByRole('button', { name: `Dismiss export ${job.name}`, exact: true }).isEnabled(), 'finished fallback export can be dismissed without claiming delivery');
  await progressCard.getByRole('button', { name: `Dismiss export ${job.name}`, exact: true }).click();
  decoded.push({ container, resolution: container === 'mp3' || container === 'wav' ? 'audio-only' : resolution, duration: seconds, rms: energy, filename });
}

try {
  await fs.mkdir(path.dirname(original), { recursive: true }); await writeTone();
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "color=c=red:s=640x360:r=30,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,3)',drawbox=x=0:y=0:w=iw:h=ih:color=lime:t=fill:enable='gte(t,6)'", '-i', tone, '-t', '9', '-threads', '2', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-c:a', 'libopus', original]);
  const originalHash = createHash('sha256').update(await fs.readFile(original)).digest('hex'), bytes = (await fs.stat(original)).size;
  await fs.writeFile(path.join(path.dirname(original), 'recording.json'), JSON.stringify({ id: recordingId, name: recordingName, status: 'complete', createdAt: '2026-10-19T11:00:00.000Z', durationMs: 9000, bytes, nextChunk: 1 }));
  await fs.mkdir(path.join(directory, 'media', 'music'), { recursive: true }); await fs.copyFile(tone, path.join(directory, 'media', 'music', 'persistent-main.wav'));
  await startServer(); browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--force-color-profile=srgb'] });
  admin = await browser.newContext(); editor = await browser.newContext({ viewport: { width: 1512, height: 982 } }); other = await browser.newContext(); anonymous = await browser.newContext();
  await json(await admin.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  for (const [context, username] of [[editor, 'transitioneditor'], [other, 'transitionother']]) { await json(await admin.request.post(`${base}/api/users`, { data: { username, displayName: username, password: 'test-transition-password' } })); const identity = await json(await context.request.post(`${base}/api/auth/login`, { data: { username, password: 'test-transition-password' } })); assert.deepEqual(identity.grants, []); }
  const studio = await production(); studio.sources.push({ id: 'transition_main', name: 'Persistent service audio', kind: 'audio', url: 'media/music/persistent-main.wav', loop: true, audio: { muted: true, volume: .65, mode: 'follow', delayMs: 30 } }); studio.masterVolume = .75; studio.masterMuted = false;
  await json(await admin.request.put(`${base}/api/studio`, { data: studio }));
  async function command(value) { const state = await production(); await json(await admin.request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: value } })); }
  await command({ type: 'set-main-audio', sourceId: 'transition_main' }); await command({ type: 'take', sceneId: studio.scenes[0].id });
  if (studio.outputs[0]) await command({ type: 'route', outputId: studio.outputs[0].id, sceneId: studio.scenes[1].id });
  const preview = await production(); preview.previewSceneId = preview.scenes[1].id; await json(await admin.request.put(`${base}/api/studio`, { data: preview }));
  const productionBefore = await production(), statusBefore = await engineStatus(), recordingsBefore = await json(await admin.request.get(`${base}/api/studio/recordings`));
  async function unchanged(label) { assert.deepEqual(await production(), productionBefore, `${label}: Program, Preview, outputs and Main audio are untouched`); assert.deepEqual(await engineStatus(), statusBefore); assert.deepEqual(await json(await admin.request.get(`${base}/api/studio/recordings`)), recordingsBefore); assert.equal(createHash('sha256').update(await fs.readFile(original)).digest('hex'), originalHash); assert.deepEqual(studioMutations, []); assert.deepEqual(await page.evaluate(() => window.__transitionDeviceActivity), { play: 0, capture: 0 }); }
  draft = await json(await editor.request.post(`${base}/api/clips/drafts`, { data: { recordingId, name: 'Transition verification', inMs: 0, outMs: 9000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5, timeline: baseTimeline() } }), 201);
  page = await editor.newPage(); page.setDefaultTimeout(15000);
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, writable: true, value: undefined }); window.__transitionDeviceActivity = { play: 0, capture: 0 }; window.__transitionBeforeUnload = []; const prevent = Event.prototype.preventDefault; Event.prototype.preventDefault = function (...args) { if (this.type === 'beforeunload') window.__transitionBeforeUnload.push(new Error('Before-unload cancellation').stack); return prevent.apply(this, args); }; HTMLMediaElement.prototype.play = function () { window.__transitionDeviceActivity.play++; return Promise.reject(new DOMException('Only paused source seeking is used in this fixture.', 'NotAllowedError')); }; if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__transitionDeviceActivity.capture++; throw new DOMException('Physical devices are outside this fixture.', 'NotAllowedError'); }; });
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => { errors.push(`Unexpected native ${dialog.type()} dialog`); await dialog.dismiss(); });
  page.on('request', request => { if (!['PUT', 'POST', 'DELETE'].includes(request.method())) return; const pathname = new URL(request.url()).pathname; if (pathname.startsWith('/api/studio')) studioMutations.push(`${request.method()} ${pathname}`); if (pathname.startsWith('/api/clips')) clipMutations.push(`${request.method()} ${pathname}`); });
  await page.goto(`${base}/recordings/${recordingId}/editor?draft=${draft.id}`); await page.getByTestId('clip-editor').waitFor();
  await verifyStripAlignment();
  const baselinePixels = {};
  for (const [ms, color] of [[500, 'red'], [3500, 'blue'], [6500, 'green']]) { const samples = await picture(ms); baselinePixels[color] = samples; for (const rgb of samples) assertDominant(rgb, color, 'The generated source starts as three honest cuts'); }
  console.log(JSON.stringify({ phase: 'baseline preview pixels', baselinePixels }));
  await unchanged('Initial transition editing');
  checks.push('Authenticated independent editor, true recorded colour/time fixture and decoded source-aligned strips/waveforms with live/main-audio/original protection');

  await selectClip('Red opening'); await fill('Audio fade out', 1);
  await selectClip(); await fill('Audio fade in', 1); draft = await save();
  assert.equal(draft.timeline.tracks[0].items[0].audioFadeOutMs, 1000); assert.equal(draft.timeline.tracks[0].items[1].audioFadeInMs, 1000);
  await applyTransition('dissolve', 1000); draft = await save();
  assert.deepEqual(draft.timeline.tracks[0].items.map(item => item.startMs), [0, 2000, 5000]); assert.deepEqual(draft.timeline.tracks[0].items.map(item => item.inMs), [0, 3000, 6000]); assert.equal(timelineEnd(draft.timeline), 8000);
  assert.deepEqual(draft.timeline.tracks[0].items[1].transitionIn, { kind: 'dissolve', durationMs: 1000 });
  const pendingDuration = page.getByLabel('Transition duration', { exact: true }), previousRevision = draft.revision;
  await pendingDuration.fill('0.75');
  assert.equal(await page.getByRole('button', { name: 'Save draft', exact: true }).isEnabled(), true, 'Typing a transition duration enables Save without requiring blur');
  await pendingDuration.press('Control+s');
  draft = await until(async () => { const saved = (await workspace()).drafts.find(value => value.id === draft.id); return saved?.revision > previousRevision && saved.timeline.tracks[0].items[1].transitionIn?.durationMs === 750 && await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled() && await page.locator('.clips-draft-state').innerText() === 'Saved' && saved; }, 'Ctrl+S flushes the exact still-focused transition duration');
  assert.deepEqual(draft.timeline.tracks[0].items.map(item => item.startMs), [0, 2250, 5250]);
  await fill('Transition duration', 1); draft = await save();
  await verifyStripAlignment();
  const dissolveReference = new Map();
  for (const ms of [2250, 2500, 2750]) {
    const samples = await picture(ms), progress = (ms - 2000) / 1000; dissolveReference.set(ms, samples);
    for (let point = 0; point < samples.length; point++) for (let channel = 0; channel < 3; channel++) {
      // Chromium's YUV compositor may differ slightly from its canvas/FFmpeg
      // conversion. A transition must blend the actual opaque browser source
      // colours linearly, not assume an ideal RGB triplet for compressed video.
      const expected = baselinePixels.red[point][channel] * (1 - progress) + baselinePixels.blue[point][channel] * progress;
      assert.ok(Math.abs(samples[point][channel] - expected) < 20, `Dissolve blends both real source frames smoothly at ${ms} ms, not black: ${samples[point]}`);
    }
  }
  await editorScreenshot('transition-dissolve-desktop.png');
  await fill('Transition duration', .5); draft = await save(); assert.deepEqual(draft.timeline.tracks[0].items.map(item => item.startMs), [0, 2500, 5500]); assert.equal(timelineEnd(draft.timeline), 8500);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click(); draft = await save(); assert.equal(draft.timeline.tracks[0].items[1].transitionIn.durationMs, 1000);
  await page.getByRole('button', { name: 'Redo edit', exact: true }).click(); draft = await save(); assert.equal(draft.timeline.tracks[0].items[1].transitionIn.durationMs, 500);
  // One captured trim gesture may temporarily clamp/remove an incoming cut.
  // Returning the pointer must restore the original cut and suffix, not keep
  // accumulating changes from the intermediate pointer-move events.
  await selectClip('Red opening');
  const beforeTrimGesture = structuredClone(draft.timeline), beforeTrimWrites = clipMutations.length;
  const endHandle = page.getByRole('slider', { name: 'Clip end handle', exact: true }), handleRect = await endHandle.boundingBox(), trimGeometry = await rulerGeometry();
  // The cut badge occupies the middle of the overlap. Grab the handle near its
  // top so this is a genuine trim gesture, not a click on that separate badge.
  const handleX = handleRect.x + handleRect.width / 2, handleY = handleRect.y + 8;
  await page.mouse.move(handleX, handleY); await page.mouse.down();
  for (const [length, expectedTransition] of [[200, '0.10s'], [100, null], [400, '0.20s']]) {
    await page.mouse.move(handleX - (3000 - length) * trimGeometry.scale, handleY, { steps: 4 });
    await until(async () => Math.abs(Number(await page.getByLabel('Timeline clip duration', { exact: true }).inputValue()) * 1000 - length) <= 10, `Captured trim temporarily reaches ${length} ms`);
    const cut = page.locator('[data-transition-for="blue_second"]');
    if (expectedTransition) await until(async () => (await cut.getAttribute('title'))?.includes(expectedTransition), 'The temporary cut uses the current gesture delta');
    else assert.equal(await cut.count(), 0, 'A too-short temporary source has no invalid incoming transition');
  }
  await page.mouse.move(handleX, handleY, { steps: 6 }); await page.mouse.up();
  assert.equal(await page.getByLabel('Timeline clip duration', { exact: true }).inputValue(), '3.00');
  assert.equal(await page.getByLabel('Clip end time', { exact: true }).inputValue(), '00:00:03.000');
  assert.match(await page.locator('[data-transition-for="blue_second"]').getAttribute('title'), /0\.50s/);
  for (const item of beforeTrimGesture.tracks[0].items) {
    const style = await page.locator(`[data-item-id="${item.id}"]`).evaluate(element => ({ left: Number.parseFloat(element.style.left), width: Number.parseFloat(element.style.width) }));
    assert.ok(Math.abs(style.left - item.startMs * trimGeometry.scale) < .1); assert.ok(Math.abs(style.width - item.durationMs * trimGeometry.scale) < .1, 'Returning a trim restores every source and following clip');
  }
  assert.equal(await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), true, 'A net-zero trim creates no unsaved edit');
  assert.equal(clipMutations.length, beforeTrimWrites); assert.deepEqual((await workspace()).drafts.find(value => value.id === draft.id).timeline, beforeTrimGesture);
  await clearTransition(); draft = await save(); assert.deepEqual(draft.timeline.tracks[0].items.map(item => item.startMs), [0, 3000, 6000]); assert.equal(draft.timeline.tracks[0].items[1].transitionIn, undefined);
  await applyTransition('dissolve', 1000); draft = await save();
  checks.push('Apply/change/clear duration, true neighbour overlap and following-clip ripple, source trims and explicit audio fades preserved, undo/redo and genuine multi-time dissolve preview');

  const beforeDialog = await workspace();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const cancelledDialog = page.getByRole('dialog', { name: 'Export your edit', exact: true }); await cancelledDialog.waitFor();
  await page.keyboard.press('Escape'); await cancelledDialog.waitFor({ state: 'hidden' });
  assert.deepEqual((await workspace()).exports, beforeDialog.exports, 'Closing export options never queues an unintended render');
  assert.deepEqual((await workspace()).drafts, beforeDialog.drafts, 'Export options do not edit the timeline');
  const jobDissolve = await exportThroughDialog('mp4', '720p');
  await decodeExport(await completedExport(jobDissolve.id), 'mp4', '720p', dissolveReference);
  for (const [kind, container, resolution] of [['wipe-left', 'webm', '720p'], ['wipe-right', 'mov', '1080p'], ['slide-left', 'mp4', '720p'], ['slide-right', 'mp4', '720p']]) {
    await applyTransition(kind, 1000); draft = await save(); assert.deepEqual(draft.timeline.tracks[0].items.map(item => item.startMs), [0, 2000, 5000]);
    const reference = new Map();
    for (const ms of [2250, 2500, 2750]) {
      const samples = await picture(ms); reference.set(ms, samples);
      assertDominant(samples[0], kind.endsWith('left') ? 'red' : 'blue', `${kind} uses the advertised incoming direction at ${ms} ms`);
      assertDominant(samples[2], kind.endsWith('left') ? 'blue' : 'red', `${kind} preserves the outgoing picture while the incoming picture moves in`);
    }
    await editorScreenshot(`transition-${kind}.png`);
    const job = await exportThroughDialog(container, resolution); await decodeExport(await completedExport(job.id), container, resolution, reference);
    assert.deepEqual((await workspace()).exports.find(value => value.id === jobDissolve.id).settings.timeline, jobDissolve.settings.timeline, 'Later effect edits cannot mutate an existing export snapshot');
  }
  checks.push('Dissolve, left/right wipe and left/right slide preview/export pixel parity; real H.264 MP4/MOV and VP9 WebM at 720p/1080p with stereo overlap audio and immutable export snapshots');

  for (const container of ['mp3', 'wav']) { const job = await exportThroughDialog(container, '720p'); await decodeExport(await completedExport(job.id), container, '720p', []); }
  assert.equal((await other.request.post(`${base}/api/clips/drafts/${draft.id}/exports`, { data: { revision: draft.revision, options: { container: 'wav', resolution: '720p' } } })).status(), 403);
  assert.equal((await editor.request.post(`${base}/api/clips/drafts/${draft.id}/exports`, { data: { revision: draft.revision, options: { container: 'exe', resolution: '720p' } } })).status(), 422);
  checks.push('Accessible export choices, audio-only resolution safeguard, genuine MP3/WAV stereo downloads with no video, private byte-range downloads and export ownership/format validation');

  await selectClip(); await seek(4000); await page.getByRole('button', { name: 'Split selected clip', exact: true }).click(); draft = await save();
  const blueParts = draft.timeline.tracks[0].items.filter(item => item.inMs >= 3000 && item.inMs < 6000); assert.equal(blueParts.length, 2); assert.ok(blueParts[0].transitionIn); assert.equal(blueParts[1].transitionIn, undefined, 'Split does not duplicate an incoming transition in the middle of a source');
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click(); draft = await save(); assert.equal(draft.timeline.tracks[0].items.length, 3);
  await selectClip('Green ending'); const green = await page.getByRole('button', { name: 'Select clip Green ending', exact: true }).boundingBox(), red = await page.getByRole('button', { name: 'Select clip Red opening', exact: true }).boundingBox();
  await page.evaluate(() => { window.__transitionReorderEvents = []; const host = document.querySelector('.nle-timeline-scroll'); for (const type of ['pointerdown', 'pointermove', 'gotpointercapture', 'lostpointercapture', 'pointerup']) host.addEventListener(type, event => { const target = event.target.closest('[data-item-id]'); if (target) window.__transitionReorderEvents.push({ type, id: target.dataset.itemId, x: event.clientX, captured: event.target.hasPointerCapture(event.pointerId) }); }, true); });
  await page.mouse.move(green.x + green.width / 2, green.y + green.height / 2); await page.mouse.down(); await page.mouse.move(red.x + 16, red.y + red.height / 2, { steps: 8 }); await page.mouse.up(); draft = await save();
  assert.equal(draft.timeline.tracks[0].items[0].name, 'Green ending'); assert.equal(draft.timeline.tracks[0].items[0].transitionIn, undefined, 'The new first clip cannot retain an orphan transition');
  assert.equal(draft.timeline.tracks[0].items.find(item => item.id === 'blue_second').transitionIn.kind, 'slide-right');
  await verifyStripAlignment(); const savedTimeline = structuredClone(draft.timeline);
  const beforeReopen = await page.evaluate(() => ({ label: document.querySelector('.clips-draft-state')?.textContent, saveDisabled: document.querySelector('[data-testid="clip-save"]')?.disabled, active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), value: document.activeElement?.value } }));
  console.log(JSON.stringify({ phase: 'saved project before reopening', beforeReopen }));
  assert.equal(beforeReopen.saveDisabled, true); assert.equal(beforeReopen.label, 'Saved');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByTestId('clip-editor').waitFor(); await mediaSettled(); assert.deepEqual((await workspace()).drafts.find(value => value.id === draft.id).timeline, savedTimeline);
  // Reload intentionally recovers outstanding temporary receipts without their
  // old browser destinations. Keep this transition-layout test unobstructed.
  await until(async () => (await page.getByTestId('export-progress-card').count()) > 0, 'outstanding fallback receipts are recovered after reload');
  while (await page.getByTestId('export-progress-card').count()) await page.getByTestId('export-progress-card').first().getByRole('button', { name: /^Dismiss export / }).click();
  await selectClip(); await page.getByRole('button', { name: 'Transitions', exact: true }).click(); assert.equal(await page.getByLabel('Transition duration', { exact: true }).inputValue(), '1');
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Transitions', exact: true }).click(); assert.ok(await page.getByRole('button', { name: 'Apply Dissolve transition', exact: true }).isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: path.join(directory, 'transition-phone.png'), fullPage: true });
  await unchanged('All transition previews, exports and durable editing'); assert.deepEqual(errors, []);
  checks.push('Transition-aware split/reorder, no orphan first-clip effects, source-aligned media after overlap, saved-draft reopening and usable phone transition controls');
  console.log(JSON.stringify({ ok: true, directory, checks, decoded, browserErrors: errors, studioMutations }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'transition-failure.png'), fullPage: true }).catch(() => {});
  const previewDiagnostics = page && !page.isClosed() ? await page.locator('[data-preview-item]').evaluateAll(elements => elements.map(element => { const video = element.querySelector('video'), style = getComputedStyle(element); let pixel; if (video?.readyState >= 2) { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1); pixel = [...context.getImageData(0, 0, 1, 1).data]; } return { id: element.dataset.previewItem, opacity: style.opacity, filter: style.filter, background: style.backgroundColor, time: video?.currentTime, pixel }; })).catch(() => []) : [];
  const reorderEvents = page && !page.isClosed() ? await page.evaluate(() => window.__transitionReorderEvents ?? []).catch(() => []) : [];
  const beforeUnloadCancellations = page && !page.isClosed() ? await page.evaluate(() => window.__transitionBeforeUnload ?? []).catch(() => []) : [];
  console.error(JSON.stringify({ ok: false, directory, error: error.stack ?? error.message, previewDiagnostics, reorderEvents, beforeUnloadCancellations, browserErrors: errors, studioMutations, decoded, logs: logs.slice(-6000) }, null, 2)); process.exitCode = 1;
} finally { if (browser) await browser.close().catch(() => {}); await stopServer(); }
