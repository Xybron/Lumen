// Real WebRTC/compositor/output regression with synthetic OS video/audio
// devices. No physical camera, microphone, or existing station data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-capture-card-'));
const port = Number(process.env.LUMEN_CAPTURE_TEST_PORT ?? 3461), base = `http://127.0.0.1:${port}`;
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
      calls: [], stops: [], enumerations: 0,
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
  });
}

try {
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
  const command = async command => { const state = await get(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } }); assert.equal(response.status(), 200, await response.text()); };
  const initial = await get();
  page = await context.newPage(); page.setDefaultTimeout(15000);
  await installDevices(page); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  const dialog = () => page.getByRole('dialog', { name: 'Add a source', exact: true });
  const video = () => dialog().getByLabel('Video device', { exact: true });
  const audio = () => dialog().getByLabel('Audio device', { exact: true });
  const preview = () => dialog().getByTestId('source-camera-preview');
  const startPreview = () => dialog().getByRole('button', { name: /^(Start preview|Try again)$/ }).click();
  const previewReady = () => until(() => preview().evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'setup preview has decoded pixels');
  const trace = () => page.evaluate(() => ({ calls: window.__captureDevices.calls, stops: window.__captureDevices.stops, enumerations: window.__captureDevices.enumerations, ...window.__captureDevices.status() }));
  const row = id => page.locator(`.source-list .source-row[data-source-id="${id}"]`);
  const open = async () => { await page.getByRole('button', { name: 'Add production source', exact: true }).click(); await dialog().waitFor(); };
  await page.evaluate(() => window.__captureDevices.addCard({ notify: false, label: 'USB Video' }));
  await open();
  assert.equal((await trace()).calls.length, 0, 'Opening input setup does not capture hardware');
  await dialog().getByTestId('input-device-discovery').filter({ hasText: 'Access needed' }).waitFor();
  const allowCamera = dialog().getByRole('button', { name: 'Allow camera access', exact: true });
  await allowCamera.waitFor();
  await page.evaluate(() => window.__captureDevices.failNext('NotReadableError'));
  await allowCamera.click();
  await until(async () => (await trace()).calls.length === 1, 'access button requests camera permission');
  await until(() => video().locator('option[value="hdmi-video"]').textContent().then(text => text === 'USB Video'), 'already-connected generic card is found even when default camera is busy');
  await dialog().getByRole('alert').filter({ hasText: 'Close other apps' }).waitFor();
  const failedEnumeration = (await trace()).enumerations;
  await until(async () => (await trace()).enumerations > failedEnumeration, 'passive scan continues after access failure');
  assert.ok(await dialog().getByRole('alert').filter({ hasText: 'Close other apps' }).isVisible(), 'A passive rescan does not hide access errors');
  await startPreview();
  await until(() => video().locator('option[value="builtin-video"]').count(), 'permission reveals device names');
  await until(() => dialog().getByRole('alert').count().then(count => count === 0), 'successful discovery clears access error');
  await previewReady();
  assert.ok((await trace()).live.includes('builtin-video'), 'Device access remains available as a local preview');
  assert.equal(await preview().evaluate(video => video.muted), true, 'Setup never plays input audio through the speakers');
  await dialog().getByTestId('input-device-discovery').filter({ hasText: '2 devices' }).waitFor();
  const discoveryCaptures = (await trace()).calls.length;
  await page.evaluate(() => window.__captureDevices.remove('hdmi-video', false));
  await until(() => video().locator('option[value="hdmi-video"]').count().then(count => count === 0), 'polling detects removal with no devicechange event');
  await page.evaluate(() => window.__captureDevices.addCard({ notify: false, label: 'USB2.0 Camera' }));
  await until(() => video().locator('option[value="hdmi-video"]').textContent().then(text => text === 'USB2.0 Camera'), 'polling discovers a generically named card with no devicechange event');
  assert.equal((await trace()).calls.length, discoveryCaptures, 'Automatic discovery never opens a feed');
  await page.evaluate(() => window.__captureDevices.remove('hdmi-video'));
  await until(() => video().locator('option[value="hdmi-video"]').count().then(count => count === 0), 'devicechange removes the card from the list');
  await page.evaluate(() => { window.__captureDevices.addCard({ notify: false }); window.dispatchEvent(new Event('focus')); });
  await until(() => video().locator('option[value="hdmi-video"]').count(), 'returning to Lumen rescans for the card');
  await page.evaluate(() => { window.__captureDevices.remove('hdmi-video'); });
  await until(() => video().locator('option[value="hdmi-video"]').count().then(count => count === 0), 'card removed before hot plug');
  await page.evaluate(() => window.__captureDevices.addCard());
  await until(() => video().locator('option[value="hdmi-video"]').count(), 'hot-plugged HDMI card appears');
  await video().selectOption('hdmi-video');
  await previewReady();
  assert.equal(await preview().evaluate(video => video.srcObject.getVideoTracks()[0].getSettings().deviceId), 'hdmi-video');
  await dialog().getByLabel('Name', { exact: true }).fill('HDMI camera');
  await page.evaluate(() => window.__captureDevices.remove('hdmi-video'));
  await dialog().getByRole('alert').filter({ hasText: 'Device disconnected' }).waitFor();
  assert.equal(await dialog().getByRole('button', { name: 'Add to Studio', exact: true }).isEnabled(), false);
  await page.evaluate(() => window.__captureDevices.addCard());
  await until(() => dialog().getByRole('button', { name: 'Add to Studio', exact: true }).isEnabled(), 'reinserted selected card is usable');
  await dialog().getByLabel('Include audio', { exact: true }).check();
  await audio().selectOption('hdmi-audio');
  await previewReady();
  await until(() => dialog().getByRole('button', { name: 'Add to Studio', exact: true }).isEnabled(), 'selected video and audio ready');
  assert.equal(await dialog().locator('details').getAttribute('open'), null, 'Connection guidance stays collapsed');
  const sourceCalls = (await trace()).calls.length;
  await page.screenshot({ path: path.join(dir, 'capture-card-setup.png'), fullPage: true });
  await dialog().getByRole('button', { name: 'Add to Studio', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
  const camera = await until(async () => (await get()).sources.find(source => source.name === 'HDMI camera'), 'camera saved');
  assert.equal((await trace()).calls.length, sourceCalls, 'Add hands off the tested stream without reopening the camera');
  assert.ok((await trace()).calls.some(call => call.audio?.deviceId?.exact === 'hdmi-audio'));
  assert.equal(camera.audio.muted, true); assert.deepEqual((await get()).program, initial.program, 'Adding the camera changes only Preview');
  checks.push('Already-connected and generic USB Video/USB2.0 Camera inputs are found; busy-default discovery, missed-event polling, focus rescan, hot plug and visible input counts');
  checks.push('Permission-gated names, disconnected selection, exact HDMI video/audio selection and muted Preview-only addition');

  await page.getByRole('button', { name: 'Start engine', exact: true }).click();
  await until(async () => (await status()).state === 'running', 'real renderer starts', 45000);
  await until(async () => (await status()).sources[camera.id] === 'ready', 'renderer receives decoded camera frames');
  const sample = locator => locator.evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
  const green = pixels => pixels[1] > 120 && pixels[0] < 80 && pixels[2] < 110;
  const blue = pixels => pixels[2] > 150 && pixels[0] < 80 && pixels[1] < 110;
  await until(async () => green(await sample(page.locator('.preview-panel video'))), 'actual green capture pixels in Preview');
  await command({ type: 'take', sceneId: (await get()).previewSceneId, transition: 'cut' });
  await until(async () => green(await sample(page.locator('.program-panel video'))), 'actual capture pixels in Program');
  const output = await context.newPage(); await output.goto(`${base}/studio/output/program`);
  await until(async () => green(await sample(output.locator('video'))), 'camera reaches independent output');
  await page.evaluate(() => window.__captureDevices.color('#182cde'));
  await until(async () => blue(await sample(output.locator('video'))), 'output follows live camera frames rather than a still image');
  await output.screenshot({ path: path.join(dir, 'capture-card-output.png') });
  await command({ type: 'set-main-audio', sourceId: camera.id });
  await until(async () => (await status()).levels.master > .01, 'HDMI audio reaches the master mix');
  const audioPeak = await output.locator('video').evaluate(async video => {
    const audio = new AudioContext(); await audio.resume();
    const source = audio.createMediaStreamSource(video.srcObject), analyser = audio.createAnalyser(), silent = audio.createGain();
    analyser.fftSize = 2048; silent.gain.value = 0;
    source.connect(analyser); analyser.connect(silent); silent.connect(audio.destination);
    const samples = new Float32Array(2048); let peak = 0;
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 60)); analyser.getFloatTimeDomainData(samples);
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
    }
    source.disconnect(); analyser.disconnect(); silent.disconnect(); await audio.close(); return peak;
  });
  assert.ok(audioPeak > .01, `The actual output carries non-silent HDMI audio (${audioPeak})`);
  checks.push('Real synthetic card crosses WebRTC into renderer, Preview, Program and output; decoded pixels follow frame changes and HDMI audio reaches the output mix');

  await row(camera.id).getByRole('button', { name: 'Disconnect', exact: true }).click();
  assert.deepEqual((await trace()).live, []);
  await row(camera.id).getByRole('button', { name: 'Connect', exact: true }).click();
  await until(async () => (await status()).sources[camera.id] === 'ready', 'saved card reconnects');
  assert.deepEqual((await trace()).calls.at(-1).video.deviceId, { exact: 'hdmi-video' });
  assert.deepEqual((await trace()).calls.at(-1).audio.deviceId, { exact: 'hdmi-audio' });
  await page.evaluate(() => window.__captureDevices.remove('hdmi-video'));
  await row(camera.id).getByRole('button', { name: 'Connect', exact: true }).waitFor();
  await until(async () => (await status()).sources[camera.id] === 'missing', 'unplugged video is missing even with HDMI audio');
  const beforeRetry = (await trace()).calls.length;
  await row(camera.id).getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText(/The selected input is unavailable/).waitFor();
  assert.equal((await trace()).calls.length, beforeRetry + 1); assert.deepEqual((await trace()).live, []);
  await page.evaluate(() => window.__captureDevices.addCard());
  await row(camera.id).getByRole('button', { name: 'Connect', exact: true }).click();
  await until(async () => green(await sample(output.locator('video'))), 'replugged card restores live output');
  checks.push('Reconnect retains exact video/audio, unplug releases tracks and marks missing, absent card never falls back to built-in camera, replug restores output');

  // Selecting Default once must bind reconnect to the actual device used.
  await open(); await startPreview(); await previewReady(); await dialog().getByLabel('Name', { exact: true }).fill('Default camera');
  await dialog().getByRole('button', { name: 'Add to Studio', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
  const defaultCamera = await until(async () => (await get()).sources.find(source => source.name === 'Default camera'), 'default source saved');
  await row(defaultCamera.id).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await row(defaultCamera.id).getByRole('button', { name: 'Connect', exact: true }).click();
  await row(defaultCamera.id).getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  assert.deepEqual((await trace()).calls.at(-1).video.deviceId, { exact: 'builtin-video' });
  await row(defaultCamera.id).getByRole('button', { name: 'Disconnect', exact: true }).click();

  // Previewing a device already on Program borrows independent tracks and
  // never reopens its hardware, changes Program, or stops its published feed.
  const onAir = structuredClone((await get()).program), callsBeforeBorrow = (await trace()).calls.length;
  await open(); await video().selectOption('hdmi-video'); await previewReady();
  assert.equal((await trace()).calls.length, callsBeforeBorrow);
  await video().selectOption('builtin-video'); await previewReady();
  await until(() => preview().evaluate(video => video.srcObject.getVideoTracks()[0].getSettings().deviceId === 'builtin-video'), 'changing camera updates the local picture');
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual((await get()).program, onAir);
  await until(async () => green(await sample(output.locator('video'))), 'switching and canceling setup preserve Program video');
  assert.ok((await trace()).live.every(id => id.startsWith('hdmi-')));
  checks.push('Camera switching updates the local muted preview; opening an active card uses cloned tracks and cancel leaves Program live');

  await open(); await page.evaluate(() => window.__captureDevices.deny(true));
  await startPreview();
  await dialog().getByRole('alert').filter({ hasText: 'system privacy settings' }).waitFor();
  await page.evaluate(() => window.__captureDevices.deny(false));
  await startPreview();
  await until(() => dialog().getByRole('alert').count().then(count => count === 0), 'retry clears permission error');
  await previewReady();
  await until(() => page.locator('[data-sonner-toast]').count().then(count => count === 0), 'transient error messages dismiss');
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog().getByRole('button', { name: 'Refresh devices', exact: true }).click();
  const addBounds = await dialog().getByRole('button', { name: 'Add to Studio', exact: true }).boundingBox();
  assert.ok(addBounds.y >= 0 && addBounds.y + addBounds.height <= 844 && addBounds.x + addBounds.width <= 390, 'Footer action fits the viewport');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(dir, 'capture-card-mobile.png'), fullPage: true });
  await page.evaluate(() => window.__captureDevices.defer());
  await video().selectOption('hdmi-video');
  await previewReady();
  await video().selectOption('builtin-video');
  await until(async () => (await trace()).pending, 'permission request held');
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => window.__captureDevices.release());
  await until(async () => (await trace()).live.every(id => id.startsWith('hdmi-')), 'late permission capture releases after dialog closes');
  const closedEnumerations = (await trace()).enumerations;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal((await trace()).enumerations, closedEnumerations, 'Closing input setup stops passive scans and focus discovery');
  checks.push('Default resolves to a stable device; permission denial/retry, 390px controls and late preview cleanup');
  assert.deepEqual(errors, []);
  await output.close();
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, limitation: 'Synthetic OS devices in local Chromium; physical macOS/Windows card and driver acceptance remains required.', checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(await page?.evaluate(() => ({ trace: window.__captureDevices && { calls: window.__captureDevices.calls, stops: window.__captureDevices.stops, ...window.__captureDevices.status() }, options: [...document.querySelectorAll('select')].map(select => select.outerHTML), alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) })).catch(() => null));
  console.error({ errors });
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]); }
}
