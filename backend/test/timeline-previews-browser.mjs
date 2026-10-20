// Generated sources and a disposable station only. Timeline visualisations
// must never play media, request a capture device or mutate live production.
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
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-timeline-previews-'));
const port = Number(process.env.LUMEN_TIMELINE_PREVIEW_TEST_PORT ?? 3464), base = `http://127.0.0.1:${port}`;
const recordingId = 'rec_timeline_fixture', recordingName = 'Service camera · red then blue';
const original = path.join(directory, 'recordings', recordingId, 'recording.webm');
const longAudio = path.join(directory, 'main-tone.wav'), importedVideo = path.join(directory, 'Silent green then yellow.mp4'), importedAudio = path.join(directory, 'Stereo tone and silence.wav');
const errors = [], studioWrites = [], clipWrites = [], previewRequests = [], checks = [], pendingPreviewRequests = new Set();
let maxPreviewRequests = 0;
let browser, server, page, admin, teammate, anonymous, logs = '';
console.log(JSON.stringify({ phase: 'starting', directory, port }));
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });

async function until(fn, label, timeout = 30000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }), chunks = [];
    child.stderr.on('data', data => chunks.push(data)); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(Buffer.concat(chunks).toString())));
  });
}
async function writeTone(filename, seconds) {
  const rate = 8000, frames = rate * seconds, channels = 2, bytes = frames * channels * 2;
  const data = Buffer.alloc(44 + bytes); data.write('RIFF', 0); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * channels * 2, 28); data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / rate, active = time % 4 < 2;
    data.writeInt16LE(active ? Math.round(.6 * 32767 * Math.sin(2 * Math.PI * 440 * time)) : 0, 44 + frame * 4);
    data.writeInt16LE(active ? Math.round(.3 * 32767 * Math.sin(2 * Math.PI * 660 * time)) : 0, 46 + frame * 4);
  }
  await fs.writeFile(filename, data);
}
async function startServer() {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'disposable preview station starts');
}
async function stopServer() { const child = server; if (!child || child.exitCode !== null || child.signalCode !== null) return; await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 6500).unref(); }); }
async function json(response, expected = 200) { assert.equal(response.status(), expected, await response.text()); return response.json(); }
const workspace = async () => json(await teammate.request.get(`${base}/api/clips`));
const production = async () => json(await admin.request.get(`${base}/api/studio`));
const engineStatus = async () => json(await admin.request.get(`${base}/api/studio/status`));
const previewUrl = (kind, id, type, atMs) => `${base}/api/clips/timeline/${kind}/${encodeURIComponent(id)}/${type}?atMs=${atMs}`;
const source = (kind, id) => ({ kind, id });
const item = (id, name, kind, media, patch = {}) => ({ id, name, kind, ...(media ? { source: media } : {}), startMs: 0, inMs: 0, durationMs: 12000, x: 0, y: 0, width: 1, height: 1, fit: 'cover', positionX: .5, positionY: .5, opacity: 1, volume: 1, muted: false, text: '', fontSize: 64, fontWeight: 600, color: '#ffffff', background: '#00000000', align: 'center', ...patch });
const track = (id, name, kind, items) => ({ id, name, kind, muted: false, hidden: false, locked: false, items });
async function imagePreview(kind, id, type, atMs) {
  return until(async () => {
    const response = await teammate.request.get(previewUrl(kind, id, type, atMs));
    if (response.status() === 202) { const data = await response.json(); assert.ok(['queued', 'processing', 'waiting-live'].includes(data.status)); return false; }
    assert.equal(response.status(), 200, await response.text()); assert.match(response.headers()['content-type'], /^image\//);
    return response.body();
  }, `${kind} ${type} at ${atMs} ms is generated`, 60000);
}
async function dominant(buffer, expected) { const rgb = await sharp(buffer).removeAlpha().resize(1, 1).raw().toBuffer(); const index = { red: 0, green: 1, blue: 2 }[expected]; assert.ok(rgb[index] > rgb[(index + 1) % 3] + 60 && rgb[index] > rgb[(index + 2) % 3] + 60, `Expected a genuine ${expected} source frame, received ${[...rgb]}`); }
async function waveformEnergy(buffer, startMs, endMs, half = 'both') {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 3000); assert.equal(info.height, 64);
  const background = [...data.subarray(0, 4)], from = Math.floor(startMs / 10), through = Math.min(3000, Math.ceil(endMs / 10));
  let energy = 0;
  for (let x = from; x < through; x++) for (let y = half === 'right' ? 32 : 0; y < (half === 'left' ? 32 : 64); y++) {
    const at = (y * info.width + x) * 4;
    if (Math.max(...background.map((value, channel) => Math.abs(data[at + channel] - value))) > 20) energy++;
  }
  return energy / Math.max(1, through - from);
}
async function fill(label, value) { const control = page.getByLabel(label, { exact: true }); await control.fill(String(value)); await control.press('Tab'); }
async function save() { await page.getByRole('button', { name: 'Save draft', exact: true }).click(); return until(async () => { const id = new URL(page.url()).searchParams.get('draft'); return await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled() && await page.locator('.clips-draft-state').innerText() === 'Saved' && (await workspace()).drafts.find(draft => draft.id === id); }, 'visual editor save acknowledges its revision'); }
async function mediaSettled(label) {
  await until(async () => {
    const count = await page.locator('[data-timeline-media]').count();
    const pending = await page.locator('[data-preview-kind][data-state="loading"], [data-preview-kind][data-state="queued"], [data-preview-kind][data-state="processing"]').count();
    const images = await page.locator('[data-preview-kind][data-state="ready"] img').evaluateAll(values => values.length > 0 && values.every(image => image.complete && image.naturalWidth > 0));
    return count > 0 && pending === 0 && images;
  }, `${label}: visible frame/waveform images finish decoding`, 90000);
}
async function scaleAndRuler() {
  return page.locator('.nle-ruler').evaluate(element => {
    const tick = [...element.querySelectorAll('.nle-ruler-tick')].find(value => Number.parseFloat(value.style.left) > 0), parts = tick.textContent.trim().split(':').map(Number), time = parts.reduce((sum, part) => sum * 60 + part, 0) * 1000;
    const rect = element.getBoundingClientRect(); return { scale: Number.parseFloat(tick.style.left) / time, x: rect.x, y: rect.y + rect.height / 2 };
  });
}
async function checkTileAlignment(draft, label) {
  const { scale } = await scaleAndRuler(), items = new Map(draft.timeline.tracks.flatMap(value => value.items).map(value => [value.id, value]));
  const views = await page.locator('[data-timeline-media]').evaluateAll(elements => elements.map(element => ({
    itemId: element.closest('[data-item-id]').dataset.itemId, sourceId: element.dataset.sourceId, sourceKind: element.dataset.sourceKind,
    windowLeft: Number(element.dataset.windowLeft), windowWidth: Number(element.dataset.windowWidth), localStart: Number(element.dataset.localStartMs), localEnd: Number(element.dataset.localEndMs),
    tiles: [...element.querySelectorAll('[data-preview-kind]')].map(tile => ({ kind: tile.dataset.previewKind, sourceId: tile.dataset.sourceId, atMs: Number(tile.dataset.atMs), left: Number.parseFloat(tile.style.left), width: Number.parseFloat(tile.style.width), state: tile.dataset.state })),
  })));
  assert.ok(views.length);
  for (const view of views) {
    const clip = items.get(view.itemId); assert.ok(clip, `${label}: visible media belongs to a real saved clip`); assert.equal(view.sourceId, clip.source.id); assert.equal(view.sourceKind, clip.source.kind);
    assert.ok(view.localStart >= 0 && view.localEnd <= clip.durationMs + 1);
    assert.ok(view.windowWidth <= 4353, 'Preview width is capped to a viewport plus bounded overscan');
    const frames = view.tiles.filter(tile => tile.kind === 'frame'), waves = view.tiles.filter(tile => tile.kind === 'waveform');
    assert.ok(frames.length <= 36 && waves.length <= 64, `${label}: one clip has bounded visual tile counts`);
    for (const tile of view.tiles) {
      assert.equal(tile.sourceId, clip.source.id);
      if (tile.kind === 'frame') {
        const localCentreMs = (view.windowLeft + tile.left + tile.width / 2) / scale;
        const expected = Math.floor(Math.max(0, clip.inMs + Math.min(clip.durationMs - 1, localCentreMs)) / 100) * 100;
        assert.ok(Math.abs(tile.atMs - expected) <= 100, `${label}: frame at ${tile.atMs} follows source trim ${clip.inMs} and local position, expected ${expected}`);
      } else {
        assert.equal(tile.atMs % 30000, 0);
        assert.ok(Math.abs(tile.left - ((tile.atMs - clip.inMs) * scale - view.windowLeft)) < .1, `${label}: waveform offsets follow source trim, not timeline start`);
        assert.ok(Math.abs(tile.width - 30000 * scale) < .1, `${label}: waveform preserves the actual 10 ms sample scale`);
      }
    }
  }
}
async function framePixels(itemId) {
  return page.locator(`[data-item-id="${itemId}"] [data-preview-kind="frame"][data-state="ready"]`).evaluateAll(elements => elements.map(element => {
    const image = element.querySelector('img'); if (!image?.complete || !image.naturalWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 1, 1);
    return { atMs: Number(element.dataset.atMs), rgb: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) };
  }).filter(Boolean));
}
async function verifyRecordedStrip(itemId) {
  const values = await framePixels(itemId); assert.ok(values.length, 'The recording strip contains decoded source images');
  for (const value of values) { const dominant = value.atMs < 6000 ? 0 : 2; assert.ok(value.rgb[dominant] > value.rgb[(dominant + 1) % 3] + 60 && value.rgb[dominant] > value.rgb[(dominant + 2) % 3] + 60, `Frame ${value.atMs} ms matches the real red/blue source, not a repeated poster: ${value.rgb}`); }
  return values;
}
async function assertClockAndVideo(ms, itemId = 'main_camera', sourceIn = 0) {
  await until(async () => {
    const clock = await page.locator('.nle-player-time').evaluate(element => element.textContent.match(/^\s*(\d+):(\d+):(\d+(?:\.\d+)?)/).slice(1).map(Number));
    const media = await page.locator(`[data-preview-item="${itemId}"] video`).evaluate(element => ({ current: element.currentTime * 1000, ready: element.readyState >= 2 && !element.seeking, paused: element.paused }));
    return Math.abs((clock[0] * 3600 + clock[1] * 60 + clock[2]) * 1000 - ms) < 100 && media.ready && media.paused && Math.abs(media.current - ms - sourceIn) < 120;
  }, `Scrub clock and real paused video reach ${ms} ms`);
}

try {
  await fs.mkdir(path.dirname(original), { recursive: true }); await writeTone(longAudio, 120); await writeTone(importedAudio, 12);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "color=c=red:s=640x360:r=10,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,6)'", '-i', longAudio, '-t', '120', '-threads', '2', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '180k', '-c:a', 'libopus', original]);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "color=c=lime:s=640x360:r=10,drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=fill:enable='gte(t,6)'", '-t', '12', '-threads', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', importedVideo]);
  const originalBytes = await fs.readFile(original), originalHash = createHash('sha256').update(originalBytes).digest('hex');
  await fs.writeFile(path.join(path.dirname(original), 'recording.json'), JSON.stringify({ id: recordingId, name: recordingName, status: 'complete', createdAt: '2026-10-19T08:00:00.000Z', durationMs: 120000, bytes: originalBytes.length, nextChunk: 1 }));
  await fs.mkdir(path.join(directory, 'media', 'music'), { recursive: true }); await fs.copyFile(importedAudio, path.join(directory, 'media', 'music', 'main.wav'));
  await startServer();
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  admin = await browser.newContext(); teammate = await browser.newContext({ viewport: { width: 1512, height: 982 } }); anonymous = await browser.newContext();
  await teammate.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); });
  await json(await admin.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  await json(await admin.request.post(`${base}/api/users`, { data: { username: 'previeweditor', displayName: 'Content team', password: 'test-preview-password' } }));
  const login = await json(await teammate.request.post(`${base}/api/auth/login`, { data: { username: 'previeweditor', password: 'test-preview-password' } })); assert.deepEqual(login.grants, []);
  const fixture = await production(); fixture.sources.push({ id: 'preview_main', name: 'Persistent main audio', kind: 'audio', url: 'media/music/main.wav', loop: true, audio: { muted: true, volume: .6, mode: 'follow', delayMs: 25 } });
  await json(await admin.request.put(`${base}/api/studio`, { data: fixture }));
  async function command(value) { const state = await production(); await json(await admin.request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: value } })); }
  await command({ type: 'set-main-audio', sourceId: 'preview_main' }); await command({ type: 'take', sceneId: fixture.scenes[0].id });
  if (fixture.outputs[0]) await command({ type: 'route', outputId: fixture.outputs[0].id, sceneId: fixture.scenes[1].id });
  const different = await production(); different.previewSceneId = different.scenes[1].id; await json(await admin.request.put(`${base}/api/studio`, { data: different }));
  const productionBefore = await production(), statusBefore = await engineStatus(), recordingsBefore = await json(await admin.request.get(`${base}/api/studio/recordings`));
  async function unchanged(label) {
    assert.deepEqual(await production(), productionBefore, `${label}: Preview, Program, outputs and Main audio are untouched`);
    assert.deepEqual(await engineStatus(), statusBefore, `${label}: visualization never starts production`);
    assert.deepEqual(await json(await admin.request.get(`${base}/api/studio/recordings`)), recordingsBefore, `${label}: original recording metadata is unchanged`);
    assert.equal(createHash('sha256').update(await fs.readFile(original)).digest('hex'), originalHash, `${label}: original bytes are unchanged`);
    assert.deepEqual(studioWrites, []);
    if (page) assert.deepEqual(await page.evaluate(() => window.__timelinePreviewActivity), { play: 0, capture: 0 }, `${label}: thumbnail/waveform rendering never plays audio or opens capture`);
  }
  async function upload(filename, mimeType, durationMs, width, height) { return json(await teammate.request.post(`${base}/api/clips/assets`, { multipart: { file: { name: path.basename(filename), mimeType, buffer: await fs.readFile(filename) }, durationMs: String(durationMs), width: String(width), height: String(height) } }), 201); }
  const videoAsset = await upload(importedVideo, 'video/mp4', 12000, 640, 360), audioAsset = await upload(importedAudio, 'audio/wav', 12000, 0, 0), offscreenAudioAsset = await upload(importedAudio, 'audio/wav', 12000, 0, 0);
  assert.equal((await anonymous.request.get(previewUrl('recording', recordingId, 'frame', 0))).status(), 401);
  assert.equal((await anonymous.request.get(previewUrl('asset', audioAsset.id, 'waveform', 0))).status(), 401);
  const red = await imagePreview('recording', recordingId, 'frame', 2000), blue = await imagePreview('recording', recordingId, 'frame', 8000);
  assert.equal((await sharp(red).metadata()).width, 192); assert.equal((await sharp(red).metadata()).height, 108); await dominant(red, 'red'); await dominant(blue, 'blue');
  const repeated = await imagePreview('recording', recordingId, 'frame', 2055); assert.equal(createHash('sha256').update(red).digest('hex'), createHash('sha256').update(repeated).digest('hex'), 'Frame requests share the 100 ms source cache quantum');
  await dominant(await imagePreview('asset', videoAsset.id, 'frame', 2000), 'green');
  const yellow = await sharp(await imagePreview('asset', videoAsset.id, 'frame', 8000)).removeAlpha().resize(1, 1).raw().toBuffer(); assert.ok(yellow[0] > 160 && yellow[1] > 160 && yellow[2] < 80, 'Imported video thumbnails change with the real green-to-yellow cut');
  const recordingWave = await imagePreview('recording', recordingId, 'waveform', 0), assetWave = await imagePreview('asset', audioAsset.id, 'waveform', 0);
  for (const [name, wave] of [['recording', recordingWave], ['imported audio', assetWave]]) {
    const tone = await waveformEnergy(wave, 500, 1000), silence = await waveformEnergy(wave, 2500, 3000);
    assert.ok(tone > silence * 3 + 6, `${name} waveform must distinguish real tone (${tone}) from silence (${silence})`);
    assert.ok(await waveformEnergy(wave, 500, 1000, 'left') > await waveformEnergy(wave, 500, 1000, 'right') * 1.2, `${name} waveform preserves distinct stereo channel amplitudes`);
  }
  assert.ok(await waveformEnergy(assetWave, 20000, 22000) < 3, 'The final waveform chunk pads beyond the source with genuine silence');
  const noAudio = await until(async () => { const response = await teammate.request.get(previewUrl('asset', videoAsset.id, 'waveform', 0)); if (response.status() === 202) return false; assert.equal(response.status(), 200); return response.json(); }, 'Silent video returns a graceful unavailable waveform');
  assert.equal(noAudio.status, 'unavailable'); assert.match(noAudio.reason, /audio/i);
  assert.equal((await teammate.request.get(previewUrl('recording', 'rec_missing_preview', 'frame', 0))).status(), 404);
  assert.equal((await teammate.request.get(previewUrl('recording', recordingId, 'frame', -1))).status(), 422);
  await unchanged('Real source thumbnails and measured stereo waveform API');
  checks.push('Private recording/imported-video source-time frame JPEGs, cached quantum reuse, actual stereo tone/silence waveform PNGs, final-chunk padding and silent-video fallback');

  const initialTimeline = { version: 1, background: '#000000', tracks: [
    track('track_main', 'Main video', 'video', [item('main_camera', recordingName, 'video', source('recording', recordingId), { durationMs: 120000 })]),
    track('track_overlay', 'Overlay', 'video', [item('silent_overlay', 'Silent imported video', 'video', source('asset', videoAsset.id), { x: .7, y: .05, width: .25, height: .25, muted: true }), item('far_overlay', 'Far-away imported video', 'video', source('asset', videoAsset.id), { startMs: 105000, durationMs: 12000, muted: true })]),
    track('track_audio', 'Audio', 'audio', [item('imported_audio', audioAsset.name, 'audio', source('asset', audioAsset.id))]),
    track('track_empty_audio_1', 'Audio 2', 'audio', []), track('track_empty_audio_2', 'Audio 3', 'audio', []), track('track_empty_audio_3', 'Audio 4', 'audio', []),
    track('track_offscreen_audio', 'Offscreen audio', 'audio', [item('offscreen_audio', 'Offscreen-only audio', 'audio', source('asset', offscreenAudioAsset.id), { muted: true })]),
  ] };
  let draft = await json(await teammate.request.post(`${base}/api/clips/drafts`, { data: { recordingId, name: 'Timeline preview verification', inMs: 0, outMs: 120000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5, timeline: initialTimeline } }), 201);
  const beforeView = await workspace();
  page = await teammate.newPage(); page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    window.__timelinePreviewActivity = { play: 0, capture: 0 };
    window.__timelinePreviewFetches = { active: 0, maximum: 0 };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const input = args[0], url = input instanceof Request ? input.url : String(input);
      if (!new URL(url, location.href).pathname.startsWith('/api/clips/timeline/')) return originalFetch(...args);
      const activity = window.__timelinePreviewFetches;
      activity.active++; activity.maximum = Math.max(activity.maximum, activity.active);
      try {
        const response = await originalFetch(...args);
        // Observe complete body lifetimes in the browser. Protocol requestfailed
        // events can arrive after the replacement request has already started.
        await response.clone().arrayBuffer();
        return response;
      } finally { activity.active--; }
    };
    HTMLMediaElement.prototype.play = function () { window.__timelinePreviewActivity.play++; return Promise.reject(new DOMException('Playback is disabled for visualization testing.', 'NotAllowedError')); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async function () { window.__timelinePreviewActivity.capture++; throw new DOMException('Physical capture is outside this fixture.', 'NotAllowedError'); };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { errors.push(`Unexpected native ${dialog.type()} dialog`); await dialog.dismiss(); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (['POST', 'PUT', 'DELETE'].includes(request.method())) { if (url.pathname.startsWith('/api/studio')) studioWrites.push(`${request.method()} ${url.pathname}`); if (url.pathname.startsWith('/api/clips')) clipWrites.push(`${request.method()} ${url.pathname}`); }
    if (url.pathname.startsWith('/api/clips/timeline/')) { previewRequests.push({ url: url.href, atMs: Number(url.searchParams.get('atMs')), frame: url.pathname.endsWith('/frame'), sourceId: url.pathname.split('/')[5] }); pendingPreviewRequests.add(request); maxPreviewRequests = Math.max(maxPreviewRequests, pendingPreviewRequests.size); }
  });
  page.on('response', response => pendingPreviewRequests.delete(response.request())); page.on('requestfailed', request => pendingPreviewRequests.delete(request));
  await page.goto(`${base}/recordings/${recordingId}/editor?draft=${draft.id}`); await page.getByTestId('clip-editor').waitFor();
  await mediaSettled('Initial viewport');
  await checkTileAlignment(draft, 'Initial source');
  assert.ok((await verifyRecordedStrip('main_camera')).some(value => value.atMs < 6000)); assert.ok((await verifyRecordedStrip('main_camera')).some(value => value.atMs >= 6000));
  const importedStrip = await framePixels('silent_overlay'); assert.ok(importedStrip.some(value => value.atMs < 6000) && importedStrip.some(value => value.atMs >= 6000));
  for (const value of importedStrip) assert.ok(value.atMs < 6000 ? value.rgb[1] > value.rgb[0] + 60 && value.rgb[1] > value.rgb[2] + 60 : value.rgb[0] > 160 && value.rgb[1] > 160 && value.rgb[2] < 80, 'Imported filmstrip uses real changing source pictures');
  assert.ok(await page.locator('[data-item-id="silent_overlay"] [data-timeline-media].has-no-audio').count(), 'A genuinely silent imported video falls back without a fabricated waveform');
  assert.ok((await page.locator('[data-item-id="imported_audio"] [data-preview-kind="waveform"][data-state="ready"] img').count()) > 0, 'Imported audio renders a real waveform image');
  assert.equal(await page.locator('[data-item-id="offscreen_audio"] [data-timeline-media]').getAttribute('data-vertically-visible'), 'false');
  assert.equal(await page.locator('[data-item-id="offscreen_audio"] [data-preview-kind]').count(), 0, 'Entirely offscreen tracks allocate no waveform tiles');
  assert.equal(previewRequests.some(request => request.sourceId === offscreenAudioAsset.id), false, 'Entirely offscreen tracks issue no preview requests');
  let fetchActivity = await page.evaluate(() => window.__timelinePreviewFetches);
  assert.ok(fetchActivity.maximum <= 2, `Preview fetches stay bounded at two in flight, observed ${fetchActivity.maximum}`);
  assert.ok(new Set(previewRequests.map(request => request.url)).size <= 72, 'The initial viewport never fetches a frame for every video frame');
  let observed = await workspace(); assert.deepEqual(observed.drafts, beforeView.drafts); assert.deepEqual(observed.exports, beforeView.exports); assert.deepEqual(observed.assets, beforeView.assets); assert.deepEqual(clipWrites, []);
  await unchanged('Initial virtualized filmstrips and waveforms');
  checks.push('Real changing recording thumbnails, imported silent-video frames and stereo waveform UI, private bounded fetching, no playback/capture or draft/live mutations');

  await page.getByLabel('Timeline zoom', { exact: true }).fill('12'); await page.getByLabel('Timeline zoom', { exact: true }).press('Tab');
  await mediaSettled('Zoomed beginning'); await checkTileAlignment(draft, 'Zoomed beginning');
  assert.equal(await page.locator('[data-item-id="far_overlay"] [data-timeline-media]').count(), 0, 'Offscreen clips mount no preview resources');
  const requestsBeforeScroll = previewRequests.length;
  await page.locator('.nle-timeline-scroll').evaluate(element => { element.scrollLeft = 4500; });
  await until(async () => Number(await page.locator('[data-item-id="main_camera"] [data-timeline-media]').getAttribute('data-local-start-ms')) > 50000, 'Scrolled viewport moves the source window');
  await mediaSettled('Scrolled middle'); await checkTileAlignment(draft, 'Scrolled middle'); await verifyRecordedStrip('main_camera');
  assert.equal(await page.locator('[data-item-id="silent_overlay"] [data-timeline-media]').count(), 0); assert.equal(await page.locator('[data-item-id="imported_audio"] [data-timeline-media]').count(), 0);
  const middleRequests = previewRequests.slice(requestsBeforeScroll).filter(request => request.frame); assert.ok(middleRequests.length > 0);
  assert.ok(middleRequests.every(request => request.atMs >= 45000 && request.atMs <= 85000), 'Scrolling generates only the visible source neighbourhood, not the entire remaining service');
  assert.ok(await page.locator('[data-preview-kind="frame"]').count() <= 36, 'A long scrolled clip still has a bounded DOM filmstrip');
  await page.locator('.nle-timeline-scroll').evaluate(element => { element.scrollLeft = 0; });
  await until(async () => Number(await page.locator('[data-item-id="main_camera"] [data-timeline-media]').getAttribute('data-local-start-ms')) === 0, 'Returned viewport reaches the beginning'); await mediaSettled('Return to cached beginning');
  const afterFirstReturn = previewRequests.length;
  await page.locator('.nle-timeline-scroll').evaluate(element => { element.scrollLeft = 4500; });
  await until(async () => Number(await page.locator('[data-item-id="main_camera"] [data-timeline-media]').getAttribute('data-local-start-ms')) > 50000, 'Cached middle viewport becomes visible'); await mediaSettled('Return to cached middle');
  await page.locator('.nle-timeline-scroll').evaluate(element => { element.scrollLeft = 0; });
  await until(async () => Number(await page.locator('[data-item-id="main_camera"] [data-timeline-media]').getAttribute('data-local-start-ms')) === 0, 'Cached beginning becomes visible again'); await mediaSettled('Reused cached beginning');
  assert.equal(previewRequests.length, afterFirstReturn, 'Repeated viewport visits reuse the decoded preview cache without extra HTTP requests');
  await unchanged('Zoom, horizontal scroll, virtual windows and cache reuse');
  observed = await workspace(); assert.deepEqual(observed.drafts, beforeView.drafts); assert.deepEqual(clipWrites, []);
  checks.push('36-frame virtualized windows, offscreen resource release, 12× zoom and horizontal-scroll alignment, bounded network concurrency and cache reuse');
  await page.screenshot({ path: path.join(directory, 'timeline-previews-initial.png'), fullPage: true });

  // A controlled preview-only connection failure cannot break playback or the
  // draft. All other source frames and waveform evidence use the real backend.
  let failedFrames = 0;
  const failurePattern = `**/api/clips/timeline/recording/${recordingId}/frame?*`;
  await page.route(failurePattern, route => { const at = Number(new URL(route.request().url()).searchParams.get('atMs')); if (at >= 105000) { failedFrames++; return route.abort('connectionfailed'); } return route.continue(); });
  await page.locator('.nle-timeline-scroll').evaluate(element => { element.scrollLeft = 8300; });
  await until(async () => failedFrames > 0 && await page.locator('[data-item-id="main_camera"] [data-preview-state]').filter({ hasText: 'Some previews unavailable' }).count() > 0, 'Preview connection errors show a graceful in-timeline fallback');
  assert.ok(await page.locator('[data-item-id="main_camera"] [data-preview-kind="frame"][data-state="unavailable"]').count() > 0);
  await page.unroute(failurePattern);
  await page.locator('.nle-timeline-scroll').evaluate(element => { element.scrollLeft = 0; });
  await until(async () => Number(await page.locator('[data-item-id="main_camera"] [data-timeline-media]').getAttribute('data-local-start-ms')) === 0, 'The editor returns from an unavailable preview'); await mediaSettled('Healthy cached source after a preview failure');
  await unchanged('Graceful missing-source and preview-connection failures');
  checks.push('Missing/invalid preview API requests and a controlled preview-only connection error fail gracefully without media playback or draft/live changes');

  await page.getByLabel('Timeline zoom', { exact: true }).fill('6'); await page.getByLabel('Timeline zoom', { exact: true }).press('Tab'); await mediaSettled('Desktop editing view');
  await page.screenshot({ path: path.join(directory, 'timeline-previews-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: `Select clip ${recordingName}`, exact: true }).click();
  await fill('Clip start time', '2'); await fill('Clip end time', '10');
  await page.getByRole('slider', { name: 'Clip end handle', exact: true }).press('Shift+ArrowLeft'); assert.equal(await page.getByLabel('Clip end time', { exact: true }).inputValue(), '00:00:09.000');
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  draft = await save(); await mediaSettled('Trimmed source'); await checkTileAlignment(draft, 'Trimmed source');
  const trimmed = await verifyRecordedStrip('main_camera'); assert.ok(trimmed.every(value => value.atMs >= 2000 && value.atMs < 10000));
  await page.getByRole('button', { name: `Select clip ${audioAsset.name}`, exact: true }).click();
  await fill('Clip start time', '2'); await fill('Clip end time', '10'); draft = await save();
  await mediaSettled('Trimmed imported audio'); await checkTileAlignment(draft, 'Trimmed imported audio');
  assert.equal(draft.timeline.tracks.find(value => value.kind === 'audio').items[0].inMs, 2000);
  await page.getByRole('button', { name: `Select clip ${recordingName}`, exact: true }).click();
  await page.getByRole('slider', { name: 'Timeline playhead', exact: true }).press('Home');
  for (let index = 0; index < 4; index++) await page.getByRole('slider', { name: 'Timeline playhead', exact: true }).press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Split selected clip', exact: true }).click(); await fill('Timeline clip name', 'Blue second half');
  draft = await save(); await mediaSettled('Split clips'); await checkTileAlignment(draft, 'Split clips');
  const main = draft.timeline.tracks[0].items, blueHalf = main.find(value => value.name === 'Blue second half'); assert.ok(blueHalf); assert.equal(blueHalf.inMs, 6000);
  const right = page.getByRole('button', { name: 'Select clip Blue second half', exact: true }), left = page.getByRole('button', { name: `Select clip ${recordingName}`, exact: true });
  const rightRect = await right.boundingBox(), leftRect = await left.boundingBox();
  await page.mouse.move(rightRect.x + 15, rightRect.y + rightRect.height / 2); await page.mouse.down(); await page.mouse.move(leftRect.x + 12, leftRect.y + leftRect.height / 2, { steps: 6 }); await page.mouse.up();
  draft = await save(); assert.equal(draft.timeline.tracks[0].items[0].name, 'Blue second half'); await mediaSettled('Reordered clips'); await checkTileAlignment(draft, 'Reordered clips');
  assert.ok((await verifyRecordedStrip(blueHalf.id)).every(value => value.atMs >= 6000));
  const redHalf = draft.timeline.tracks[0].items.find(value => value.id !== blueHalf.id); assert.ok((await verifyRecordedStrip(redHalf.id)).every(value => value.atMs >= 2000 && value.atMs < 6000));
  await page.screenshot({ path: path.join(directory, 'timeline-previews-trimmed-reordered.png'), fullPage: true });
  const afterEdits = await workspace(), writesAfterEdits = clipWrites.length;
  let geometry = await scaleAndRuler(); await page.mouse.move(geometry.x + 500 * geometry.scale, geometry.y); await page.mouse.down(); await assertClockAndVideo(500, blueHalf.id, 6000);
  await page.mouse.move(geometry.x + 2500 * geometry.scale, geometry.y, { steps: 6 }); await assertClockAndVideo(2500, blueHalf.id, 6000); await page.mouse.up();
  await mediaSettled('Scrubbed trimmed footage'); assert.equal(clipWrites.length, writesAfterEdits); assert.deepEqual((await workspace()).drafts, afterEdits.drafts);
  await unchanged('Source trims, split/reorder alignment and existing scrubbing');
  checks.push('Real filmstrip and waveform offsets stay aligned after source trim, edge-key trim, split and sequence reorder; pointer scrubbing still seeks the correct original source time');

  for (const [width, height] of [[1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height }); await mediaSettled(`${width}px responsive preview`); await checkTileAlignment(draft, `${width}px`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `Timeline media causes no page overflow at ${width}px`);
    assert.ok(await page.locator('[data-preview-kind="frame"]').count() <= 108, 'Responsive preview tiles remain bounded per visible clip');
    await page.screenshot({ path: path.join(directory, `timeline-previews-${width}.png`), fullPage: true });
  }
  assert.deepEqual((await workspace()).drafts, afterEdits.drafts); assert.equal(clipWrites.length, writesAfterEdits);
  fetchActivity = await page.evaluate(() => window.__timelinePreviewFetches);
  assert.ok(fetchActivity.maximum <= 2, `Complete preview fetches stay bounded at two through cancellation, observed ${fetchActivity.maximum}`);
  await unchanged('Responsive timeline preview rendering');
  checks.push('Tablet/phone viewport remeasurement, clipped bounded media and no horizontal page overflow or visualization side effects');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, directory, checks, browserErrors: errors, studioWrites, previewRequests: previewRequests.length, maxPreviewRequests: fetchActivity.maximum, maxPendingProtocolNotifications: maxPreviewRequests }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'timeline-previews-failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ ok: false, directory, error: error.stack ?? error.message, browserErrors: errors, studioWrites, logs: logs.slice(-6000) }, null, 2)); process.exitCode = 1;
} finally { if (browser) await browser.close().catch(() => {}); await stopServer(); }
