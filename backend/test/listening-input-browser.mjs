// Local-listening device/permission regression on a disposable station. Browser
// inputs are oscillator-backed MediaStreams, never the operator's microphone.
// A deterministic local worker verifies the HTTP/capture plumbing, NOT accent
// accuracy; that requires consented, representative real-speaker recordings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-listening-input-'));
const port = Number(process.env.LUMEN_LISTENING_INPUT_TEST_PORT ?? 3448), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let server, browser, page, logs = '';
const checks = [], errors = [], calls = [], nativeDialogs = [];
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function installMediaDouble(context) {
  await context.addInitScript(() => {
    const media = navigator.mediaDevices, captures = [], connections = [], outputAnalysers = [];
    let permitted = sessionStorage.getItem('__listening-test-permission') === 'granted', denied = false;
    const permission = new EventTarget();
    Object.defineProperty(permission, 'state', { get: () => denied ? 'denied' : permitted ? 'granted' : 'prompt' });
    const nativePermissionQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = descriptor => descriptor.name === 'microphone' ? Promise.resolve(permission) : nativePermissionQuery(descriptor);
    const available = new Map([
      ['default', 'System default microphone'], ['built-in', 'MacBook Pro Microphone'], ['usb-desk', 'USB Church Sound Desk'],
    ]);
    const originalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args) {
      if (args[0] instanceof AudioDestinationNode) {
        connections.push({ type: this.constructor.name, time: performance.now() });
        if (this instanceof AudioWorkletNode) {
          const analyser = this.context.createAnalyser(); originalConnect.call(this, analyser); outputAnalysers.push(analyser);
        }
      }
      return originalConnect.apply(this, args);
    };
    const trace = {
      calls: [], stops: [], connections, denied: value => { denied = value; if (value) { permitted = false; sessionStorage.removeItem('__listening-test-permission'); } permission.dispatchEvent(new Event('change')); },
      status: () => ({ permitted, live: captures.filter(item => item.track.readyState === 'live').map(item => item.id) }),
      outputPeaks: () => outputAnalysers.map(analyser => { const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples); return samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0); }),
      remove: id => { available.delete(id); media.dispatchEvent(new Event('devicechange')); },
      add: (id, label) => { available.set(id, label); media.dispatchEvent(new Event('devicechange')); },
      end: id => { for (const item of captures.filter(item => item.id === id && item.track.readyState === 'live')) { item.track.stop(); item.track.dispatchEvent(new Event('ended')); } },
    };
    Object.defineProperty(window, '__listeningMedia', { value: trace });
    Object.defineProperty(media, 'enumerateDevices', { value: async () => [...available].map(([deviceId, label]) => ({
      deviceId, kind: 'audioinput', groupId: deviceId === 'default' ? 'builtin-group' : `${deviceId}-group`, label: permitted ? label : '',
      toJSON() { return { deviceId, kind: this.kind, groupId: this.groupId, label: this.label }; },
    })) });
    Object.defineProperty(media, 'getUserMedia', { value: async constraints => {
      trace.calls.push(structuredClone(constraints));
      if (denied) throw new DOMException('Microphone permission was denied.', 'NotAllowedError');
      const selected = typeof constraints.audio === 'object' ? constraints.audio.deviceId : null;
      const id = typeof selected === 'string' ? selected : selected?.exact ?? selected?.ideal ?? 'default';
      if (!available.has(id)) throw new DOMException('Selected audio device is unavailable.', 'NotFoundError');
      permitted = true; sessionStorage.setItem('__listening-test-permission', 'granted'); permission.dispatchEvent(new Event('change'));
      const audio = new AudioContext(), oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
      oscillator.frequency.value = 173; gain.gain.value = .16; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await audio.resume();
      const stream = destination.stream, track = stream.getAudioTracks()[0], nativeStop = track.stop.bind(track);
      Object.defineProperty(track, 'label', { value: available.get(id) });
      track.getSettings = () => ({ deviceId: id, groupId: `${id}-group`, channelCount: 1, sampleRate: audio.sampleRate });
      track.stop = () => { if (track.readyState === 'ended') return; trace.stops.push(id); nativeStop(); oscillator.stop(); void audio.close(); };
      captures.push({ id, stream, track }); return stream;
    } });
  });
}

try {
  // Executable and model remain inside this test's temporary directory. No real
  // Whisper process, network model download, model cache, or cloud service runs.
  const worker = path.join(dir, 'fake-whisper.cjs'), workerLog = path.join(dir, 'worker-audio.jsonl'), workerReady = path.join(dir, 'worker-ready'), modelDirectory = path.join(dir, 'ai', 'models');
  await fs.mkdir(modelDirectory, { recursive: true });
  await fs.writeFile(path.join(modelDirectory, 'ggml-base.en.bin'), 'isolated test base model placeholder');
  await fs.writeFile(path.join(modelDirectory, 'ggml-small.en.bin'), 'isolated test small model placeholder');
  await fs.writeFile(worker, `#!${process.execPath}\nconst http=require('node:http'),fs=require('node:fs');const port=Number(process.argv[process.argv.indexOf('--port')+1]);const server=http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{if(req.url==='/health'&&!fs.existsSync(${JSON.stringify(workerReady)})){res.statusCode=503;res.end('warming');return;}if(req.url==='/inference'){const body=Buffer.concat(chunks),offset=body.indexOf(Buffer.from('RIFF'));fs.appendFileSync(${JSON.stringify(workerLog)},JSON.stringify(offset<0?{riff:false}:{riff:true,rate:body.readUInt32LE(offset+24),channels:body.readUInt16LE(offset+22),bits:body.readUInt16LE(offset+34),bytes:body.readUInt32LE(offset+40)+44})+'\\n');}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:{text:'No reliable speech sample.'}));});});server.listen(port,'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit()));\n`, { mode: 0o700 });
  server = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base, LUMEN_WHISPER_SERVER: worker, LUMEN_WHISPER_MODEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station startup', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  await installMediaDouble(context);
  const request = context.request;
  const login = await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }); assert.equal(login.status(), 200, await login.text());
  const channels = [{ id: 'scripture', name: 'Scripture', kind: 'scripture' }, { id: 'lyrics', name: 'Lyrics', kind: 'lyrics' }];
  const saved = await request.put(`${base}/api/content`, { data: {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: channels.map(channel => ({ ...channel, playlistId: `p_${channel.id}`, defaultMode: 'manual' })),
    playlists: channels.map(channel => ({ id: `p_${channel.id}`, name: channel.name, items: [] })),
  } }); assert.equal(saved.status(), 200, await saved.text());
  const production = async () => (await request.get(`${base}/api/studio`)).json();
  const workspace = async id => (await request.get(`${base}/api/worship/channels/${id}`)).json();
  const studio = await production();
  studio.sources = [{ id: 'main', name: 'Persistent preacher audio', kind: 'microphone', loop: false, audio: { volume: .73, muted: false, mode: 'always', delayMs: 80 } }];
  studio.scenes = [{ id: 'preacher', name: 'Preacher', background: '#18302b', layers: [] }, { id: 'announcement', name: 'Announcement', background: '#302820', layers: [] }];
  studio.previewSceneId = 'announcement'; studio.mainAudioSourceId = 'main'; studio.masterVolume = .81; studio.masterMuted = false;
  const studioSave = await request.put(`${base}/api/studio`, { data: studio }); assert.equal(studioSave.status(), 200, await studioSave.text());
  const initialStudio = await production(), initialWorkspaces = Object.fromEntries(await Promise.all(channels.map(async channel => [channel.id, await workspace(channel.id)])));
  const speechStatus = await (await request.get(`${base}/api/worship/listening/status`)).json();
  assert.equal(speechStatus.local, true); assert.equal(speechStatus.decoding, 'beam-search'); assert.equal(speechStatus.modelId, 'base.en');
  assert.equal(speechStatus.profiles.filter(profile => profile.installed).length, 2, 'Only the explicitly installed temporary profiles are available');
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.post(`${base}/api/worship/listening/model`, { data: { modelId: 'small.en' } })).status(), 401, 'A model change requires an authenticated station operator');
  await anonymous.close();
  for (const body of [{ modelId: '../../external-model' }, { modelId: 'base.en', prompt: 'Untrusted browser instructions' }]) {
    const response = await request.post(`${base}/api/worship/listening/model`, { data: body }); assert.equal(response.status(), 422, await response.text());
  }
  const uninstalled = await request.post(`${base}/api/worship/listening/model`, { data: { modelId: 'medium.en' } });
  assert.equal(uninstalled.status(), 409, await uninstalled.text());
  assert.equal((await (await request.get(`${base}/api/worship/listening/status`)).json()).modelId, 'base.en', 'Unavailable or invalid model choices do not silently download or replace the selected model');
  checks.push('Speech-model API requires authentication, rejects arbitrary paths/prompts, and never downloads or selects an unavailable model');
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async prompt => { nativeDialogs.push({ type: prompt.type(), message: prompt.message() }); await prompt.dismiss(); });
  page.on('request', request => {
    if (['POST', 'DELETE', 'PUT'].includes(request.method())) calls.push({ path: new URL(request.url()).pathname, session: new URL(request.url()).searchParams.get('session'), method: request.method(), body: request.headers()['content-type']?.startsWith('application/json') ? request.postDataJSON() : null, bytes: request.headers()['content-type']?.startsWith('audio/wav') ? request.postDataBuffer() : null });
  });
  await page.goto(base); await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  const media = () => page.evaluate(() => ({ calls: window.__listeningMedia.calls, stops: window.__listeningMedia.stops, connections: window.__listeningMedia.connections, ...window.__listeningMedia.status() }));
  const audioRequests = () => calls.filter(call => /\/listening\/audio$/.test(call.path));
  const sessionRequests = () => calls.filter(call => /\/listening$/.test(call.path) && call.method === 'POST');
  assert.equal((await media()).calls.length, 0, 'Opening Scripture never requests microphone permission or records audio');
  checks.push('Opening a content channel does not acquire microphone permission or capture');

  const settings = () => page.getByRole('button', { name: 'Listening settings', exact: true });
  const dialog = () => page.getByRole('dialog', { name: 'Listening settings', exact: true });
  const input = () => dialog().getByLabel('Listening input', { exact: true });
  const processing = () => dialog().getByLabel('Input processing', { exact: true });
  const model = () => dialog().getByLabel('Local speech model', { exact: true });
  const listen = () => page.getByRole('button', { name: 'Listen', exact: true });
  const stop = () => page.getByRole('button', { name: 'Stop listening', exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function openSettings() { await settings().click(); await dialog().waitFor(); await until(() => model().locator('option[value="base.en"]').count(), 'speech profiles render'); }
  async function closeSettings() { await dialog().getByRole('button', { name: 'Done', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); await settle(); }

  // Retain a prepared cue so the new modal proves it consumes publication
  // shortcuts as well as presentation/Multiview space shortcuts.
  await page.getByLabel('Search scripture', { exact: true }).fill('jn3 16');
  await page.locator('.w-verse-result').first().click();
  await until(() => page.getByRole('button', { name: 'Send live', exact: true }).isEnabled(), 'a private prepared verse');
  await openSettings();
  assert.equal((await media()).calls.length, 0, 'Opening settings still never requests permission or captures audio');
  for (const key of ['Control+Enter', 'Meta+Enter', 'Space']) await page.keyboard.press(key);
  await settle();
  assert.equal(calls.filter(call => /\/command$/.test(call.path)).length, 0, 'Listening settings shields a prepared verse and Studio against live shortcuts');
  checks.push('The settings dialog does not acquire audio and preserves the existing live-shortcut safeguards');

  await page.evaluate(() => window.__listeningMedia.denied(true));
  await dialog().getByRole('button', { name: 'Allow microphone access', exact: true }).click();
  await until(async () => (await dialog().innerText()).includes('Microphone access is blocked.'), 'actionable permission denial');
  assert.deepEqual((await media()).live, []); assert.equal(sessionRequests().length, 0); assert.equal(audioRequests().length, 0);
  await page.evaluate(() => window.__listeningMedia.denied(false));
  await dialog().getByRole('button', { name: 'Allow microphone access', exact: true }).click();
  await until(async () => (await input().locator('option').allTextContents()).includes('USB Church Sound Desk'), 'permission reveals actual device names');
  await until(async () => (await media()).live.length === 0, 'permission-only discovery immediately releases its stream');
  assert.equal((await media()).connections.length, 0, 'Permission discovery never attaches a stream to a speaker graph');
  assert.equal(sessionRequests().length, 0); assert.equal(audioRequests().length, 0);
  await input().selectOption('usb-desk'); await processing().selectOption('mixer');
  const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('lumen.listening-input.v1')));
  assert.deepEqual(selected, { deviceId: 'usb-desk', label: 'USB Church Sound Desk', processing: 'mixer' });
  checks.push('Explicit permission exposes named microphones/interfaces; denied access is explained, and discovery stops every temporary track');

  const beforeTestCaptures = (await media()).calls.length;
  await dialog().getByRole('button', { name: 'Test microphone', exact: true }).click();
  await until(async () => Number(await page.getByTestId('listening-test-meter').getAttribute('aria-valuenow')) > 0, 'synthetic USB input moves the real worklet test meter');
  const testCapture = (await media()).calls.at(-1);
  assert.equal((await media()).calls.length, beforeTestCaptures + 1); assert.deepEqual(testCapture.audio.deviceId, { exact: 'usb-desk' });
  assert.equal(testCapture.audio.echoCancellation, false); assert.equal(testCapture.audio.noiseSuppression, false); assert.equal(testCapture.audio.autoGainControl, false);
  assert.ok((await page.evaluate(() => window.__listeningMedia.outputPeaks())).every(peak => peak < 1e-7), 'The actual worklet output is silent even while the input meter receives audio');
  assert.equal(sessionRequests().length, 0); assert.equal(audioRequests().length, 0, 'Test microphone never opens a transcription session or uploads WAV audio');
  await page.screenshot({ path: path.join(dir, 'listening-settings-meter.png'), fullPage: true });
  await dialog().getByRole('button', { name: 'Stop test', exact: true }).click();
  await until(async () => (await media()).live.length === 0, 'Stop test releases USB capture');
  await dialog().getByRole('button', { name: 'Test microphone', exact: true }).click();
  await until(async () => (await media()).live.includes('usb-desk'), 'a second explicit signal test starts');
  await closeSettings();
  await until(async () => (await media()).live.length === 0, 'closing the dialog automatically stops its local test');
  assert.equal(sessionRequests().length, 0); assert.equal(audioRequests().length, 0);
  checks.push('The local signal test uses the exact selected device/clean-feed constraints, produces a meter but silent speaker output, and releases tracks on stop or dialog closure without any transcription/upload');

  await openSettings();
  const modelCommandsBefore = calls.filter(call => call.path === '/api/worship/listening/model').length;
  await model().selectOption('medium.en');
  await until(async () => (await dialog().innerText()).includes('npm run setup:ai -- --model=medium.en'), 'missing models show an explicit installer command');
  assert.equal(calls.filter(call => call.path === '/api/worship/listening/model').length, modelCommandsBefore, 'Browsing an unavailable model never installs or selects it');
  await model().selectOption('small.en'); await dialog().getByRole('button', { name: 'Use model', exact: true }).click();
  await until(async () => (await (await request.get(`${base}/api/worship/listening/status`)).json()).modelId === 'small.en', 'explicit installed-model choice reaches the station');
  await dialog().getByRole('button', { name: 'In use', exact: true }).waitFor();
  await page.screenshot({ path: path.join(dir, 'listening-settings.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await settle();
  await until(() => dialog().evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth + 1; }), 'responsive settings finish any inherited size transition', 2000);
  const narrowBounds = await dialog().evaluate(element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return { left: rect.left, right: rect.right, innerWidth, width: style.width, maxWidth: style.maxWidth, minWidth: style.minWidth, boxSizing: style.boxSizing, translate: style.translate, transform: style.transform, animationName: style.animationName }; });
  assert.ok(narrowBounds.left >= -1 && narrowBounds.right <= narrowBounds.innerWidth + 1, `Settings fit a narrow viewport: ${JSON.stringify(narrowBounds)}`);
  await dialog().getByRole('button', { name: 'Done', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, 'listening-settings-narrow.png'), fullPage: true });
  await closeSettings(); await page.setViewportSize({ width: 1512, height: 982 });
  await page.reload(); await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  assert.equal((await media()).calls.length, 0, 'Reloading saved preferences never rearms a microphone');
  assert.equal(await page.getByLabel('Listening mode', { exact: true }).inputValue(), 'assisted', 'Automatic publishing is not a persisted preference');
  await openSettings(); assert.equal(await input().inputValue(), 'usb-desk'); assert.equal(await processing().inputValue(), 'mixer'); assert.equal(await model().inputValue(), 'small.en');
  await closeSettings();
  checks.push('Device/processing and explicit installed-model choices persist; unavailable models require deliberate installation, settings fit mobile, and reload never rearms listening or automatic publishing');

  const beforeRemoval = (await media()).calls.length;
  await page.evaluate(() => window.__listeningMedia.remove('usb-desk'));
  await until(() => listen().isDisabled(), 'unplugged persisted device disables Listen instead of falling back');
  await openSettings(); assert.equal(await input().inputValue(), 'usb-desk');
  assert.match(await input().locator('option:checked').innerText(), /disconnected/);
  await dialog().getByRole('button', { name: 'Refresh devices', exact: true }).click(); await settle();
  assert.equal((await media()).calls.length, beforeRemoval, 'Refresh never falls back to the default microphone to probe a missing saved device');
  await closeSettings();
  await page.evaluate(() => window.__listeningMedia.add('usb-desk', 'USB Church Sound Desk'));
  await until(() => listen().isEnabled(), 'reconnected device becomes available');
  assert.equal((await media()).calls.length, beforeRemoval, 'Hotplug only updates the device list; it never captures or rearms');
  checks.push('Missing saved inputs remain explicitly selected and unavailable; refresh/reconnection never substitutes another device or captures audio');

  // The deterministic worker remains in warmup until this test releases it.
  // Cancelling during startup must invalidate the pending backend operation,
  // not merely hide its future lease and leave the channel blocked for45s.
  const pendingSessions = sessionRequests().length;
  await listen().click(); await page.getByRole('button', { name: 'Cancel start', exact: true }).waitFor();
  await until(() => sessionRequests().length === pendingSessions + 1, 'startup request reaches the backend while its local worker is held warming');
  await until(async () => (await (await request.get(`${base}/api/worship/listening/status`)).json()).state === 'starting', 'the backend is genuinely inside worker warmup before cancellation');
  const cancelledLease = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/api/worship/channels/scripture/listening');
  await page.getByRole('button', { name: 'Cancel start', exact: true }).click();
  assert.equal((await cancelledLease).status(), 200);
  await until(async () => (await media()).live.length === 0 && await listen().isEnabled(), 'cancelled startup stops capture immediately');
  await fs.writeFile(workerReady, 'release deterministic worker warmup');
  await until(async () => (await (await request.get(`${base}/api/worship/listening/status`)).json()).state === 'ready', 'previous pending warmup finishes without rearming the cancelled browser');
  const afterCancelModel = await request.post(`${base}/api/worship/listening/model`, { data: { modelId: 'small.en' } });
  assert.equal(afterCancelModel.status(), 200, 'A late ready worker cannot create an orphaned lease after Cancel start');
  assert.equal(audioRequests().length, 0, 'Cancelled warmup never uploads audio'); assert.equal(await stop().count(), 0);
  checks.push('Cancel start releases browser capture and invalidates a genuinely pending backend warmup; a late ready worker cannot publish, rearm or leave a blocking lease');

  const sessionsBeforeListen = sessionRequests().length;
  await listen().click(); await stop().waitFor({ timeout: 30000 });
  await until(async () => Number(await page.getByTestId('listening-level-meter').getAttribute('aria-valuenow')) > 0, 'active listener meter responds independently of an ASR result');
  assert.deepEqual((await media()).calls.at(-1).audio.deviceId, { exact: 'usb-desk' });
  assert.equal((await media()).calls.at(-1).audio.noiseSuppression, false);
  assert.equal(sessionRequests().length, sessionsBeforeListen + 1); assert.deepEqual(sessionRequests().at(-1).body, { mode: 'assisted', commands: false, language: 'en' });
  await until(() => audioRequests().length > 0, 'actual browser worklet WAV reaches the authenticated local station', 15000);
  await until(async () => (await page.locator('.w-transcript').innerText()).includes('No reliable speech sample.'), 'deterministic local worker transcript returns to the UI');
  // Chromium may omit Blob-backed request bodies from its debugging protocol;
  // inspect what the deterministic local worker actually received instead.
  const wav = JSON.parse((await fs.readFile(workerLog, 'utf8')).trim().split('\n').at(-1));
  assert.equal(wav.riff, true); assert.equal(wav.rate, 16000); assert.equal(wav.channels, 1); assert.equal(wav.bits, 16);
  assert.ok(wav.bytes > 3244 && wav.bytes <= 384044);
  assert.ok((await page.evaluate(() => window.__listeningMedia.outputPeaks())).every(peak => peak < 1e-7), 'Listening also never monitors audio to speakers');
  await openSettings(); assert.equal(await input().isDisabled(), true); assert.equal(await processing().isDisabled(), true); assert.equal(await model().isDisabled(), true);
  const busyModel = await request.post(`${base}/api/worship/listening/model`, { data: { modelId: 'base.en' } }); assert.equal(busyModel.status(), 409, await busyModel.text());
  await closeSettings();
  const sessionsAtDisconnect = sessionRequests().length;
  await page.evaluate(() => window.__listeningMedia.remove('usb-desk'));
  await until(async () => (await media()).live.length === 0 && await stop().count() === 0, 'devicechange alone stops the active listener and releases its stream');
  await until(() => calls.some(call => call.method === 'DELETE' && call.path === '/api/worship/channels/scripture/listening'), 'disconnect invalidates the backend listening lease');
  await page.evaluate(() => window.__listeningMedia.add('usb-desk', 'USB Church Sound Desk'));
  await until(() => listen().isEnabled(), 'restored USB input is ready for an explicit rearm'); await settle();
  assert.equal(sessionRequests().length, sessionsAtDisconnect); assert.deepEqual((await media()).live, [], 'Reconnecting does not automatically restart an armed listener');
  checks.push('Selected-device audio flows end to end through the real worklet/WAV/authenticated local session; active configuration is locked, disconnect stops capture/lease, and reconnection requires explicit rearming');

  await page.getByLabel('Search scripture', { exact: true }).fill('jn3 16');
  await page.locator('.w-verse-result').first().click();
  await until(() => page.getByRole('button', { name: 'Send live', exact: true }).isEnabled(), 'a prepared verse makes the Auto publish dialog’s shortcut guard meaningful');
  await page.getByLabel('Listening mode', { exact: true }).selectOption('automatic');
  const beforeCancel = (await media()).calls.length, sessionsBeforeCancel = sessionRequests().length;
  const armDialog = () => page.getByRole('dialog', { name: 'Enable Auto publish?', exact: true });
  let armConfirmations = 0;
  async function openArmConfirmation() {
    await listen().click(); await armDialog().waitFor(); armConfirmations += 1;
    await until(() => armDialog().getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => element === document.activeElement), 'automatic-publication confirmation initially focuses its safe Cancel action');
    await settle();
    assert.deepEqual(nativeDialogs, [], 'Automatic publishing uses the styled app dialog, never a native browser alert');
  }
  async function assertNotArmed(label) {
    await settle();
    assert.equal((await media()).calls.length, beforeCancel, `${label} acquires no microphone`);
    assert.equal(sessionRequests().length, sessionsBeforeCancel, `${label} creates no listening session`);
    assert.equal(calls.filter(call => /\/command$/.test(call.path)).length, 0, `${label} neither publishes the prepared Scripture nor switches Studio`);
  }
  await openArmConfirmation();
  await page.screenshot({ path: path.join(dir, 'listening-auto-confirmation.png'), fullPage: true });
  await armDialog().getByRole('button', { name: 'Enable Auto publish', exact: true }).focus();
  for (const key of ['Control+Enter', 'Meta+Enter']) {
    await page.keyboard.press(key); await assertNotArmed(`${key} on the affirmative confirmation button`);
    assert.equal(await armDialog().isVisible(), true, 'An app publication chord cannot become confirmation-button activation');
  }
  await armDialog().getByRole('button', { name: 'Cancel', exact: true }).focus();
  for (const key of ['Control+Enter', 'Meta+Enter', 'Space']) {
    if (!await armDialog().isVisible()) await openArmConfirmation();
    await page.keyboard.press(key); await assertNotArmed(`${key} inside the confirmation`);
  }
  if (!await armDialog().isVisible()) await openArmConfirmation();
  await armDialog().getByRole('button', { name: 'Cancel', exact: true }).click();
  await armDialog().waitFor({ state: 'hidden' }); await assertNotArmed('Cancel');
  await openArmConfirmation(); await page.keyboard.press('Escape');
  await armDialog().waitFor({ state: 'hidden' }); await assertNotArmed('Escape');
  await openArmConfirmation(); await page.locator('[data-slot="dialog-overlay"]').last().click({ position: { x: 8, y: 8 } });
  await armDialog().waitFor({ state: 'hidden' }); await assertNotArmed('Backdrop dismissal');
  await openArmConfirmation(); await page.setViewportSize({ width: 390, height: 844 });
  await until(() => armDialog().evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1; }), 'automatic-publication confirmation fits a narrow viewport');
  await page.screenshot({ path: path.join(dir, 'listening-auto-confirmation-narrow.png'), fullPage: true });
  await armDialog().getByRole('button', { name: 'Cancel', exact: true }).click();
  await armDialog().waitFor({ state: 'hidden' }); await page.setViewportSize({ width: 1512, height: 982 });
  await assertNotArmed('Narrow-layout Cancel');
  await openArmConfirmation();
  // Simulate a route change while its requester is awaiting confirmation. An
  // actual pointer cannot bypass the modal; this tests scope disposal itself.
  await page.getByRole('button', { name: 'Open Production Studio', exact: true, includeHidden: true }).evaluate(element => element.click());
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  await armDialog().waitFor({ state: 'hidden' }); await assertNotArmed('Leaving the requesting channel');
  await page.getByRole('button', { name: 'Scripture — scripture', exact: true }).click();
  await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Listening mode', { exact: true }).inputValue(), 'automatic', 'Cancelling a request does not rewrite the channel’s selected mode');
  checks.push('The styled Auto publish dialog has safe initial focus, fits desktop/mobile, blocks live shortcuts, and Cancel/Escape/backdrop/navigation acquire no audio or session');

  // Route changes unmount the listening panel, but must not reset its controls
  // while its channel-scoped listener is still armed in the shared store.
  const voiceCommands = () => page.getByRole('checkbox', { name: 'Enable “Lumen next / previous” voice commands', exact: true });
  await voiceCommands().check();
  await openArmConfirmation();
  const confirmationsWhenArmed = armConfirmations;
  const automaticStart = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/worship/channels/scripture/listening');
  await armDialog().getByRole('button', { name: 'Enable Auto publish', exact: true }).click();
  await armDialog().waitFor({ state: 'hidden' }); await stop().waitFor({ timeout: 30000 });
  const automaticResponse = await automaticStart; assert.equal(automaticResponse.status(), 200, await automaticResponse.text());
  const automaticSession = await automaticResponse.json();
  assert.equal(automaticSession.mode, 'automatic'); assert.equal(automaticSession.commands, true);
  assert.equal(sessionRequests().length, sessionsBeforeCancel + 1, 'Only explicit confirmation starts exactly one automatic listening session');
  assert.deepEqual(sessionRequests().at(-1).body, { mode: 'automatic', commands: true, language: 'en' });
  await until(() => audioRequests().some(call => call.session === automaticSession.id), 'the armed automatic session begins receiving WAV windows');
  const capturesWhileArmed = (await media()).calls.length, startsWhileArmed = sessionRequests().length;
  const stopsWhileArmed = calls.filter(call => call.method === 'DELETE' && /\/listening$/.test(call.path)).length;
  const windowsBeforeNavigation = audioRequests().length;
  for (let navigation = 0; navigation < 3; navigation += 1) {
    await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
    await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
    assert.deepEqual((await media()).live, ['usb-desk'], 'Navigating to Studio preserves the active channel input');
    if (navigation === 1) {
      await page.getByRole('button', { name: 'Lyrics — lyrics', exact: true }).click();
      await page.getByRole('heading', { name: 'Find a song', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Listening mode', { exact: true }).inputValue(), 'assisted', 'An armed Scripture channel does not arm Lyrics or overwrite its independent mode');
      assert.equal(await voiceCommands().count(), 0, 'Lyrics does not inherit Scripture voice-command options');
      assert.equal(await stop().count(), 0, 'Lyrics does not display another channel’s live session');
    }
    await page.getByRole('button', { name: 'Scripture — scripture', exact: true }).click();
    await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Listening mode', { exact: true }).inputValue(), 'automatic', 'Returning to Scripture reflects its actual armed mode');
    assert.equal(await page.getByLabel('Listening mode', { exact: true }).isDisabled(), true);
    assert.equal(await voiceCommands().isChecked(), true, 'Returning to Scripture preserves its armed voice commands');
    assert.equal(await voiceCommands().isDisabled(), true);
    await page.getByText('AUTO ARMED', { exact: true }).waitFor(); await stop().waitFor();
  }
  await until(() => audioRequests().length > windowsBeforeNavigation, 'the same live session continues transcribing after Studio and Lyrics navigation');
  assert.ok(audioRequests().slice(windowsBeforeNavigation).every(call => call.session === automaticSession.id), 'Navigation keeps the original listening session ID');
  assert.equal((await media()).calls.length, capturesWhileArmed, 'Navigation never opens a second microphone capture');
  assert.equal(sessionRequests().length, startsWhileArmed, 'Navigation never creates a replacement listener');
  assert.equal(calls.filter(call => call.method === 'DELETE' && /\/listening$/.test(call.path)).length, stopsWhileArmed, 'Navigation never stops the armed session');
  assert.equal(armConfirmations, confirmationsWhenArmed, 'Navigation does not ask to rearm an already-running listener');
  assert.equal(await armDialog().count(), 0);
  await page.screenshot({ path: path.join(dir, 'listening-auto-after-navigation.png'), fullPage: true });

  const automaticStop = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/api/worship/channels/scripture/listening');
  await stop().click(); assert.equal((await automaticStop).status(), 200);
  await until(async () => (await media()).live.length === 0 && await listen().isEnabled(), 'explicit stop releases the preserved automatic session');
  assert.equal(await page.getByLabel('Listening mode', { exact: true }).inputValue(), 'automatic', 'Stopping keeps this channel’s chosen mode without leaving it armed');
  assert.equal(await voiceCommands().isChecked(), true);
  const capturesBeforeRearm = (await media()).calls.length;
  await openArmConfirmation();
  assert.equal(armConfirmations, confirmationsWhenArmed + 1, 'A stopped automatic listener always requires fresh confirmation');
  await armDialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await armDialog().waitFor({ state: 'hidden' });
  assert.equal((await media()).calls.length, capturesBeforeRearm, 'Dismissing rearm confirmation does not reacquire the input');
  assert.equal(sessionRequests().length, startsWhileArmed, 'Dismissing rearm confirmation does not create a listener');
  assert.equal(await page.getByText('AUTO ARMED', { exact: true }).count(), 0);
  checks.push('An armed Scripture Auto publish session, voice commands and status survive repeated Studio/channel navigation with the same session and capture; Lyrics stays independent, and restarting still requires explicit confirmation');

  await page.reload(); await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Listening mode', { exact: true }).inputValue(), 'assisted'); assert.equal((await media()).calls.length, 0);
  await page.getByLabel('Listening mode', { exact: true }).selectOption('automatic');
  assert.equal(await voiceCommands().isChecked(), false, 'Voice-command preferences are not restored across a full browser reload');
  await page.getByLabel('Listening mode', { exact: true }).selectOption('assisted');
  checks.push('Automatic publishing still requires deliberate confirmation and is never rearmed by cancelling, reconnecting or reloading');

  // A real authenticated ownership change must stop the old operator's capture
  // immediately, not wait for its next transcription/heartbeat.
  await listen().click(); await stop().waitFor({ timeout: 30000 });
  const created = await request.post(`${base}/api/users`, { data: { username: 'other-listener', password: 'test-password', displayName: 'Other Scripture operator' } });
  assert.equal(created.status(), 200, await created.text()); const otherUser = (await created.json()).user;
  assert.equal((await request.post(`${base}/api/users/${otherUser.id}/grants`, { data: { channelId: 'scripture', role: 'author' } })).status(), 200);
  const other = await browser.newContext();
  assert.equal((await other.request.post(`${base}/api/auth/login`, { data: { username: 'other-listener', password: 'test-password' } })).status(), 200);
  const otherPage = await other.newPage(); await otherPage.goto(base); await otherPage.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  await otherPage.evaluate(id => new Promise(resolve => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); window.__listeningTakeoverSocket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'takeover', channel: 'scripture' }));
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.t === 'presence' && message.owners.scripture === id) resolve(true); };
  }), otherUser.id);
  await until(async () => (await media()).live.length === 0 && await stop().count() === 0 && await listen().isDisabled(), 'losing ownership stops capture immediately');
  const admin = (await (await request.get(`${base}/api/auth/me`)).json()).user;
  await page.evaluate(id => new Promise(resolve => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); window.__listeningTakeoverSocket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'takeover', channel: 'scripture' }));
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.t === 'presence' && message.owners.scripture === id) resolve(true); };
  }), admin.id);
  await until(() => listen().isEnabled(), 'original operator regains control without automatically rearming');
  await other.close();
  const modelAfterOwnership = await request.post(`${base}/api/worship/listening/model`, { data: { modelId: 'small.en' } });
  assert.equal(modelAfterOwnership.status(), 200, 'Losing ownership still cancels the old operator’s own server lease; no orphan blocks model selection');
  checks.push('A real team-member takeover stops old capture immediately, cannot change Program, and leaves no orphaned server lease');

  await page.screenshot({ path: path.join(dir, 'listening-scripture.png'), fullPage: true });
  await page.getByRole('button', { name: 'Lyrics — lyrics', exact: true }).click(); await page.getByRole('heading', { name: 'Find a song', exact: true }).waitFor();
  await openSettings(); assert.equal(await input().inputValue(), 'usb-desk'); assert.equal(await processing().inputValue(), 'mixer');
  assert.deepEqual((await media()).live, [], 'Lyrics shares the saved input without opening the microphone'); await closeSettings();
  const lyricsCaptures = (await media()).calls.length, lyricsSessions = sessionRequests().length;
  await page.getByLabel('Listening mode', { exact: true }).selectOption('automatic'); await openArmConfirmation();
  await armDialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await armDialog().waitFor({ state: 'hidden' });
  assert.equal((await media()).calls.length, lyricsCaptures); assert.equal(sessionRequests().length, lyricsSessions, 'Lyrics uses the same safe in-app confirmation without acquiring audio on Cancel');
  await page.getByLabel('Listening mode', { exact: true }).selectOption('assisted');
  assert.equal(calls.filter(call => /\/command$/.test(call.path)).length, 0, 'Input configuration, local tests and unmatched assisted listening never publish or switch scenes');
  assert.deepEqual(await production(), initialStudio, 'Input configuration never changes Studio scenes, routing or persistent main audio');
  for (const channel of channels) assert.deepEqual(await workspace(channel.id), initialWorkspaces[channel.id], `${channel.name} live state is unchanged`);
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state, 'offline', 'Input tests never start the production engine or recording');
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeDialogs, [], 'All exercised confirmations stay within Lumen’s accessible styled dialog');
  await page.screenshot({ path: path.join(dir, 'listening-lyrics.png'), fullPage: true });
  console.log(JSON.stringify({ checks, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-7000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
