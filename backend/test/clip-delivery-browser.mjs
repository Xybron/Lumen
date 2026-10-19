// Real HTTP/FFmpeg exports on a disposable station. The native file picker is
// simulated; all captured files are written only beneath this test's temp dir.
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
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clip-delivery-'));
const port = Number(process.env.LUMEN_CLIP_DELIVERY_TEST_PORT ?? 3466), base = `http://127.0.0.1:${port}`;
const recordingId = 'rec_delivery_fixture', recordingName = 'Service camera delivery fixture';
const original = path.join(directory, 'recordings', recordingId, 'recording.webm'), tone = path.join(directory, 'stereo-tone.wav');
const errors = [], studioMutations = [], clipMutations = [], events = [], captured = [], downloads = [], checks = [];
let server, browser, admin, editor, anonymous, fallback, page, fallbackPage, draft, logs = '', productionBefore, statusBefore, recordingsBefore, contentBefore, originalHash;
console.log(JSON.stringify({ phase: 'starting', directory, port }));
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });

async function until(fn, label, timeout = 45000) {
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
  const rate = 16000, frames = rate * 9, data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 4, 40);
  for (let index = 0; index < frames; index++) { data.writeInt16LE(Math.round(.3 * 32767 * Math.sin(2 * Math.PI * 440 * index / rate)), 44 + index * 4); data.writeInt16LE(Math.round(.15 * 32767 * Math.sin(2 * Math.PI * 660 * index / rate)), 46 + index * 4); }
  await fs.writeFile(tone, data);
}
async function startServer() {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'disposable delivery station starts');
}
async function stopServer() {
  const child = server; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 6500).unref(); });
}
async function json(response, expected = 200) { assert.equal(response.status(), expected, await response.text()); return response.json(); }
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const workspace = async () => json(await editor.request.get(`${base}/api/clips`));
const production = async () => json(await admin.request.get(`${base}/api/studio`));
const engineStatus = async () => json(await admin.request.get(`${base}/api/studio/status`));
const card = (job, target = page) => target.locator(`[data-testid="export-progress-card"][data-job-id="${job.id}"]`);
const exportUrl = (job, type = 'download') => `${base}/api/clips/exports/${job.id}/${type}`;
const makeItem = (id, name, sourceIn, startMs, durationMs = 2000) => ({ id, name, kind: 'video', source: { kind: 'recording', id: recordingId }, startMs, inMs: sourceIn, durationMs, x: 0, y: 0, width: 1, height: 1, fit: 'cover', positionX: .5, positionY: .5, opacity: 1, volume: .7, muted: false, text: '', fontSize: 64, fontWeight: 600, color: '#ffffff', background: '#00000000', align: 'center' });
const videoTrack = (id, items, extra = {}) => ({ id, name: id, kind: 'video', hidden: false, muted: false, locked: false, items, ...extra });
function baseTimeline() {
  return { version: 1, background: '#000000', tracks: [
    videoTrack('Main', [makeItem('red', 'Red opening', 0, 0), makeItem('blue', 'Blue message', 3000, 2000), makeItem('green', 'Green ending', 6000, 4000)]),
    videoTrack('Short', [makeItem('short_a', 'Short a', 0, 0, 400), makeItem('short_b', 'Short b', 1000, 400, 1000)], { hidden: true, muted: true }),
    videoTrack('Locked', [makeItem('locked_a', 'Locked a', 0, 0), makeItem('locked_b', 'Locked b', 3000, 2000)], { hidden: true, muted: true, locked: true }),
    videoTrack('Gap', [makeItem('gap_a', 'Gap a', 0, 0), makeItem('gap_b', 'Gap b', 3000, 2300)], { hidden: true, muted: true }),
  ] };
}
async function fill(label, value, target = page) { const control = target.getByLabel(label, { exact: true }); await control.fill(String(value)); await control.press('Tab'); }
async function save() {
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  draft = await until(async () => {
    const id = new URL(page.url()).searchParams.get('draft'), saved = (await workspace()).drafts.find(value => value.id === id);
    return saved && await page.locator('.clips-draft-state').innerText() === 'Saved' && saved;
  }, 'client acknowledges the saved draft revision'); return draft;
}
async function navigate(target, url) {
  // The real router keeps the app-level delivery store alive across workspaces.
  await target.evaluate(async path => { await document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path); }, url);
  await until(() => new URL(target.url()).pathname === url.split('?')[0], `SPA route ${url}`);
}
async function unchanged(label) {
  assert.deepEqual(await production(), productionBefore, `${label}: Program, Preview, outputs and Main audio stay untouched`);
  await until(async () => JSON.stringify(await engineStatus()) === JSON.stringify(statusBefore), `${label}: production engine remains idle`);
  assert.deepEqual(await json(await admin.request.get(`${base}/api/studio/recordings`)), recordingsBefore);
  assert.deepEqual(await json(await admin.request.get(`${base}/api/content`)), contentBefore);
  assert.equal(hash(await fs.readFile(original)), originalHash); assert.deepEqual(studioMutations, []);
  for (const target of [page, fallbackPage]) if (target && !target.isClosed()) assert.deepEqual(await target.evaluate(() => window.__deliveryDevices), { play: 0, capture: 0 }, `${label}: editing/delivery never plays media or requests physical capture`);
}
async function initializePage(target, nativePicker) {
  target.setDefaultTimeout(15000);
  await target.exposeBinding('__deliveryPickerObserved', (_source, event) => { events.push({ type: 'picker', ...event }); });
  await target.exposeBinding('__captureDelivery', async (_source, value) => {
    const buffer = Buffer.from(value.bytes), filename = path.join(directory, `saved-${captured.length + 1}-${value.name.replace(/[^a-zA-Z0-9._-]/g, '-')}`);
    await fs.writeFile(filename, buffer); const record = { filename, name: value.name, bytes: buffer.length, hash: hash(buffer) }; captured.push(record); return record.hash;
  });
  await target.addInitScript(({ nativePicker }) => {
    window.__deliveryFake = { mode: 'normal', calls: [], writers: [], permissions: [], failureUsed: false, closed: false, closeRequested: false };
    window.__deliveryDevices = { play: 0, capture: 0 };
    HTMLMediaElement.prototype.play = function () { window.__deliveryDevices.play++; return Promise.reject(new DOMException('Only paused editing is used by this test.', 'NotAllowedError')); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__deliveryDevices.capture++; throw new DOMException('Physical devices are outside this fixture.', 'NotAllowedError'); };
    const picker = async options => {
      const state = window.__deliveryFake, event = { name: options.suggestedName, active: navigator.userActivation.isActive, mode: state.mode, options, pathname: location.pathname };
      state.calls.push(event); await window.__deliveryPickerObserved(event);
      if (state.mode === 'cancel') throw new DOMException('User cancelled the save picker.', 'AbortError');
      const name = options.suggestedName, handle = {
        kind: 'file', name,
        queryPermission: async () => state.mode === 'permission-prompt' ? 'prompt' : 'granted',
        requestPermission: async () => { state.permissions.push({ active: navigator.userActivation.isActive }); return 'granted'; },
        createWritable: async () => {
          const writer = { chunks: [], sizes: [], closed: false, aborted: false }; state.writers.push(writer);
          return {
            async write(value) {
              if (state.mode === 'write-fail-once' && !state.failureUsed) { state.failureUsed = true; throw new DOMException('Simulated full destination disk.', 'QuotaExceededError'); }
              const bytes = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer()); writer.sizes.push(bytes.byteLength); writer.chunks.push(Array.from(bytes));
            },
            async close() {
              state.closeRequested = true;
              if (state.mode === 'hold-close') await new Promise(resolve => { window.__deliveryFinishClose = resolve; });
              await window.__captureDelivery({ name, bytes: writer.chunks.flat() }); writer.closed = true; state.closed = true;
            },
            async abort() { writer.aborted = true; },
          };
        },
        getFile: async () => new File([new Uint8Array(state.writers.at(-1)?.chunks.flat() ?? [])], name, { type: options.types[0] ? Object.keys(options.types[0].accept)[0] : 'application/octet-stream' }),
      };
      return handle;
    };
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, writable: true, value: nativePicker ? picker : undefined });
  }, { nativePicker });
  target.on('pageerror', error => errors.push(error.message));
  target.on('dialog', async dialog => { errors.push(`Unexpected native ${dialog.type()} dialog: ${dialog.message()}`); await dialog.dismiss(); });
  target.on('download', download => { downloads.push({ page: target, download }); });
  target.on('request', request => {
    if (!['POST', 'PUT', 'DELETE'].includes(request.method())) return;
    const pathname = new URL(request.url()).pathname, event = { type: 'request', method: request.method(), pathname, data: request.postDataJSON() };
    events.push(event); if (pathname.startsWith('/api/studio')) studioMutations.push(event);
    if (pathname.startsWith('/api/clips')) clipMutations.push(event);
  });
}
async function mode(value, target = page) { await target.evaluate(value => { window.__deliveryFake.mode = value; window.__deliveryFake.failureUsed = false; window.__deliveryFake.closed = false; window.__deliveryFake.closeRequested = false; }, value); }
async function openExport(target = page, container = 'mp4') {
  await target.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = target.getByRole('dialog', { name: 'Export your edit', exact: true }); await dialog.waitFor();
  await dialog.getByLabel('Export file format', { exact: true }).selectOption(container);
  const resolution = dialog.getByLabel('Export resolution', { exact: true }); if (!await resolution.isDisabled()) await resolution.selectOption('720p');
  return dialog;
}
async function startExport(target = page, container = 'mp4', chooseFirst = false) {
  const before = new Set((await workspace()).exports.map(value => value.id)), dialog = await openExport(target, container);
  if (chooseFirst) await dialog.getByRole('button', { name: 'Choose export save location', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  const job = await until(async () => (await workspace()).exports.find(value => !before.has(value.id)), 'destination-first export queues a temporary immutable job');
  assert.equal(job.temporary, true); assert.equal(job.options.container, container);
  await card(job, target).waitFor(); return job;
}
async function completed(job) {
  return until(async () => { const value = (await workspace()).exports.find(value => value.id === job.id); assert.notEqual(value?.status, 'error', value?.error); return value?.status === 'complete' && value; }, `render ${job.id} completes`, 150000);
}
async function saved(job, target = page) {
  await until(async () => await card(job, target).getAttribute('data-state') === 'saved', `confirmed save ${job.id}`, 150000);
  return until(async () => { const value = (await workspace()).exports.find(value => value.id === job.id); return value?.deliveredAt && value; }, 'server receives post-close delivery acknowledgement');
}
async function decodeSaved(record, container = 'mp4') {
  const result = await runFfmpeg(['-hide_banner', '-i', record.filename, '-t', '0.1', '-f', 'null', '-']);
  assert.match(result.diagnostics, new RegExp(`Audio: ${container === 'wav' ? 'pcm_s16le' : 'aac'}`));
  if (container === 'mp4') assert.match(result.diagnostics, /Video: h264[^\n]*1280x720/);
  else assert.doesNotMatch(result.diagnostics, /Stream #[^\n]*Video:/);
  const raw = (await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', record.filename, '-t', '0.5', '-vn', '-ac', '2', '-ar', '16000', '-f', 'f32le', '-'])).output;
  let energies = [0, 0]; for (let offset = 0; offset < raw.length; offset += 8) { energies[0] += raw.readFloatLE(offset) ** 2; energies[1] += raw.readFloatLE(offset + 4) ** 2; }
  energies = energies.map(value => Math.sqrt(value / (raw.length / 8))); assert.ok(energies[0] > .08 && energies[1] > .035 && energies[0] > energies[1] * 1.5, 'Saved bytes decode to the real recorded stereo mix');
  return energies;
}

try {
  await fs.mkdir(path.dirname(original), { recursive: true }); await writeTone();
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "color=c=red:s=640x360:r=15,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,3)',drawbox=x=0:y=0:w=iw:h=ih:color=lime:t=fill:enable='gte(t,6)'", '-i', tone, '-t', '9', '-threads', '2', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '180k', '-c:a', 'libopus', original]);
  originalHash = hash(await fs.readFile(original)); const bytes = (await fs.stat(original)).size;
  await fs.writeFile(path.join(path.dirname(original), 'recording.json'), JSON.stringify({ id: recordingId, name: recordingName, status: 'complete', createdAt: '2026-10-19T13:00:00.000Z', durationMs: 9000, bytes, nextChunk: 1 }));
  await fs.mkdir(path.join(directory, 'media', 'music'), { recursive: true }); await fs.copyFile(tone, path.join(directory, 'media', 'music', 'persistent-main.wav'));
  await startServer(); browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--force-color-profile=srgb'] });
  admin = await browser.newContext(); editor = await browser.newContext({ viewport: { width: 1512, height: 982 }, acceptDownloads: true }); anonymous = await browser.newContext(); fallback = await browser.newContext({ viewport: { width: 1512, height: 982 }, acceptDownloads: true });
  await json(await admin.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  await json(await admin.request.post(`${base}/api/users`, { data: { username: 'deliveryeditor', displayName: 'Content team', password: 'test-delivery-password' } }));
  for (const context of [editor, fallback]) { const identity = await json(await context.request.post(`${base}/api/auth/login`, { data: { username: 'deliveryeditor', password: 'test-delivery-password' } })); assert.deepEqual(identity.grants, []); }
  const content = await json(await admin.request.get(`${base}/api/content`));
  content.playlists = [{ id: 'pl_delivery_a', name: 'Presentation A', items: [] }, { id: 'pl_delivery_b', name: 'Presentation B', items: [] }];
  content.channels = [{ id: 'chnl_delivery_a', name: 'Presentation A', kind: 'presentation', playlistId: 'pl_delivery_a', defaultMode: 'manual' }, { id: 'chnl_delivery_b', name: 'Presentation B', kind: 'presentation', playlistId: 'pl_delivery_b', defaultMode: 'manual' }];
  await json(await admin.request.put(`${base}/api/content`, { data: content }));
  const studio = await production(); studio.sources.push({ id: 'delivery_main', name: 'Persistent Main audio', kind: 'audio', url: 'media/music/persistent-main.wav', loop: true, audio: { muted: true, volume: .65, mode: 'follow', delayMs: 35 } }); studio.masterVolume = .75; studio.masterMuted = false;
  await json(await admin.request.put(`${base}/api/studio`, { data: studio }));
  async function command(value) { const state = await production(); await json(await admin.request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: value } })); }
  await command({ type: 'set-main-audio', sourceId: 'delivery_main' }); await command({ type: 'take', sceneId: studio.scenes[0].id });
  if (studio.outputs[0]) await command({ type: 'route', outputId: studio.outputs[0].id, sceneId: studio.scenes[1].id });
  const preview = await production(); preview.previewSceneId = preview.scenes[1].id; await json(await admin.request.put(`${base}/api/studio`, { data: preview }));
  productionBefore = await production(); statusBefore = await engineStatus(); recordingsBefore = await json(await admin.request.get(`${base}/api/studio/recordings`)); contentBefore = await json(await admin.request.get(`${base}/api/content`));
  draft = await json(await editor.request.post(`${base}/api/clips/drafts`, { data: { recordingId, name: 'Delivery verification', inMs: 0, outMs: 9000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5, timeline: baseTimeline() } }), 201);
  page = await editor.newPage(); await initializePage(page, true);
  await page.goto(`${base}/recordings/${recordingId}/editor?draft=${draft.id}`); await page.getByTestId('clip-editor').waitFor();
  await page.getByRole('button', { name: 'Select clip Blue message', exact: true }).click(); await page.getByRole('button', { name: 'Transitions', exact: true }).click();
  await page.getByRole('button', { name: 'Apply Dissolve transition', exact: true }).click(); await fill('Transition duration', .5); draft = await save();
  const beforeBulk = JSON.parse(JSON.stringify(draft.timeline)), revision = draft.revision;
  assert.match(await page.locator('#transition-bulk-count').innerText(), /1 cut to update.*3 skipped/);
  await page.getByRole('button', { name: 'Apply to all cuts', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Apply to all cuts', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), true, 'One undo returns exactly to the already-saved baseline.');
  assert.match(await page.locator('#transition-bulk-count').innerText(), /1 cut to update.*3 skipped/);
  assert.deepEqual((await workspace()).drafts.find(value => value.id === draft.id).timeline, beforeBulk);
  await page.getByRole('button', { name: 'Redo edit', exact: true }).click(); draft = await save();
  assert.ok(draft.revision > revision); assert.deepEqual(draft.timeline.tracks[0].items.map(item => item.startMs), [0, 1500, 3000]);
  assert.deepEqual(draft.timeline.tracks[0].items.slice(1).map(item => item.transitionIn), [{ kind: 'dissolve', durationMs: 500 }, { kind: 'dissolve', durationMs: 500 }]);
  for (let index = 1; index < draft.timeline.tracks.length; index++) assert.deepEqual(draft.timeline.tracks[index], beforeBulk.tracks[index]);
  checks.push('Apply to all uses the exact selected duration, reports short/locked/gap skips, and is one undo/redo action with saved source/audio preservation');

  await mode('cancel'); const beforeCancel = (await workspace()).exports.length, beforeCancelWrites = clipMutations.length;
  let dialog = await openExport(); await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.__deliveryFake.calls.length)) === 1, 'cancelled save picker was called');
  assert.equal((await workspace()).exports.length, beforeCancel); assert.equal(clipMutations.length, beforeCancelWrites);
  assert.equal(await dialog.isVisible(), true); await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__deliveryFake.calls[0].active), true);
  checks.push('Cancelling the native destination picker creates no draft save, render job, download or release');

  await mode('hold-close'); await fill('Clip name', 'Chosen destination service');
  const eventStart = events.length, pickedBefore = await page.evaluate(() => window.__deliveryFake.calls.length), exportedBefore = (await workspace()).exports.length;
  dialog = await openExport(); await dialog.getByRole('button', { name: 'Choose export save location', exact: true }).click();
  assert.match(await dialog.getByTestId('export-destination').innerText(), /Chosen destination service\.mp4/);
  assert.equal((await workspace()).exports.length, exportedBefore);
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  const chosen = await until(async () => (await workspace()).exports.find(job => job.name === 'Chosen destination service'), 'selected destination export job');
  assert.equal(chosen.temporary, true); await until(async () => await page.evaluate(() => window.__deliveryFake.closeRequested), 'stream reaches the gated writable close', 150000);
  const completeChosen = await completed(chosen); assert.ok(completeChosen.expiresAt); assert.ok(Math.abs(Date.parse(completeChosen.expiresAt) - Date.parse(completeChosen.completedAt) - 24 * 60 * 60 * 1000) < 1000);
  assert.equal(completeChosen.deliveredAt, undefined); assert.equal(clipMutations.some(event => event.pathname === `/api/clips/exports/${chosen.id}/release`), false);
  assert.equal(await page.evaluate(() => window.__deliveryFake.calls.length), pickedBefore + 1, 'Start uses the already selected handle, not a second picker');
  const referenceResponse = await editor.request.get(exportUrl(chosen)); assert.equal(referenceResponse.status(), 200); const reference = await referenceResponse.body();
  const thumbResponse = await editor.request.get(exportUrl(chosen, 'thumbnail')); assert.equal(thumbResponse.status(), 200); const thumbnail = await sharp(await thumbResponse.body()).metadata(); assert.equal(thumbnail.width, 640); assert.equal(thumbnail.height, 360);
  const chosenEvents = events.slice(eventStart), pickerIndex = chosenEvents.findIndex(value => value.type === 'picker'), saveIndex = chosenEvents.findIndex(value => value.type === 'request' && value.method === 'PUT' && value.pathname.includes('/drafts/'));
  assert.ok(pickerIndex >= 0 && saveIndex > pickerIndex, 'Picker happens before the asynchronous dirty-draft save');
  assert.equal(chosenEvents[pickerIndex].active, true);
  assert.equal(await card(chosen).getAttribute('data-state'), 'saving'); assert.ok(await card(chosen).getByRole('progressbar').count());
  await page.getByRole('link', { name: 'Lumen home', exact: true }).click();
  await page.getByRole('button', { name: 'Presentation B — presentation', exact: true }).click(); await card(chosen).waitFor();
  await page.getByRole('button', { name: 'Presentation A — presentation', exact: true }).click(); assert.equal(await card(chosen).getAttribute('data-state'), 'saving');
  await page.screenshot({ path: path.join(directory, 'delivery-progress-across-channels.png'), fullPage: true });
  await page.evaluate(() => { window.__deliveryFinishClose(); }); const delivered = await saved(chosen);
  assert.ok(delivered.deliveredAt); assert.equal((await editor.request.get(exportUrl(chosen))).status(), 410); assert.equal((await editor.request.get(exportUrl(chosen, 'thumbnail'))).status(), 410);
  const file = captured.at(-1); assert.equal(file.hash, hash(reference)); assert.equal(file.bytes, completeChosen.bytes); await decodeSaved(file);
  assert.ok(await card(chosen).getByRole('button', { name: `Open saved file ${chosen.name}`, exact: true }).count());
  const retained = await card(chosen).locator('img').evaluate(image => ({ url: image.src, ready: image.complete && image.naturalWidth > 0 })); assert.equal(retained.ready, true); assert.match(retained.url, /^blob:/);
  assert.equal(await card(chosen).getByRole('button', { name: /open.*folder/i }).count(), 0, 'No unsupported reveal-in-folder promise');
  const writerSizes = await page.evaluate(() => window.__deliveryFake.writers.flatMap(writer => writer.sizes)); assert.ok(writerSizes.every(size => size <= 65536));
  await page.screenshot({ path: path.join(directory, 'delivery-saved-with-retained-thumbnail.png'), fullPage: true });
  await unchanged('Confirmed native save');
  checks.push('Native destination is chosen before asynchronous save/render; actual HTTP bytes stream in bounded chunks, retain a real thumbnail, wait for close, then acknowledge and remove only scratch exports');
  checks.push('App-level progress and success persist across Presentation channels without changing Program, Preview, Main audio or originals');

  for (const url of ['/live/chnl_delivery_a', '/studio/output/program', '/studio/engine']) { await navigate(page, url); assert.equal(await page.getByTestId('export-progress-overlay').count(), 0, `No operator delivery overlay on ${url}`); }
  await navigate(page, `/recordings/${recordingId}/editor?draft=${draft.id}`); await page.getByTestId('clip-editor').waitFor(); assert.equal(await card(chosen).getAttribute('data-state'), 'saved');
  await unchanged('Projection and engine routes');
  checks.push('Public channel live views, Studio outputs and the managed engine never display operator export overlays');

  await mode('write-fail-once'); const failed = await startExport(); await completed(failed);
  await until(async () => (await page.evaluate(() => window.__deliveryFake.writers.at(-1)?.aborted)) && await card(failed).getByRole('button', { name: `Retry save ${failed.name}`, exact: true }).isEnabled(), 'failed file write becomes a manual retry');
  assert.equal((await workspace()).exports.find(job => job.id === failed.id).deliveredAt, undefined); assert.equal((await editor.request.get(exportUrl(failed))).status(), 200);
  assert.equal(clipMutations.some(event => event.pathname === `/api/clips/exports/${failed.id}/release`), false);
  await mode('permission-prompt'); await card(failed).getByRole('button', { name: `Retry save ${failed.name}`, exact: true }).click(); await saved(failed);
  assert.equal(await page.evaluate(() => window.__deliveryFake.permissions.at(-1)?.active), true); assert.equal((await editor.request.get(exportUrl(failed))).status(), 410); await decodeSaved(captured.at(-1));
  checks.push('Failed writable aborts without acknowledging cleanup; explicit permission-aware retry saves the same job and releases only after success');

  await mode('normal'); let rejectedAcknowledgement = false;
  const releaseFailure = async route => { if (!rejectedAcknowledgement) { rejectedAcknowledgement = true; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Simulated cleanup connection failure"}' }); } else await route.continue(); };
  await page.route('**/api/clips/exports/*/release', releaseFailure);
  const cleanup = await startExport(); await completed(cleanup);
  await until(async () => await card(cleanup).getAttribute('data-state') === 'saved' && await card(cleanup).getByRole('button', { name: `Retry cleanup for ${cleanup.name}`, exact: true }).isEnabled(), 'closed file stays saved when cleanup acknowledgement fails', 150000);
  assert.equal((await workspace()).exports.find(job => job.id === cleanup.id).deliveredAt, undefined); assert.equal((await editor.request.get(exportUrl(cleanup))).status(), 200);
  const savedBeforeCleanup = captured.length, writesBeforeCleanup = await page.evaluate(() => window.__deliveryFake.writers.length);
  await card(cleanup).getByRole('button', { name: `Retry cleanup for ${cleanup.name}`, exact: true }).click();
  await until(async () => (await workspace()).exports.find(job => job.id === cleanup.id).deliveredAt, 'cleanup-only retry acknowledges the already-closed file');
  assert.equal(captured.length, savedBeforeCleanup); assert.equal(await page.evaluate(() => window.__deliveryFake.writers.length), writesBeforeCleanup); assert.equal((await editor.request.get(exportUrl(cleanup))).status(), 410);
  await page.unroute('**/api/clips/exports/*/release', releaseFailure);
  checks.push('Post-close cleanup connection failure preserves the successful file and retries acknowledgement without rewriting or falsely losing the saved result');

  await mode('write-fail-once'); const recover = await startExport(); await completed(recover);
  await until(async () => (await page.evaluate(() => window.__deliveryFake.failureUsed && window.__deliveryFake.writers.at(-1)?.aborted)) && await card(recover).getByRole('button', { name: `Retry save ${recover.name}`, exact: true }).isEnabled(), 'second file failure retains a recoverable temporary job');
  const capturesBeforeReload = captured.length, downloadsBeforeReload = downloads.length;
  await page.reload(); await page.getByTestId('clip-editor').waitFor(); await card(recover).waitFor();
  assert.equal(await page.evaluate(() => window.__deliveryFake.calls.length), 0, 'Reload does not silently re-open a native picker');
  assert.equal(captured.length, capturesBeforeReload); assert.equal(downloads.length, downloadsBeforeReload);
  assert.equal((await workspace()).exports.find(job => job.id === recover.id).deliveredAt, undefined);
  await card(recover).getByRole('button', { name: `Choose save location for ${recover.name}`, exact: true }).click(); await saved(recover); await decodeSaved(captured.at(-1));
  checks.push('Reload recovers current-user job metadata without serializing a file handle, auto-downloading or guessing permission; a fresh user gesture resumes saving');

  fallbackPage = await fallback.newPage(); await initializePage(fallbackPage, false); await fallbackPage.goto(`${base}/recordings/${recordingId}/editor?draft=${draft.id}`); await fallbackPage.getByTestId('clip-editor').waitFor();
  const downloadCount = downloads.length, fallbackJob = await startExport(fallbackPage, 'wav'); await completed(fallbackJob);
  await until(async () => await card(fallbackJob, fallbackPage).getAttribute('data-state') === 'ready' && await card(fallbackJob, fallbackPage).getByRole('button', { name: `Download ${fallbackJob.name}`, exact: true }).isEnabled(), 'fallback waits for an explicit browser download gesture', 150000);
  assert.equal(downloads.length, downloadCount, 'Rendering never silently starts a browser download');
  await card(fallbackJob, fallbackPage).getByRole('button', { name: `Download ${fallbackJob.name}`, exact: true }).click();
  await until(async () => await card(fallbackJob, fallbackPage).getAttribute('data-state') === 'download-requested', 'fallback honestly marks requested, not saved', 150000);
  await until(() => downloads.length > downloadCount, 'browser fallback requests a download');
  const download = downloads.at(-1).download, fallbackPath = path.join(directory, 'fallback-browser-download.wav'); await download.saveAs(fallbackPath);
  await decodeSaved({ filename: fallbackPath }, 'wav'); assert.match(await card(fallbackJob, fallbackPage).innerText(), /cannot confirm|can't confirm|check.*Downloads/i);
  assert.equal((await workspace()).exports.find(job => job.id === fallbackJob.id).deliveredAt, undefined); assert.equal((await editor.request.get(exportUrl(fallbackJob))).status(), 200);
  assert.equal(clipMutations.some(event => event.pathname === `/api/clips/exports/${fallbackJob.id}/release`), false);
  assert.equal(await card(fallbackJob, fallbackPage).getByRole('button', { name: `Open saved file ${fallbackJob.name}`, exact: true }).count(), 0);
  await fallbackPage.screenshot({ path: path.join(directory, 'delivery-browser-download-unconfirmed.png'), fullPage: true });
  assert.equal((await anonymous.request.get(exportUrl(fallbackJob))).status(), 401); assert.equal((await anonymous.request.post(exportUrl(fallbackJob, 'release'), { data: {} })).status(), 401);
  await unchanged('Unconfirmed browser Downloads fallback');
  checks.push('Browsers without native picker use actual audio Downloads, explicitly remain unconfirmed with no release ACK, and keep the private temporary file until TTL');
  assert.deepEqual(errors, []);
  assert.ok(events.filter(event => event.type === 'picker').every(event => event.active), 'Every picker begins within its initiating user gesture');
  assert.ok(clipMutations.filter(event => event.pathname.endsWith('/exports')).every(event => event.data?.temporary === true));
  console.log(JSON.stringify({ ok: true, directory, checks, captured, downloads: downloads.length, browserErrors: errors, studioWrites: studioMutations, exports: (await workspace()).exports.map(({ id, status, temporary, deliveredAt, expiresAt }) => ({ id, status, temporary, deliveredAt, expiresAt })) }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'delivery-failure.png'), fullPage: true }).catch(() => {});
  if (fallbackPage && !fallbackPage.isClosed()) await fallbackPage.screenshot({ path: path.join(directory, 'delivery-fallback-failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(directory, 'server.log'), logs); await fs.writeFile(path.join(directory, 'events.json'), JSON.stringify({ events, clipMutations, studioMutations, errors, captured }, null, 2));
  console.error(JSON.stringify({ ok: false, directory, checks, error: error.stack, browserErrors: errors, studioWrites: studioMutations, logs: logs.slice(-10000) }, null, 2)); process.exitCode = 1;
} finally { if (browser) await browser.close().catch(() => {}); await stopServer(); }
