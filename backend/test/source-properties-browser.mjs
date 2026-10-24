// Existing source Properties: staged input replacement, shared source identity,
// media controls and rollback. Isolated station + synthetic hardware only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-source-properties-'));
const port = Number(process.env.LUMEN_SOURCE_PROPERTIES_TEST_PORT ?? 3462), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let server, browser, page, logs = '';
const errors = [], checks = [];
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function installDevices(page) {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices, captures = [];
    let permitted = false, denied = false, deferNext = false, resolvePending, nextFailure;
    const available = new Map([
      ['builtin-video', { kind: 'videoinput', label: 'Built-in camera', groupId: 'builtin' }],
      ['builtin-audio', { kind: 'audioinput', label: 'Built-in microphone', groupId: 'builtin' }],
    ]);
    const trace = {
      calls: [], stops: [], enumerations: 0, displayCalls: 0,
      addCard({ notify = true, label = 'USB HDMI Video Capture' } = {}) {
        available.set('hdmi-video', { kind: 'videoinput', label, groupId: 'hdmi' });
        available.set('hdmi-audio', { kind: 'audioinput', label: 'USB HDMI Digital Audio', groupId: 'hdmi' });
        if (notify) media.dispatchEvent(new Event('devicechange'));
      },
      remove(id, notify = true) {
        available.delete(id);
        for (const item of captures.filter(item => item.id === id && item.track.readyState === 'live')) {
          item.track.stop(); item.track.dispatchEvent(new Event('ended'));
        }
        if (notify) media.dispatchEvent(new Event('devicechange'));
      },
      deny(value) { denied = value; },
      failNext(name) { nextFailure = name; },
      defer() { deferNext = true; },
      release() { resolvePending?.(); resolvePending = undefined; },
      status() { return { live: captures.filter(item => item.track.readyState === 'live').map(item => item.id), pending: !!resolvePending }; },
      color(value) { for (const item of captures) if (item.id === 'hdmi-video' && item.source.paint) item.source.color = value; },
    };
    function ownTrack(track, source, inheritedConstraints = {}) {
      const nativeStop = track.stop.bind(track), nativeClone = track.clone.bind(track);
      const nativeSettings = track.getSettings.bind(track), nativeCapabilities = track.getCapabilities.bind(track);
      const nativeApply = track.applyConstraints.bind(track);
      let applied = structuredClone(inheritedConstraints);
      source.refs++;
      track.getSettings = () => ({ ...source.settings, ...nativeSettings(),
        ...(source.settings.deviceId ? { deviceId: source.settings.deviceId } : {}) });
      track.getCapabilities = () => ({ ...nativeCapabilities(),
        ...(source.settings.deviceId ? { deviceId: source.settings.deviceId } : {}) });
      track.getConstraints = () => structuredClone(applied);
      track.applyConstraints = async (next = {}) => {
        if (track.readyState === 'ended') return;
        const requested = typeof next.deviceId === 'object' ? next.deviceId?.exact : undefined;
        if (requested !== undefined && !(Array.isArray(requested) ? requested : [requested]).includes(source.id)) {
          const error = new DOMException('The selected synthetic device is unavailable', 'OverconstrainedError');
          Object.defineProperty(error, 'constraint', { value: 'deviceId' });
          throw error;
        }
        // The synthetic OS ID is different from the native canvas/audio ID.
        // Validate it above; leave real format failures to the native track.
        const { deviceId, ...nativeConstraints } = next;
        await nativeApply(nativeConstraints);
        applied = structuredClone(next);
      };
      Object.defineProperty(track, 'label', { value: available.get(source.id)?.label || source.id });
      track.clone = () => ownTrack(nativeClone(), source, applied);
      track.stop = () => {
        if (track.readyState === 'ended') return;
        trace.stops.push(source.id); nativeStop(); source.refs--;
        if (!source.refs) source.close();
      };
      captures.push({ id: source.id, track, source });
      return track;
    }
    window.__captureDevices = trace;
    Object.defineProperty(media, 'enumerateDevices', { value: async () => {
      trace.enumerations++;
      return [...available].map(([deviceId, info]) => ({
        deviceId: permitted ? deviceId : '', ...info, label: permitted ? info.label : '', toJSON() { return this; },
      }));
    } });
    Object.defineProperty(media, 'getUserMedia', { value: async constraints => {
      trace.calls.push(structuredClone(constraints));
      if (deferNext) { deferNext = false; await new Promise(resolve => { resolvePending = resolve; }); }
      if (denied) throw new DOMException('Access denied', 'NotAllowedError');
      permitted = true;
      if (nextFailure) { const name = nextFailure; nextFailure = undefined; throw new DOMException('Input could not start after access was granted', name); }
      const selected = (setting, kind) => {
        if (!setting) return null;
        const requested = typeof setting === 'object' ? setting.deviceId : null;
        const id = typeof requested === 'string' ? requested : requested?.exact ?? [...available].find(([, info]) => info.kind === kind)?.[0];
        if (!available.has(id) || available.get(id).kind !== kind) throw new DOMException('Device unavailable', 'NotFoundError');
        return id;
      };
      const videoId = selected(constraints.video, 'videoinput'), audioId = selected(constraints.audio, 'audioinput');
      const stream = new MediaStream();
      if (videoId) {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'), item = { id: videoId, color: videoId === 'hdmi-video' ? '#18ce48' : '#e42824' };
        item.paint = () => { ctx.fillStyle = item.color; ctx.fillRect(0, 0, canvas.width, canvas.height); };
        item.paint(); const timer = setInterval(item.paint, 40), track = canvas.captureStream(25).getVideoTracks()[0];
        item.refs = 0; item.settings = { deviceId: videoId, width: 640, height: 360, frameRate: 25 };
        item.close = () => clearInterval(timer);
        const owned = ownTrack(track, item); stream.addTrack(owned);
        try { await owned.applyConstraints(typeof constraints.video === 'object' ? constraints.video : {}); }
        catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
      }
      if (audioId) {
        const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
        oscillator.frequency.value = 230; oscillator.connect(destination); oscillator.start(); await audio.resume();
        const item = { id: audioId, refs: 0, settings: { deviceId: audioId, sampleRate: audio.sampleRate }, close() { oscillator.stop(); void audio.close(); } };
        // Web Audio destination tracks have no microphone processing controls.
        stream.addTrack(ownTrack(destination.stream.getAudioTracks()[0], item,
          typeof constraints.audio === 'object' ? constraints.audio : {}));
      }
      return stream;
    } });
    Object.defineProperty(media, 'getDisplayMedia', { value: async () => {
      trace.displayCalls++;
      if (denied) throw new DOMException('Selection cancelled', 'NotAllowedError');
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'), id = `screen-${trace.displayCalls}`;
      const paint = () => { ctx.fillStyle = trace.displayCalls % 2 ? '#5522cc' : '#22aacc'; ctx.fillRect(0, 0, 640, 360); };
      paint(); const timer = setInterval(paint, 40), track = canvas.captureStream(25).getVideoTracks()[0];
      const source = { id, refs: 0, settings: { displaySurface: 'monitor', width: 640, height: 360 }, close() { clearInterval(timer); } };
      return new MediaStream([ownTrack(track, source)]);
    } });
  });
}

try {
  const originalVideo = path.join(dir, 'original-blue.mp4'), replacementVideo = path.join(dir, 'replacement-motion.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=12',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', originalVideo]);
  // A large centre patch cycles through three unambiguous colours. WebRTC may
  // vary compressed pixel values, but cannot turn a stationary red patch into
  // green/blue. The surrounding test pattern still makes preview QA useful.
  const motionPattern = "testsrc2=size=640x360:rate=12,drawbox=x=160:y=90:w=320:h=180:color=red:t=fill:enable='lt(t,0.667)',drawbox=x=160:y=90:w=320:h=180:color=lime:t=fill:enable='between(t,0.667,1.333)',drawbox=x=160:y=90:w=320:h=180:color=blue:t=fill:enable='gte(t,1.333)'";
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', motionPattern,
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', replacementVideo]);
  const audioFile = path.join(dir, 'source-tone.wav');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '2', audioFile]);
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station startup');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const status = async () => (await request.get(`${base}/api/studio/status`)).json();
  const saveState = async state => { const response = await request.put(`${base}/api/studio`, { data: state }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const command = async command => { const state = await get(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } }); assert.equal(response.status(), 200, await response.text()); };
  const upload = async (kind, name, mimeType, buffer) => {
    const response = await request.post(`${base}/api/media/${kind}`, { multipart: { file: { name, mimeType, buffer } } });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const picture = await sharp({ create: { width: 640, height: 360, channels: 4, background: '#2359b1' } }).png().toBuffer();
  const artwork = await upload('backgrounds', 'source-artwork.png', 'image/png', picture);
  const original = await upload('backgrounds', 'original-blue.mp4', 'video/mp4', await fs.readFile(originalVideo));
  const replacement = await upload('backgrounds', 'replacement-motion.mp4', 'video/mp4', await fs.readFile(replacementVideo));
  const sound = await upload('music', 'source-tone.wav', 'audio/wav', await fs.readFile(audioFile));
  const content = await (await request.get(`${base}/api/content`)).json();
  const channelTemplate = { id: 'source_properties_channel_one', name: 'Presentation one', kind: 'presentation', playlistId: 'source_properties_playlist' };
  content.playlists.push({ id: channelTemplate.playlistId, name: 'Source properties slides', items: [] });
  content.channels.push(channelTemplate);
  content.channels.push({ ...channelTemplate, id: 'source_properties_channel_two', name: 'Alternate presentation' });
  const saveContent = await request.put(`${base}/api/content`, { data: content });
  assert.equal(saveContent.status(), 200, await saveContent.text());
  const soundSettings = { volume: .67, muted: true, mode: 'follow', delayMs: 120 };
  const source = (id, kind, patch = {}) => ({ id, kind, name: id, loop: false, audio: { ...soundSettings }, ...patch });
  const initial = await get();
  const camera = source('camera_shared', 'camera', { name: 'Main camera' });
  const movie = source('video_shared', 'video', { name: 'Opening video', url: original.path, playback: { paused: true, restart: 2 } });
  const seeds = [camera, movie, source('image_edit', 'image', { url: artwork.path }), source('audio_edit', 'audio', { url: sound.path }),
    source('screen_edit', 'screen'), source('microphone_edit', 'microphone'), source('channel_edit', 'channel', { channelId: content.channels[0]?.id ?? 'scripture' })];
  initial.sources = seeds;
  const template = initial.scenes[0].layers[0];
  const layer = (id, sourceId) => ({ ...template, id, name: id, kind: 'source', sourceId, x: 0, y: 0, width: 100, height: 100 });
  initial.scenes[0].layers = [layer('camera_layer_one', camera.id)];
  initial.scenes[1].layers = [layer('camera_layer_two', camera.id)];
  initial.scenes[2].layers = [layer('video_layer', movie.id)];
  await saveState(initial);
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await installDevices(page);
  await page.addInitScript(() => {
    localStorage.setItem('lumen:input:camera_shared', JSON.stringify({ videoDeviceId: 'builtin-video', audioDeviceId: 'builtin-audio', includeAudio: false }));
    localStorage.setItem('lumen:input:microphone_edit', JSON.stringify({ audioDeviceId: 'builtin-audio' }));
  });
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await page.evaluate(() => window.__captureDevices.addCard());
  const dialog = () => page.getByRole('dialog', { name: 'Source properties', exact: true });
  const row = id => page.locator(`.source-list .source-row[data-source-id="${id}"]`);
  const open = async id => { await row(id).getByRole('button', { name: /^Properties for / }).click(); await dialog().waitFor(); };
  const cancel = async () => { await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); };
  const save = async () => { await dialog().getByRole('button', { name: 'Save changes', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); };
  const preview = () => dialog().getByTestId('source-camera-preview');
  const videoDevice = () => dialog().getByLabel('Video device', { exact: true });
  const previewReady = id => until(() => preview().evaluate((video, id) => video.readyState >= 2 && video.videoWidth > 0 && video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId === id, id), `preview of ${id}`);
  const trace = () => page.evaluate(() => ({ calls: window.__captureDevices.calls, stops: window.__captureDevices.stops, ...window.__captureDevices.status() }));
  const selectedInput = () => page.evaluate(() => JSON.parse(localStorage.getItem('lumen:input:camera_shared')));
  const sample = locator => locator.evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
  const red = pixels => pixels[0] > 150 && pixels[1] < 100 && pixels[2] < 110;
  const green = pixels => pixels[1] > 120 && pixels[0] < 80 && pixels[2] < 110;
  await open(camera.id);
  await dialog().getByRole('button', { name: 'Start preview', exact: true }).click();
  await previewReady('builtin-video');
  assert.deepEqual((await trace()).calls[0].video.deviceId, { exact: 'builtin-video' }, 'An existing source with hidden device names requests its remembered input, never default');
  await cancel();
  assert.deepEqual((await trace()).live, [], 'Permission recovery preview releases on cancel');
  checks.push('Remembered camera remains previewable before permission reveals device IDs, using its exact selection');
  for (const seed of seeds) {
    await open(seed.id);
    assert.equal(await dialog().getByLabel('Name', { exact: true }).inputValue(), seed.name);
    assert.equal(await dialog().getByRole('group', { name: 'Source type', exact: true }).count(), 0, 'An existing source cannot accidentally change type');
    await cancel();
  }
  assert.deepEqual((await get()).sources, seeds, 'Opening and cancelling every source type preserves the document');
  checks.push('Every source has Properties; saved names and source types remain intact on cancel');

  await row(camera.id).getByRole('button', { name: 'Connect', exact: true }).click();
  await row(camera.id).getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start engine', exact: true }).click();
  await until(async () => (await status()).state === 'running', 'real renderer starts', 45000);
  await until(async () => red(await sample(page.locator('.preview-panel video'))), 'original camera pixels in Preview');
  await command({ type: 'take', sceneId: initial.scenes[0].id, transition: 'cut' });
  const program = structuredClone((await get()).program);
  await until(async () => red(await sample(page.locator('.program-panel video'))), 'original camera pixels in Program');
  const callsBeforeOpen = (await trace()).calls.length;
  await open(camera.id); await previewReady('builtin-video');
  assert.equal(await videoDevice().inputValue(), 'builtin-video');
  assert.equal((await trace()).calls.length, callsBeforeOpen, 'Editing an active camera previews a clone without reopening hardware');
  await videoDevice().selectOption('hdmi-video'); await previewReady('hdmi-video');
  await dialog().getByLabel('Name', { exact: true }).fill('Unsaved camera name');
  assert.equal((await selectedInput()).videoDeviceId, 'builtin-video', 'Draft device choice does not replace remembered input');
  assert.ok(red(await sample(page.locator('.program-panel video'))), 'Staged second camera does not replace Program');
  await cancel();
  assert.equal((await get()).sources.find(item => item.id === camera.id).name, camera.name);
  assert.ok((await trace()).live.every(id => id === 'builtin-video'), 'Cancelled camera tracks are released while original remains live');
  checks.push('Camera properties preload the remembered device; draft switching and Cancel leave the original Program feed and selection intact');

  await open(camera.id); await previewReady('builtin-video');
  await page.evaluate(() => window.__captureDevices.deny(true));
  await videoDevice().selectOption('hdmi-video');
  await dialog().getByRole('alert').filter({ hasText: 'system privacy settings' }).waitFor();
  assert.equal(await dialog().getByRole('button', { name: 'Save changes', exact: true }).isEnabled(), false);
  assert.ok(red(await sample(page.locator('.program-panel video'))));
  assert.equal((await selectedInput()).videoDeviceId, 'builtin-video');
  await cancel(); await page.evaluate(() => window.__captureDevices.deny(false));

  await open(camera.id); await previewReady('builtin-video');
  await videoDevice().selectOption('hdmi-video'); await previewReady('hdmi-video');
  await dialog().getByLabel('Name', { exact: true }).fill('Saved HDMI camera');
  const rejectSave = async route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Properties save interrupted' }) }) : route.continue();
  await page.route('**/api/studio', rejectSave);
  await dialog().getByRole('button', { name: 'Save changes', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: 'Properties save interrupted' }).waitFor();
  assert.equal((await get()).sources.find(item => item.id === camera.id).name, camera.name);
  assert.equal((await selectedInput()).videoDeviceId, 'builtin-video');
  assert.ok(red(await sample(page.locator('.program-panel video'))), 'Failed save leaves original Program pixels');
  await page.unroute('**/api/studio', rejectSave);
  await cancel();
  checks.push('Permission denial and failed station save preserve source metadata, remembered selection and the active original camera');

  const beforeCameraSave = await get();
  await open(camera.id); await previewReady('builtin-video');
  await videoDevice().selectOption('hdmi-video'); await previewReady('hdmi-video');
  await dialog().getByLabel('Name', { exact: true }).fill('Saved HDMI camera');
  await until(() => page.locator('[data-sonner-toast]').count().then(count => count === 0), 'transient save-error notification dismissed');
  await page.screenshot({ path: path.join(dir, 'camera-properties.png'), fullPage: true });
  const callsBeforeSave = (await trace()).calls.length;
  await save();
  const savedCamera = (await get()).sources.find(item => item.id === camera.id);
  assert.equal(savedCamera.name, 'Saved HDMI camera');
  assert.equal((await get()).sources.length, seeds.length, 'Save edits the existing source rather than creating a duplicate');
  assert.deepEqual(savedCamera.audio, soundSettings, 'Input properties preserve mixer volume, mute, routing and delay');
  assert.deepEqual((await get()).scenes, beforeCameraSave.scenes, 'Shared layers keep their source references and layout');
  assert.deepEqual((await get()).program, program, 'Source edit does not issue a scene Take');
  assert.equal((await selectedInput()).videoDeviceId, 'hdmi-video');
  assert.equal((await trace()).calls.length, callsBeforeSave, 'Save transfers the tested stream without another capture request');
  await until(async () => green(await sample(page.locator('.program-panel video'))), 'saved HDMI device reaches existing Program source');
  await row(camera.id).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await row(camera.id).getByRole('button', { name: 'Connect', exact: true }).click();
  await until(async () => green(await sample(page.locator('.program-panel video'))), 'edited source reconnects to selected camera');
  assert.deepEqual((await trace()).calls.at(-1).video.deviceId, { exact: 'hdmi-video' });
  checks.push('Save preserves source ID and shared layers, switches live pixels after save, retains mixer settings and reconnects to the newly selected camera');

  await row('microphone_edit').getByRole('button', { name: 'Connect', exact: true }).click();
  await row('microphone_edit').getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await open('microphone_edit');
  const audioDevice = () => dialog().getByLabel('Audio device', { exact: true });
  await until(async () => await audioDevice().inputValue() === 'builtin-audio', 'saved microphone preselected');
  const micCalls = (await trace()).calls.length;
  await audioDevice().selectOption('hdmi-audio');
  assert.equal((await trace()).calls.length, micCalls, 'Microphone changes wait until Save before acquiring hardware');
  assert.ok((await trace()).live.includes('builtin-audio'));
  await cancel();
  await open('microphone_edit');
  assert.equal(await audioDevice().inputValue(), 'builtin-audio');
  await audioDevice().selectOption('hdmi-audio'); await save();
  assert.deepEqual((await trace()).calls.at(-1).audio.deviceId, { exact: 'hdmi-audio' });
  assert.equal((await trace()).live.includes('builtin-audio'), false);
  assert.ok((await trace()).live.includes('hdmi-audio'));
  assert.deepEqual((await get()).sources.find(item => item.id === 'microphone_edit').audio, soundSettings);
  checks.push('Microphone properties stage an exact audio input until Save and preserve mixer settings');

  await row('screen_edit').getByRole('button', { name: 'Connect', exact: true }).click();
  await row('screen_edit').getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await open('screen_edit');
  await dialog().getByRole('button', { name: 'Choose screen or window', exact: true }).click();
  await until(() => dialog().getByLabel('Screen preview', { exact: true }).evaluate(video => video.readyState >= 2 && video.srcObject.getVideoTracks()[0].label === 'screen-2'), 'replacement screen local preview');
  assert.ok((await trace()).live.includes('screen-1'), 'Original screen stays live during replacement setup');
  assert.ok((await trace()).live.includes('screen-2'));
  await cancel();
  assert.ok((await trace()).live.includes('screen-1'));
  assert.equal((await trace()).live.includes('screen-2'), false, 'Cancelled screen selection releases its tracks');
  await open('screen_edit');
  await page.evaluate(() => window.__captureDevices.deny(true));
  await dialog().getByRole('button', { name: 'Choose screen or window', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: 'Screen selection cancelled' }).waitFor();
  assert.ok((await trace()).live.includes('screen-1'), 'Cancelling OS screen chooser leaves current screen active');
  await page.evaluate(() => window.__captureDevices.deny(false));
  await dialog().getByRole('button', { name: 'Choose screen or window', exact: true }).click();
  await until(() => dialog().getByLabel('Screen preview', { exact: true }).evaluate(video => video.readyState >= 2 && video.srcObject.getVideoTracks()[0].label === 'screen-4'), 'new screen ready to save');
  await save();
  assert.equal((await trace()).live.includes('screen-1'), false);
  assert.ok((await trace()).live.includes('screen-4'), 'Saved screen clone remains after the properties dialog closes');
  assert.equal((await get()).sources.length, seeds.length);
  checks.push('Screen selection previews locally; Cancel/chooser denial preserve current screen and Save transfers the replacement without duplicating sources');

  await open('channel_edit');
  assert.equal(await dialog().getByLabel('Presentation channel').inputValue(), channelTemplate.id);
  await dialog().getByLabel('Presentation channel').selectOption('source_properties_channel_two');
  await save();
  assert.equal((await get()).sources.find(item => item.id === 'channel_edit').channelId, 'source_properties_channel_two');
  await open('audio_edit');
  await dialog().getByLabel('Loop', { exact: true }).check();
  await dialog().getByLabel('Pause playback', { exact: true }).check(); await save();
  assert.equal((await get()).sources.find(item => item.id === 'audio_edit').loop, true);
  assert.equal((await get()).sources.find(item => item.id === 'audio_edit').playback.paused, true);
  checks.push('Presentation channel and audio-file playback settings save on their existing source IDs');

  await open(movie.id);
  const mediaPreview = () => dialog().getByTestId('source-media-preview').locator('video');
  await until(() => mediaPreview().evaluate((video, url) => video.src.endsWith(url) && video.readyState >= 2, original.path), 'saved video preloaded in properties');
  assert.equal(await dialog().getByLabel('Loop', { exact: true }).isChecked(), false);
  assert.equal(await dialog().getByLabel('Pause playback', { exact: true }).isChecked(), true);
  await dialog().getByLabel('Loop', { exact: true }).check();
  await dialog().getByLabel('Pause playback', { exact: true }).uncheck();
  await dialog().getByLabel('Restart on save', { exact: true }).check();
  await dialog().getByRole('button', { name: 'Change file', exact: true }).click();
  await dialog().getByRole('button', { name: /^Select .*replacement-motion\.mp4$/ }).click();
  await until(() => mediaPreview().evaluate((video, url) => video.src.endsWith(url) && video.readyState >= 2, replacement.path), 'replacement media preview');
  await cancel();
  assert.deepEqual((await get()).sources.find(item => item.id === movie.id), movie, 'Cancelling media replacement and playback edits is non-destructive');
  await open(movie.id);
  await dialog().getByRole('button', { name: 'Change file', exact: true }).click();
  await dialog().getByRole('button', { name: /^Select .*replacement-motion\.mp4$/ }).click();
  await dialog().getByLabel('Loop', { exact: true }).check();
  await dialog().getByLabel('Pause playback', { exact: true }).uncheck();
  await dialog().getByLabel('Restart on save', { exact: true }).check();
  await dialog().getByLabel('Name', { exact: true }).fill('Looping opening video');
  await page.screenshot({ path: path.join(dir, 'video-properties.png'), fullPage: true });
  await save();
  const savedVideo = (await get()).sources.find(item => item.id === movie.id);
  assert.equal(savedVideo.url, replacement.path); assert.equal(savedVideo.loop, true);
  assert.deepEqual(savedVideo.playback, { paused: false, restart: 3 }); assert.deepEqual(savedVideo.audio, soundSettings);
  const videoScene = await get(); videoScene.previewSceneId = initial.scenes[2].id; await saveState(videoScene);
  const visiblePhase = () => page.locator('.preview-panel video').evaluate(video => {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    const ctx = canvas.getContext('2d');
    // Average a crop safely inside the large centre patch, away from edges.
    ctx.drawImage(video, video.videoWidth * .4, video.videoHeight * .4, video.videoWidth * .2, video.videoHeight * .2, 0, 0, 8, 8);
    const pixels = ctx.getImageData(0, 0, 8, 8).data, rgb = [0, 0, 0];
    for (let index = 0; index < pixels.length; index += 4) for (let channel = 0; channel < 3; channel++) rgb[channel] += pixels[index + channel] / 64;
    const strongest = Math.max(...rgb), channel = rgb.indexOf(strongest);
    return strongest > 140 && rgb.every((value, index) => index === channel || value < 70) ? ['red', 'green', 'blue'][channel] : null;
  });
  const observePhases = async () => {
    const phases = [];
    // Longer than a complete two-second loop; an unpaused source necessarily
    // crosses all three colour phases during this observation window.
    for (let index = 0; index < 12; index++) {
      phases.push(await visiblePhase());
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return phases;
  };
  await until(async () => (await status()).sources[movie.id] === 'ready', 'replacement video renderer ready');
  await new Promise(resolve => setTimeout(resolve, 2300));
  await until(async () => new Set((await observePhases()).filter(Boolean)).size === 3, 'looped replacement cycles through all three pictures after its duration');
  await open(movie.id);
  assert.equal(await dialog().getByLabel('Loop', { exact: true }).isChecked(), true);
  assert.equal(await dialog().getByLabel('Pause playback', { exact: true }).isChecked(), false);
  assert.equal(await dialog().getByLabel('Restart on save', { exact: true }).isChecked(), false, 'Restart is a one-shot action');
  await dialog().getByLabel('Pause playback', { exact: true }).check(); await save();
  await until(async () => (await get()).sources.find(item => item.id === movie.id).playback.paused, 'pause saved');
  // Allow queued frames to settle, then require a whole loop's worth of stable
  // picture observations. An unpaused source cannot pass by chance within one
  // short phase, and compression noise cannot masquerade as picture motion.
  await until(async () => {
    const phases = await observePhases();
    return phases.every(Boolean) && new Set(phases).size === 1;
  }, 'saved pause holds one picture for longer than a full loop', 12000);
  checks.push('Video properties preload the current file, stage replacement/loop/pause/restart, persist on Save and change actual renderer playback');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(movie.id);
  const saveBounds = await dialog().getByRole('button', { name: 'Save changes', exact: true }).boundingBox();
  assert.ok(saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 844 && saveBounds.x + saveBounds.width <= 390, 'Save remains reachable at 390px');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(dir, 'properties-mobile.png'), fullPage: true });
  await cancel();
  checks.push('Properties fit a 390px viewport with a reachable Save action');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(await page?.evaluate(() => ({ trace: window.__captureDevices && { calls: window.__captureDevices.calls, stops: window.__captureDevices.stops, ...window.__captureDevices.status() }, alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) })).catch(() => null));
  console.error({ errors }); console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]); }
}
