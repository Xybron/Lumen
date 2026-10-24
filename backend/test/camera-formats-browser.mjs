// Camera Properties format regression. Uses an isolated station and synthetic
// cameras, with independent clone constraints and real decodable canvas frames.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-camera-formats-'));
const port = Number(process.env.LUMEN_CAMERA_FORMATS_TEST_PORT ?? 3463);
const base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
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

async function installCameras(page) {
  await page.addInitScript(() => {
    const devices = new Map([
      ['builtin-video', { label: 'Built-in camera', defaults: { width: 640, height: 360, frameRate: 25 } }],
      ['hdmi-video', { label: 'USB HDMI Video Capture', defaults: { width: 1280, height: 720, frameRate: 30 } }],
    ]);
    const tracks = [], trace = { calls: [], applied: [], stopped: [] };
    const clone = value => structuredClone(value);
    const exact = value => typeof value === 'object' ? value?.exact : undefined;
    const unsupported = constraint => {
      const error = new DOMException('This camera mode is unavailable', 'OverconstrainedError');
      Object.defineProperty(error, 'constraint', { value: constraint });
      return error;
    };
    function format(deviceId, constraints) {
      const defaults = devices.get(deviceId).defaults;
      // Ideal constraints remain negotiable: Auto may deliver the device's own
      // preferred format. Explicit constraints must succeed as an exact mode.
      const width = exact(constraints.width) ?? defaults.width;
      const height = exact(constraints.height) ?? defaults.height;
      const frameRate = exact(constraints.frameRate) ?? defaults.frameRate;
      if (![[640, 360], [1280, 720], [1920, 1080]].some(([w, h]) => width === w && height === h)) throw unsupported('width');
      if (![25, 30, 60].includes(frameRate) || (width === 1920 && frameRate === 60)) throw unsupported('frameRate');
      return { deviceId, width, height, frameRate };
    }
    function createTrack(deviceId, constraints = {}, inheritedSettings) {
      let settings = clone(inheritedSettings ?? format(deviceId, constraints));
      let applied = clone(constraints);
      const canvas = document.createElement('canvas');
      canvas.width = settings.width; canvas.height = settings.height;
      const context = canvas.getContext('2d');
      const paint = () => {
        context.fillStyle = deviceId === 'hdmi-video' ? '#18ce48' : '#e42824';
        context.fillRect(0, 0, canvas.width, canvas.height);
      };
      paint();
      const track = canvas.captureStream(60).getVideoTracks()[0];
      let timer = setInterval(paint, 1000 / settings.frameRate);
      const nativeStop = track.stop.bind(track);
      const entry = { handle: tracks.length + 1, deviceId, track };
      tracks.push(entry);
      Object.defineProperty(track, 'label', { value: devices.get(deviceId).label });
      track.getSettings = () => clone(settings);
      track.getConstraints = () => clone(applied);
      track.getCapabilities = () => ({ deviceId, width: { min: 640, max: 1920 }, height: { min: 360, max: 1080 }, frameRate: { min: 25, max: 60 } });
      track.applyConstraints = async (next = {}) => {
        trace.applied.push({ handle: entry.handle, deviceId, constraints: clone(next) });
        const nextSettings = format(deviceId, next);
        // Like a real track, a rejected constraint must retain its old settings.
        applied = clone(next); settings = nextSettings;
        canvas.width = settings.width; canvas.height = settings.height; paint();
        clearInterval(timer); timer = setInterval(paint, 1000 / settings.frameRate);
      };
      // Independent render surfaces let real decoded video dimensions change in
      // a setup clone without silently resizing the original publisher's frame.
      track.clone = () => createTrack(deviceId, applied, settings);
      track.stop = () => {
        if (track.readyState === 'ended') return;
        trace.stopped.push(entry.handle); nativeStop(); clearInterval(timer);
      };
      return track;
    }
    trace.snapshot = () => ({ calls: clone(trace.calls), applied: clone(trace.applied), stopped: [...trace.stopped],
      tracks: tracks.map(({ handle, deviceId, track }) => ({ handle, deviceId, readyState: track.readyState,
        settings: track.getSettings(), constraints: track.getConstraints() })) });
    window.__cameraFormats = trace;
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [...devices].map(([deviceId, device]) => ({
      deviceId, label: device.label, groupId: deviceId, kind: 'videoinput', toJSON() { return this; },
    })) });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async constraints => {
      trace.calls.push(clone(constraints));
      const video = constraints.video;
      const deviceId = typeof video === 'object' ? exact(video.deviceId) ?? 'builtin-video' : 'builtin-video';
      if (!devices.has(deviceId)) throw new DOMException('Device unavailable', 'NotFoundError');
      if (!video || constraints.audio) throw new Error('This camera-format harness expects video-only capture');
      return new MediaStream([createTrack(deviceId, typeof video === 'object' ? video : {})]);
    } });
    if (!localStorage.getItem('lumen:input:camera_formats')) localStorage.setItem('lumen:input:camera_formats', JSON.stringify({
      videoDeviceId: 'builtin-video', includeAudio: false,
    }));
  });
}

try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station startup');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const getState = async () => (await request.get(`${base}/api/studio`)).json();
  const initial = await getState();
  const camera = { id: 'camera_formats', kind: 'camera', name: 'Main camera', loop: false,
    audio: { volume: .67, muted: true, mode: 'follow', delayMs: 120 } };
  initial.sources = [camera];
  const template = initial.scenes[0].layers[0];
  initial.scenes[0].layers = [{ ...template, id: 'camera_one', kind: 'source', sourceId: camera.id }];
  initial.scenes[1].layers = [{ ...template, id: 'camera_two', kind: 'source', sourceId: camera.id }];
  const seeded = await request.put(`${base}/api/studio`, { data: initial });
  assert.equal(seeded.status(), 200, await seeded.text());
  const before = await getState();
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await installCameras(page);
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  const row = () => page.locator(`.source-list .source-row[data-source-id="${camera.id}"]`);
  const dialog = () => page.getByRole('dialog', { name: 'Source properties', exact: true });
  const resolution = () => dialog().getByLabel('Resolution', { exact: true });
  const frameRate = () => dialog().getByLabel('Frame rate', { exact: true });
  const trace = () => page.evaluate(() => window.__cameraFormats.snapshot());
  const selected = () => page.evaluate(() => JSON.parse(localStorage.getItem('lumen:input:camera_formats')));
  const connect = async () => {
    await row().getByRole('button', { name: 'Connect', exact: true }).click();
    await row().getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  };
  const disconnect = async () => {
    await row().getByRole('button', { name: 'Disconnect', exact: true }).click();
    await row().getByRole('button', { name: 'Connect', exact: true }).waitFor();
  };
  const open = async () => { await row().getByRole('button', { name: /^Properties for / }).click(); await dialog().waitFor(); };
  const cancel = async () => { await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); };
  const save = async () => { await dialog().getByRole('button', { name: 'Save changes', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); };
  const previewReady = (width, height, fps, deviceId = 'builtin-video', setup = dialog()) => until(async () => {
    const decoded = await setup.getByTestId('source-camera-preview').evaluate((video, expected) => {
      const settings = video.srcObject?.getVideoTracks()[0]?.getSettings();
      return video.readyState >= 2 && video.videoWidth === expected.width && video.videoHeight === expected.height
        && settings?.deviceId === expected.deviceId && settings?.width === expected.width
        && settings?.height === expected.height && settings?.frameRate === expected.fps;
    }, { width, height, fps, deviceId });
    const caption = await setup.locator('.camera-preview-caption').textContent();
    return decoded && caption.includes(`${width} × ${height}`) && caption.includes(`${fps} fps`);
  }, `${deviceId} decodes and reports ${width}x${height} at ${fps} fps`);
  const live = async () => (await trace()).tracks.filter(track => track.readyState === 'live');
  const explicitFormat = (value, width, height, fps) => {
    assert.equal(value.width, width); assert.equal(value.height, height); assert.equal(value.frameRate, fps);
  };
  const assertPublisherUnchanged = async original => {
    const current = (await trace()).tracks.find(track => track.handle === original.handle);
    assert.deepEqual(current, original, 'Setup edits do not change or stop the published camera track');
  };

  await connect();
  const original = (await live())[0], autoSelection = await selected();
  explicitFormat(original.settings, 640, 360, 25);
  const initialCalls = (await trace()).calls.length;
  await open(); await previewReady(640, 360, 25);
  assert.equal(await resolution().inputValue(), ''); assert.equal(await frameRate().inputValue(), '');
  await resolution().selectOption('1280x720'); await previewReady(1280, 720, 25);
  await frameRate().selectOption('30'); await previewReady(1280, 720, 30);
  assert.equal((await trace()).calls.length, initialCalls, 'Format changes reuse a camera clone without reopening hardware');
  await assertPublisherUnchanged(original);
  assert.deepEqual(await selected(), autoSelection, 'Draft formats are not remembered before Save');
  await cancel();
  assert.deepEqual(await live(), [original], 'Cancel releases setup tracks and retains the original format');
  checks.push('Resolution and FPS change real decoded preview dimensions using an independent clone; Cancel leaves the published format and remembered selection intact');

  await open(); await previewReady(640, 360, 25);
  await resolution().selectOption('1280x720'); await previewReady(1280, 720, 25);
  await frameRate().selectOption('30'); await previewReady(1280, 720, 30);
  await page.screenshot({ path: path.join(dir, 'camera-format-properties.png'), fullPage: true });
  await save();
  explicitFormat(await selected(), 1280, 720, 30);
  assert.equal((await trace()).calls.length, initialCalls, 'Save transfers the tested clone without opening the camera again');
  assert.equal((await live()).length, 1); explicitFormat((await live())[0].settings, 1280, 720, 30);
  assert.equal((await trace()).tracks.find(track => track.handle === original.handle).readyState, 'ended');
  const saved = await getState();
  assert.deepEqual(saved.sources, [camera], 'Format settings preserve the existing source ID and mixer configuration');
  assert.deepEqual(saved.scenes, before.scenes, 'Format edits retain shared layer references');
  await open(); await previewReady(1280, 720, 30);
  assert.equal(await resolution().inputValue(), '1280x720'); assert.equal(await frameRate().inputValue(), '30');
  await cancel();
  await disconnect(); await connect();
  const reconnect = (await trace()).calls.at(-1).video;
  assert.deepEqual(reconnect.deviceId, { exact: 'builtin-video' });
  assert.deepEqual(reconnect.width, { exact: 1280 }); assert.deepEqual(reconnect.height, { exact: 720 }); assert.deepEqual(reconnect.frameRate, { exact: 30 });
  explicitFormat((await live())[0].settings, 1280, 720, 30);
  checks.push('Save preserves source identity and mixer settings; reopened Properties and reconnected capture retain exact resolution and FPS');

  // A browser reload rebuilds capture state from local persistence, not a track
  // that happened to stay live in memory throughout the previous assertions.
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await connect();
  explicitFormat((await live())[0].settings, 1280, 720, 30);
  await open(); await previewReady(1280, 720, 30);
  assert.equal(await resolution().inputValue(), '1280x720'); assert.equal(await frameRate().inputValue(), '30');
  await resolution().selectOption(''); await previewReady(640, 360, 30);
  await frameRate().selectOption(''); await previewReady(640, 360, 25);
  await save();
  const automatic = await selected();
  for (const key of ['width', 'height', 'frameRate']) assert.equal(Object.hasOwn(automatic, key), false, `Auto removes ${key} from remembered input`);
  await disconnect(); await connect();
  const autoRequest = (await trace()).calls.at(-1).video;
  for (const key of ['width', 'height', 'frameRate']) assert.equal(autoRequest[key]?.exact, undefined, `Auto reconnect does not require an exact ${key}`);
  await open(); await previewReady(640, 360, 25);
  assert.equal(await resolution().inputValue(), ''); assert.equal(await frameRate().inputValue(), '');
  await cancel();
  checks.push('Saved formats survive a browser reload; Auto clears explicit preferences, renegotiates the picture and remains Auto after reconnect');

  const autoPublisher = (await live())[0], callsBeforeInvalid = (await trace()).calls.length;
  await open(); await previewReady(640, 360, 25);
  await resolution().selectOption('1920x1080'); await previewReady(1920, 1080, 25);
  await frameRate().selectOption('60');
  await until(() => dialog().getByTestId('camera-preview-stage').getAttribute('data-state').then(state => state === 'error'), 'unsupported format shows a preview error');
  assert.equal(await dialog().getByRole('alert').count() > 0, true, 'Unsupported format has an actionable error');
  assert.equal(await dialog().getByRole('button', { name: 'Save changes', exact: true }).isEnabled(), false);
  assert.equal((await trace()).calls.length, callsBeforeInvalid, 'Rejected explicit mode never falls back to reopening a default camera');
  await assertPublisherUnchanged(autoPublisher);
  assert.deepEqual(await selected(), automatic);
  await frameRate().selectOption(''); await previewReady(1920, 1080, 25);
  assert.equal(await dialog().getByRole('alert').count(), 0, 'Choosing Auto FPS clears the rejected-mode error in the same dialog');
  assert.equal(await dialog().getByRole('button', { name: 'Save changes', exact: true }).isEnabled(), true);
  await resolution().selectOption(''); await previewReady(640, 360, 25);
  assert.equal((await trace()).calls.length, callsBeforeInvalid, 'Recovery reuses the live publisher clone without reopening hardware');
  await assertPublisherUnchanged(autoPublisher);
  await cancel(); assert.deepEqual(await live(), [autoPublisher]);
  checks.push('An unsupported resolution/FPS combination disables Save without substitution; choosing Auto recovers the preview in the same dialog while preserving the publisher');

  await open(); await previewReady(640, 360, 25);
  await resolution().selectOption('1280x720'); await previewReady(1280, 720, 25);
  await frameRate().selectOption('30'); await previewReady(1280, 720, 30);
  await dialog().getByLabel('Video device', { exact: true }).selectOption('hdmi-video');
  await previewReady(1280, 720, 30, 'hdmi-video');
  assert.equal(await resolution().inputValue(), '', 'A different camera starts with Auto resolution');
  assert.equal(await frameRate().inputValue(), '', 'A different camera starts with Auto FPS');
  const switched = (await trace()).calls.at(-1).video;
  assert.deepEqual(switched.deviceId, { exact: 'hdmi-video' });
  for (const key of ['width', 'height', 'frameRate']) assert.equal(switched[key]?.exact, undefined);
  await assertPublisherUnchanged(autoPublisher);
  await cancel(); assert.deepEqual(await live(), [autoPublisher]);
  checks.push('Switching devices resets format controls to Auto and previews the new device’s actual negotiated mode without committing it');

  await open(); await previewReady(640, 360, 25);
  await resolution().selectOption('1280x720'); await previewReady(1280, 720, 25);
  await frameRate().selectOption('30'); await previewReady(1280, 720, 30);
  const rejectSave = route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Format save interrupted' }) }) : route.continue();
  await page.route('**/api/studio', rejectSave);
  await dialog().getByRole('button', { name: 'Save changes', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: 'Format save interrupted' }).waitFor();
  await assertPublisherUnchanged(autoPublisher);
  assert.deepEqual(await selected(), automatic, 'Failed Save does not remember the draft format');
  await page.unroute('**/api/studio', rejectSave);
  await cancel(); assert.deepEqual(await live(), [autoPublisher]);
  checks.push('A failed station save retains the original camera format and local preferences and releases replacement tracks on Cancel');

  await until(() => page.locator('[data-sonner-toast]').count().then(count => count === 0), 'transient save-error notification dismissed');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(); await previewReady(640, 360, 25);
  const saveBounds = await dialog().getByRole('button', { name: 'Save changes', exact: true }).boundingBox();
  assert.ok(saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 844 && saveBounds.x + saveBounds.width <= 390, 'Save remains reachable on mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Format controls do not create horizontal page overflow');
  await page.screenshot({ path: path.join(dir, 'camera-format-mobile.png'), fullPage: true });
  await cancel(); await disconnect();
  assert.deepEqual(await live(), [], 'All camera tracks are released when the source disconnects');

  await page.setViewportSize({ width: 1512, height: 982 });
  const addDialog = () => page.getByRole('dialog', { name: 'Add a source', exact: true });
  const callsBeforeAdd = (await trace()).calls.length;
  await page.getByRole('button', { name: 'Add production source', exact: true }).click(); await addDialog().waitFor();
  assert.equal((await trace()).calls.length, callsBeforeAdd, 'Opening Add source remains passive');
  await addDialog().getByLabel('Video device', { exact: true }).selectOption('hdmi-video');
  await previewReady(1280, 720, 30, 'hdmi-video', addDialog());
  await addDialog().getByLabel('Resolution', { exact: true }).selectOption('1920x1080');
  await previewReady(1920, 1080, 30, 'hdmi-video', addDialog());
  await addDialog().getByLabel('Frame rate', { exact: true }).selectOption('25');
  await previewReady(1920, 1080, 25, 'hdmi-video', addDialog());
  await addDialog().getByLabel('Name', { exact: true }).fill('Added HDMI camera');
  assert.equal((await trace()).calls.length, callsBeforeAdd + 1, 'New-source format changes reuse the tested setup capture');
  await addDialog().getByRole('button', { name: 'Add to Studio', exact: true }).click(); await addDialog().waitFor({ state: 'hidden' });
  const addedState = await getState(), added = addedState.sources.find(source => source.name === 'Added HDMI camera');
  assert.ok(added && added.id !== camera.id && added.kind === 'camera', 'Add creates a new camera source with its own ID');
  assert.equal(addedState.sources.length, 2);
  const addedSelection = await page.evaluate(id => JSON.parse(localStorage.getItem(`lumen:input:${id}`)), added.id);
  assert.equal(addedSelection.videoDeviceId, 'hdmi-video'); explicitFormat(addedSelection, 1920, 1080, 25);
  assert.deepEqual(await selected(), automatic, 'A new camera’s format does not overwrite another source’s settings');
  assert.equal((await trace()).calls.length, callsBeforeAdd + 1, 'Add transfers the preview rather than requesting the device again');
  assert.equal((await live()).length, 1); explicitFormat((await live())[0].settings, 1920, 1080, 25);
  const addedRow = () => page.locator(`.source-list .source-row[data-source-id="${added.id}"]`);
  await addedRow().getByRole('button', { name: 'Disconnect', exact: true }).click();
  await addedRow().getByRole('button', { name: 'Connect', exact: true }).click();
  await addedRow().getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  const addedReconnect = (await trace()).calls.at(-1).video;
  assert.deepEqual(addedReconnect.deviceId, { exact: 'hdmi-video' });
  assert.deepEqual(addedReconnect.width, { exact: 1920 }); assert.deepEqual(addedReconnect.height, { exact: 1080 }); assert.deepEqual(addedReconnect.frameRate, { exact: 25 });
  await addedRow().getByRole('button', { name: /^Properties for / }).click(); await dialog().waitFor();
  await previewReady(1920, 1080, 25, 'hdmi-video');
  assert.equal(await resolution().inputValue(), '1920x1080'); assert.equal(await frameRate().inputValue(), '25');
  await cancel();
  await addedRow().getByRole('button', { name: 'Disconnect', exact: true }).click();
  assert.deepEqual(await live(), [], 'New-camera preview and publisher tracks are released after disconnect');
  checks.push('Adding a camera transfers its explicitly configured preview, stores format per source, and reconnects/reopens Properties at the exact saved mode');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(await page?.evaluate(() => ({ trace: window.__cameraFormats?.snapshot(),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) })).catch(() => null));
  console.error({ errors }); console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]); }
}
