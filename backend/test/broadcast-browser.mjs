// Full Program -> independent MediaRecorder -> real FFmpeg HLS -> public relay
// browser test. Generated media, temporary identity/data, no physical devices,
// no platform credentials or external streaming endpoints are used.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-browser-'));
const port = Number(process.env.LUMEN_BROADCAST_TEST_PORT ?? 3470), base = `http://127.0.0.1:${port}`;
const videoFile = path.join(directory, 'media', 'backgrounds', 'program-red.mp4'), toneFile = path.join(directory, 'media', 'music', 'main-tone.wav');
const errors = [], mutations = [], publicRequests = [], checks = [], privateKey = 'fixture-youtube-key-loopback-only', facebookKey = 'fixture-facebook-key-loopback-only';
const publicConsole = [];
let server, browser, admin, operator, viewer, anonymous, page, operatorPage, watchPage, relayOrigin, logs = '';
console.log(JSON.stringify({ phase: 'starting', directory, port }));
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
async function until(fn, label, timeout = 45000) { const started = Date.now(); let last; while (Date.now() - started < timeout) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`); }
async function ff(args) { return new Promise((resolve, reject) => { const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }), output = [], diagnostics = []; child.stdout.on('data', value => output.push(value)); child.stderr.on('data', value => diagnostics.push(value)); child.once('error', reject); child.once('close', code => code === 0 ? resolve({ output: Buffer.concat(output), diagnostics: Buffer.concat(diagnostics).toString() }) : reject(new Error(Buffer.concat(diagnostics).toString()))); }); }
async function json(response, expected = 200) { assert.equal(response.status(), expected, await response.text()); return response.json(); }
const production = async () => json(await admin.request.get(`${base}/api/studio`));
const snapshot = async () => json(await admin.request.get(`${base}/api/studio/broadcast`));
const status = async () => json(await admin.request.get(`${base}/api/studio/status`));
const recordingList = async () => json(await admin.request.get(`${base}/api/studio/recordings`));
const fixtureStats = async () => json(await admin.request.get(`${base}/__fixture/broadcast`));
const digest = value => createHash('sha256').update(value).digest('hex');
const dialog = target => target.getByRole('dialog', { name: 'Go Live', exact: true });
async function command(value) { const state = await production(); return json(await admin.request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: value } })); }
async function stopServer() { const child = server; if (!child || child.exitCode !== null || child.signalCode !== null) return; await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 9000).unref(); }); }
async function instrument(target) {
  target.setDefaultTimeout(18000);
  await target.addInitScript(() => {
    window.__broadcastCaptureRequests = 0; window.__broadcastCopied = [];
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__broadcastCaptureRequests++; throw new DOMException('Physical devices are outside this fixture.', 'NotAllowedError'); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__broadcastCopied.push({ text, active: navigator.userActivation.isActive }); } } });
  });
  target.on('pageerror', error => errors.push(error.message)); target.on('dialog', async value => { errors.push(`Unexpected native ${value.type()} dialog`); await value.dismiss(); });
  target.on('request', request => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) mutations.push({ method: request.method(), pathname: new URL(request.url()).pathname }); });
}
async function open(target = page) { await target.getByRole('button', { name: 'Open Go Live controls', exact: true }).click(); await dialog(target).waitFor(); }
async function close(target = page) { await dialog(target).getByRole('button', { name: 'Close Go Live controls', exact: true }).click(); await dialog(target).waitFor({ state: 'hidden' }); }
async function panelBounds(target, label) {
  // A viewport change can land between the dialog's CSS zoom/position frames.
  // Check the settled user-visible layout rather than that intermediate box.
  await until(async () => { const bounds = await dialog(target).boundingBox(), viewport = target.viewportSize(); return bounds && viewport && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1; }, `${label}: Go Live dialog settles inside the viewport`, 4000);
  assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no horizontal page overflow`);
  assert.equal(await dialog(target).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${label}: dialog content never overflows horizontally`);
}
async function unifiedSetup(target, label) {
  assert.equal(await dialog(target).getByRole('tab').count(), 0, `${label}: setup needs no tab navigation`);
  assert.equal(await dialog(target).getByRole('navigation').count(), 0, `${label}: no separate Overview/Setup navigation remains`);
  assert.equal(await dialog(target).getByRole('button', { name: 'Overview', exact: true }).count(), 0);
  assert.equal(await dialog(target).getByRole('button', { name: 'Setup', exact: true }).count(), 0);
  assert.equal(await dialog(target).getByLabel('Stream quality', { exact: true }).isVisible(), true, `${label}: quality is available in the default setup view`);
  assert.equal(await dialog(target).getByLabel('Record with stream', { exact: true }).isVisible(), true, `${label}: the per-session recording choice is available without navigation`);
}
async function navigate(target, url) { await target.evaluate(async path => { await document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path); }, url); await until(() => new URL(target.url()).pathname === url, `Operator route ${url}`); }
async function publicPixel(color) {
  return until(async () => {
    const values = await watchPage.locator('video').evaluate(video => {
      if (video.readyState < 2 || video.paused || video.videoWidth < 100) return null;
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 9; const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 16, 9); return [...context.getImageData(8, 4, 1, 1).data].slice(0, 3);
    });
    if (!values) return false; const index = color === 'red' ? 0 : 2; return values[index] > values[(index + 1) % 3] + 80 && values[index] > values[(index + 2) % 3] + 80 && values;
  }, `Public HLS browser displays the real ${color} Program picture`, 60000);
}
async function verifyHlsAudio() {
  const remote = await (await fetch(`${relayOrigin}/api/watch/live`)).json(), playlist = await (await fetch(new URL(remote.playlistUrl, relayOrigin))).text();
  const segment = playlist.split('\n').filter(value => /^segment-.*\.ts$/.test(value)).at(-1); assert.ok(segment);
  const segmentUrl = new URL(segment, new URL(remote.playlistUrl, relayOrigin)), response = await fetch(segmentUrl); assert.equal(response.status, 200);
  const filename = path.join(directory, 'actual-public-program.ts'); await fs.writeFile(filename, Buffer.from(await response.arrayBuffer()));
  const probe = await ff(['-hide_banner', '-i', filename, '-t', '0.1', '-f', 'null', '-']); assert.match(probe.diagnostics, /Video: h264[^\n]*1280x720/); assert.match(probe.diagnostics, /Audio: aac[^\n]*stereo/);
  const samples = (await ff(['-hide_banner', '-loglevel', 'error', '-i', filename, '-t', '0.5', '-vn', '-ac', '2', '-ar', '16000', '-f', 'f32le', '-'])).output;
  assert.ok(samples.length > 5000); let energy = [0, 0]; for (let index = 0; index < samples.length; index += 8) { energy[0] += samples.readFloatLE(index) ** 2; energy[1] += samples.readFloatLE(index + 4) ** 2; }
  energy = energy.map(value => Math.sqrt(value / (samples.length / 8))); assert.ok(energy[0] > .035 && energy[1] > .015, `Public HLS includes the persistent real Main audio: ${energy}`); return energy;
}
async function verifyPlatform(name, number) {
  const record = await until(async () => (await fixtureStats()).receivers.find(value => value.name === name && value.number === number && value.bytes > 10000), `${name} receives actual FLV over local TLS`);
  const filename = path.join(directory, 'local-rtmps', record.filename);
  const probe = await ff(['-hide_banner', '-i', filename, '-t', '0.15', '-f', 'null', '-']);
  assert.match(probe.diagnostics, /Video: h264[^\n]*1280x720/); assert.match(probe.diagnostics, /Audio: aac[^\n]*stereo/);
  const pixel = (await ff(['-hide_banner', '-loglevel', 'error', '-i', filename, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])).output;
  assert.ok(pixel[0] > pixel[1] + 80 && pixel[0] > pixel[2] + 80, `${name} decodes the real red Program picture: ${[...pixel]}`);
  const samples = (await ff(['-hide_banner', '-loglevel', 'error', '-i', filename, '-t', '0.5', '-vn', '-ac', '2', '-ar', '16000', '-f', 'f32le', '-'])).output;
  assert.ok(samples.length > 5000); let energy = [0, 0];
  for (let index = 0; index < samples.length; index += 8) { energy[0] += samples.readFloatLE(index) ** 2; energy[1] += samples.readFloatLE(index + 4) ** 2; }
  energy = energy.map(value => Math.sqrt(value / (samples.length / 8))); assert.ok(energy[0] > .035 && energy[1] > .015, `${name} carries persistent stereo Main audio: ${energy}`);
  return { name, receivedBytes: record.receivedBytes, bytes: record.bytes, energy };
}
async function processProfile() {
  const stats = await fixtureStats(), diagnostics = await json(await admin.request.get(`${base}/api/studio/diagnostics`));
  const processes = [...stats.spawned.filter(value => value.running && value.kind !== 'probe'), ...stats.receivers.filter(value => !value.closed).map(value => ({ kind: `receiver-${value.name}`, pid: value.pid }))];
  let cpu = 'Unavailable on this host';
  if (process.platform !== 'win32' && processes.length) cpu = await new Promise(resolve => { const child = spawn('ps', ['-p', processes.map(value => value.pid).join(','), '-o', 'pid=,pcpu='], { stdio: ['ignore', 'pipe', 'ignore'] }), chunks = []; const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('CPU sample timed out'); }, 1500); child.stdout.on('data', chunk => chunks.push(chunk)); child.once('error', () => { clearTimeout(timer); resolve('CPU sampling unavailable'); }); child.once('close', code => { clearTimeout(timer); const value = Buffer.concat(chunks).toString().trim(); resolve(code === 0 && value ? value : 'CPU sampling unavailable'); }); });
  const profile = { note: 'Diagnostic process lifetime CPU percentages, not a cross-machine benchmark. Receiver processes exist only in this local test.', capture: diagnostics.renderer?.broadcast?.capture, processes, cpu };
  await fs.writeFile(path.join(directory, 'broadcast-process-profile.json'), JSON.stringify(profile, null, 2));
  assert.deepEqual(profile.capture && { profile: profile.capture.profile, width: profile.capture.width, height: profile.capture.height, frameRate: profile.capture.frameRate, videoBitsPerSecond: profile.capture.videoBitsPerSecond, audioBitsPerSecond: profile.capture.audioBitsPerSecond }, { profile: '720p', width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 3000000, audioBitsPerSecond: 192000 }, '720p streaming input avoids a redundant 1080p/6Mbps software capture');
  assert.equal(stats.spawned.filter(value => value.kind === 'encoder').length, 1, 'YouTube, Facebook and Watch share exactly one actual encoder, excluding capability probes');
  return profile;
}

try {
  await fs.mkdir(path.dirname(videoFile), { recursive: true }); await fs.mkdir(path.dirname(toneFile), { recursive: true });
  await ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30', '-t', '4', '-threads', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile]);
  await ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-af', 'pan=stereo|c0=2*c0|c1=c0', '-c:a', 'pcm_s16le', toneFile]);
  const sourceHashes = [digest(await fs.readFile(videoFile)), digest(await fs.readFile(toneFile))];
  server = spawn(process.execPath, ['backend/test/broadcast-fixture.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), LUMEN_DATA_DIR: directory, LUMEN_BROADCAST_FIXTURE: 'yes' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; for (const line of value.toString().split('\n')) { try { const message = JSON.parse(line); if (message.phase === 'broadcast-fixture-ready') relayOrigin = message.relayOrigin; } catch { /* Ordinary fixture startup diagnostics. */ } } }); server.stderr.on('data', value => { logs += value; });
  await until(async () => relayOrigin && (await fetch(`${base}/api/content`, { signal: AbortSignal.timeout(1500) })).ok, 'disposable station and independent loopback relay start');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb'] });
  admin = await browser.newContext({ viewport: { width: 1512, height: 982 } }); operator = await browser.newContext({ viewport: { width: 1512, height: 982 } }); viewer = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); anonymous = await browser.newContext();
  await json(await admin.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  const created = await json(await admin.request.post(`${base}/api/users`, { data: { username: 'broadcastoperator', displayName: 'Media operator', password: 'fixture-operator-password' } }));
  await json(await admin.request.post(`${base}/api/users/${created.user.id}/grants`, { data: { channelId: '*', role: 'author' } }));
  await json(await operator.request.post(`${base}/api/auth/login`, { data: { username: 'broadcastoperator', password: 'fixture-operator-password' } }));
  const content = { version: 2, updatedAt: new Date().toISOString(), settings: {}, music: { mode: 'off' }, channels: [{ id: 'presentation', name: 'Presentation', kind: 'presentation', playlistId: 'slides', defaultMode: 'manual' }], playlists: [{ id: 'slides', name: 'Presentation', items: [] }] };
  await json(await admin.request.put(`${base}/api/content`, { data: content }));
  const state = await production(), audio = (muted = true) => ({ muted, volume: .75, mode: 'follow', delayMs: 0 });
  state.sources = [{ id: 'program_video', name: 'Program camera fixture', kind: 'video', url: 'media/backgrounds/program-red.mp4', loop: true, audio: audio() }, { id: 'main_tone', name: 'Service Main audio', kind: 'audio', url: 'media/music/main-tone.wav', loop: true, audio: audio() }];
  const layer = { id: 'layer_program', name: 'Program video', kind: 'source', sourceId: 'program_video', visible: true, locked: false, x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'cover', text: '', color: '#ffffff', background: '#00000000', fontSize: 72, fontWeight: 500, align: 'center', radius: 0 };
  state.scenes = [{ id: 'red_program', name: 'Red Program', background: '#ff0000', layers: [layer] }, { id: 'blue_program', name: 'Blue Program', background: '#0000ff', layers: [] }];
  state.previewSceneId = 'red_program'; state.mainAudioSourceId = null; state.masterVolume = .8; state.masterMuted = false;
  await json(await admin.request.put(`${base}/api/studio`, { data: state })); await command({ type: 'set-main-audio', sourceId: 'main_tone' }); await command({ type: 'take', sceneId: 'red_program' });
  const before = await production(); assert.equal((await status()).state, 'offline');
  page = await admin.newPage(); await instrument(page); await page.goto(`${base}/studio`); await page.getByRole('button', { name: 'Open Go Live controls', exact: true }).waitFor(); await open();
  await panelBounds(page, 'Desktop initial setup');
  await unifiedSetup(page, 'Desktop initial setup');
  assert.equal(await dialog(page).getByRole('button', { name: 'Save setup', exact: true }).count(), 0, 'Unchanged setup has no redundant Save action');
  assert.equal(await dialog(page).getByRole('button', { name: 'Refresh stream checks', exact: true }).isVisible(), true);
  assert.equal(await dialog(page).getByLabel('Record new streams by default', { exact: true }).isVisible(), false, 'Station-wide defaults remain tucked into their disclosure');
  assert.equal(await dialog(page).locator('.broadcast-program-monitor video').count(), 0, 'Opening Go Live with an offline engine does not create a monitor or start production');
  assert.equal((await status()).state, 'offline', 'Opening Go Live never starts an offline engine');
  const initialReadiness = (await snapshot()).preflight;
  assert.equal(initialReadiness.ready, false, 'No saved destinations is an explicit readiness blocker');
  for (const check of initialReadiness.checks.filter(value => !value.ok && value.severity !== 'info')) await dialog(page).locator('.broadcast-attention-checks').getByText(check.message, { exact: true }).waitFor();
  assert.equal(await dialog(page).getByRole('button', { name: 'Show readiness details', exact: true }).getAttribute('aria-expanded'), 'false', 'Passing checks begin collapsed while real blockers remain visible');
  await page.setViewportSize({ width: 390, height: 844 }); await panelBounds(page, 'Phone initial readiness');
  await unifiedSetup(page, 'Phone initial setup');
  await page.screenshot({ path: path.join(directory, 'go-live-initial-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  const initialStartWrites = mutations.filter(value => value.pathname.endsWith('/broadcast/start')).length;
  await dialog(page).getByRole('button', { name: 'Review stream', exact: true }).click(); await dialog(page).getByRole('heading', { name: 'Ready to go live?', exact: true }).waitFor();
  assert.equal(await dialog(page).getByRole('button', { name: 'Go Live', exact: true }).isDisabled(), true, 'Readiness blocker prevents the final Go Live action');
  assert.equal(mutations.filter(value => value.pathname.endsWith('/broadcast/start')).length, initialStartWrites, 'Reviewing a blocked setup never starts publishing');
  await page.screenshot({ path: path.join(directory, 'go-live-readiness-blocked.png'), fullPage: true });
  await dialog(page).getByRole('region', { name: 'Confirm stream start', exact: true }).waitFor();
  await dialog(page).getByRole('button', { name: 'Back to setup', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Configure YouTube destination', exact: true }).click();
  await dialog(page).getByLabel('YouTube stream key', { exact: true }).fill(privateKey);
  await dialog(page).getByLabel('Enable YouTube destination', { exact: true }).check();
  await dialog(page).getByRole('button', { name: 'Configure Facebook destination', exact: true }).click();
  await dialog(page).getByLabel('Facebook stream key', { exact: true }).fill(facebookKey);
  await dialog(page).getByLabel('Enable Facebook destination', { exact: true }).check();
  await dialog(page).getByRole('button', { name: 'Configure Lumen Watch destination', exact: true }).click();
  await dialog(page).getByLabel('Enable Lumen Watch destination', { exact: true }).check();
  assert.equal((await snapshot()).config.watch.enabled, false, 'Inline destination controls remain local edits until saved');
  assert.equal(await dialog(page).getByRole('button', { name: 'Review stream', exact: true }).isDisabled(), true, 'Unsaved setup cannot silently become the live destination set');
  await dialog(page).getByLabel('Stream quality', { exact: true }).selectOption('1080p');
  await dialog(page).getByText('Station defaults', { exact: true }).click();
  const recordingDefault = dialog(page).getByLabel('Record new streams by default', { exact: true });
  await recordingDefault.waitFor({ state: 'visible' });
  assert.equal(await recordingDefault.isChecked(), true);
  await recordingDefault.uncheck();
  assert.equal(await dialog(page).getByLabel('Record with stream', { exact: true }).isChecked(), true, 'Changing a station default never silently changes the current session recording choice');
  await new Promise(resolve => setTimeout(resolve, 6500));
  assert.equal(await dialog(page).getByLabel('Stream quality', { exact: true }).inputValue(), '1080p', 'Background status polling preserves the unsaved quality choice');
  assert.equal(await dialog(page).getByLabel('Enable Lumen Watch destination', { exact: true }).isChecked(), true, 'Background polling preserves the unsaved Watch toggle');
  assert.equal(await recordingDefault.isChecked(), false, 'Background polling preserves the unsaved station recording default');
  assert.equal(await dialog(page).getByLabel('Record with stream', { exact: true }).isChecked(), true, 'Per-session recording stays independent of saved-default hydration');
  if (!await dialog(page).getByLabel('YouTube stream key', { exact: true }).isVisible()) await dialog(page).getByRole('button', { name: 'Configure YouTube destination', exact: true }).click();
  assert.equal(await dialog(page).getByLabel('YouTube stream key', { exact: true }).inputValue(), privateKey, 'Background polling preserves the unsaved write-only key');
  assert.equal((await snapshot()).config.profile, '720p', 'Quality remains saved at the original profile until explicit Save setup');
  assert.equal((await snapshot()).config.recordOnStart, true, 'An unsaved default has not changed station settings');
  await recordingDefault.check();
  await dialog(page).getByText('Station defaults', { exact: true }).click();
  assert.equal(await recordingDefault.isVisible(), false);
  await dialog(page).getByLabel('Stream quality', { exact: true }).selectOption('720p');
  await dialog(page).getByRole('button', { name: 'Save setup', exact: true }).click(); await until(async () => { const value = await snapshot(); return value.config.watch.enabled && value.config.destinations.every(destination => destination.configured && destination.enabled); }, 'masked inline destination setup is saved');
  await dialog(page).getByText('Setup saved', { exact: true }).waitFor();
  assert.equal(await dialog(page).getByRole('button', { name: 'Save setup', exact: true }).count(), 0, 'Save setup disappears after the explicit save is acknowledged');
  assert.equal(await dialog(page).getByLabel('YouTube stream key', { exact: true }).inputValue(), ''); assert.ok(!JSON.stringify(await snapshot()).includes(privateKey)); assert.ok(!JSON.stringify(await snapshot()).includes(facebookKey));
  assert.equal((await fixtureStats()).spawned.filter(value => value.kind === 'youtube' || value.kind === 'facebook').length, 0, 'Enabling test destinations does not connect before explicit Go Live');
  await page.screenshot({ path: path.join(directory, 'go-live-unified-desktop.png'), fullPage: true });
  await unifiedSetup(page, 'Desktop saved unified setup');
  const youtubeSetup = dialog(page).getByRole('button', { name: 'Configure YouTube destination', exact: true });
  if (await youtubeSetup.getAttribute('aria-expanded') === 'true') await youtubeSetup.click();
  const readinessDetails = dialog(page).getByRole('button', { name: 'Show readiness details', exact: true });
  await readinessDetails.click(); await dialog(page).getByRole('button', { name: 'Hide readiness details', exact: true }).click();
  await panelBounds(page, 'Desktop saved ready setup');
  await page.screenshot({ path: path.join(directory, 'go-live-ready-desktop.png'), fullPage: true });
  await dialog(page).getByRole('button', { name: 'Copy Lumen Watch link', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__broadcastCopied.at(-1)), { text: `${relayOrigin}/watch/live`, active: true });
  const startWrites = mutations.filter(value => value.pathname.endsWith('/broadcast/start')).length;
  await dialog(page).getByLabel('Record with stream', { exact: true }).uncheck();
  await dialog(page).getByRole('button', { name: 'Review stream', exact: true }).click(); await dialog(page).getByRole('heading', { name: 'Ready to go live?', exact: true }).waitFor();
  assert.equal(await dialog(page).locator('.broadcast-confirmation dl').getByText('Local recording', { exact: true }).count(), 0, 'Unchecked recording omits the irrelevant confirmation summary row');
  assert.equal(await dialog(page).getByLabel('Service recording name', { exact: true }).count(), 0, 'Unchecked recording hides the recording-name field');
  assert.equal((await status()).state, 'offline', 'Setup, sharing and review leave the offline engine untouched');
  await page.screenshot({ path: path.join(directory, 'go-live-review-no-recording.png'), fullPage: true });
  await dialog(page).getByRole('button', { name: 'Back to setup', exact: true }).click(); assert.equal(mutations.filter(value => value.pathname.endsWith('/broadcast/start')).length, startWrites);
  checks.push('One Go Live setup view exposes quality and per-session recording without tabs; station defaults stay optional and independent, unsaved defaults/keys/toggles/quality survive polling, inline changes require explicit Save setup, both platform keys stay write-only, readiness blocks missing destinations, and review/share never starts publishing; all platform traffic is constructor-rewritten to isolated loopback TLS receivers');
  await dialog(page).getByLabel('Record with stream', { exact: true }).check();
  await dialog(page).getByRole('button', { name: 'Review stream', exact: true }).click();
  await dialog(page).locator('.broadcast-confirmation dl').getByText('Local recording', { exact: true }).waitFor();
  await dialog(page).getByLabel('Service recording name', { exact: true }).fill('Broadcast service fixture');
  await page.keyboard.press('Control+Enter'); assert.equal(mutations.filter(value => value.pathname.endsWith('/broadcast/start')).length, startWrites);
  await dialog(page).getByRole('button', { name: 'Go Live', exact: true }).click();
  const active = await until(async () => { const value = await snapshot(); return value.session?.watch.state === 'live' && value.session.destinations.every(destination => destination.state === 'live') && value.session.chunks > 0 && value; }, 'managed Program reaches both actual local RTMPS receivers and the independent Watch relay', 90000);
  assert.ok(active.session.destinations.every(destination => destination.retries === 0), 'Neither real TLS destination repeatedly reconnects');
  const tlsStats = await fixtureStats(); assert.equal(tlsStats.tlsDials.length, 2); assert.ok(tlsStats.tlsDials.every(value => value.connected && value.authorized && value.certificateVerification && !value.errorCode), 'Both platform egress connections retain real CA/hostname verification');
  assert.equal(active.production.recording.name, 'Broadcast service fixture'); const recordingId = active.production.recording.id;
  assert.deepEqual(await production(), before, 'Starting a broadcast/recording never changes Program, scene layers or Main audio');
  await until(async () => await dialog(page).locator('[data-destination="watch"]').getAttribute('data-state') === 'live', 'operator status reflects actual HLS readiness');
  assert.equal(await dialog(page).getByRole('button', { name: 'Preview Program', exact: true }).count(), 0, 'Automatic Program preview needs no extra toggle or click');
  await until(async () => await dialog(page).locator('.broadcast-program-monitor video').evaluate(video => video.readyState >= 2 && video.muted && video.videoWidth > 100), 'actual Program monitor connects automatically and muted');
  assert.deepEqual(await dialog(page).locator('.broadcast-program-monitor video').evaluate(video => [video.videoWidth, video.videoHeight]), [640, 360], 'The muted operator monitor is lightweight and does not decode the full Program output');
  await page.screenshot({ path: path.join(directory, 'broadcast-live-program-preview.png'), fullPage: true });
  await close(); assert.equal(await page.locator('.broadcast-program-monitor video').count(), 0, 'Closing the panel releases its monitor peer');
  await navigate(page, '/'); await page.getByRole('button', { name: 'Open Go Live controls', exact: true }).waitFor(); await open();
  await until(async () => await dialog(page).locator('.broadcast-program-monitor video').evaluate(video => video.readyState >= 2 && video.muted && video.videoWidth > 100), 'Reopening Go Live automatically reconnects the muted Program preview');
  watchPage = await viewer.newPage(); watchPage.on('pageerror', error => errors.push(error.message)); watchPage.on('request', request => publicRequests.push(request.url())); watchPage.on('console', message => { if (['error', 'warning'].includes(message.type())) publicConsole.push(message.text()); }); await watchPage.bringToFront(); await watchPage.goto(`${relayOrigin}/watch/live`);
  await publicPixel('red');
  const platforms = await Promise.all(['youtube', 'facebook'].map(name => verifyPlatform(name, 1)));
  const profile = await processProfile();
  assert.equal(await watchPage.locator('video').evaluate(video => !window.Hls?.isSupported() || video.currentSrc.startsWith('blob:')), true, 'A capable MSE player is preferred over Chromium’s unreliable native HLS maybe claim');
  const energy = await verifyHlsAudio(); await watchPage.screenshot({ path: path.join(directory, 'broadcast-independent-public-live.png'), fullPage: true });
  assert.equal((await viewer.request.get(`${relayOrigin}/api/studio`)).status(), 404); assert.equal((await anonymous.request.get(`${base}/api/studio/broadcast`)).status(), 401);
  checks.push(`Both real loopback RTMPS/FLV destinations plus HLS decode 720p H.264/AAC and stereo Main audio (${energy.map(value => value.toFixed(3)).join('/')}) with zero retries, one shared encode and an actual 720p/3Mbps input; automatic muted monitor releases/reconnects`);
  await command({ type: 'take', sceneId: 'blue_program' }); await publicPixel('blue'); const switched = await production(); assert.equal(switched.mainAudioSourceId, before.mainAudioSourceId); assert.deepEqual(switched.sources, before.sources); await verifyHlsAudio();
  await dialog(page).getByRole('button', { name: 'Stop Lumen Watch destination', exact: true }).click();
  await until(async () => (await snapshot()).session.watch.state === 'stopped', 'destination-only stop is honest'); assert.equal((await status()).recording.id, recordingId);
  await dialog(page).getByRole('button', { name: 'Retry Lumen Watch destination', exact: true }).click(); await until(async () => (await snapshot()).session.watch.state === 'live', 'retry reconnects the real HLS relay', 60000);
  assert.equal((await status()).recording.id, recordingId); assert.deepEqual((await production()).sources, before.sources);
  const ongoing = await snapshot(); assert.ok(ongoing.session.destinations.every(destination => destination.state === 'live' && destination.retries === 0), 'Watch Stop/Retry never disrupts either active platform');
  const fanout = await fixtureStats(); assert.equal(fanout.spawned.filter(value => value.kind === 'encoder').length, 1); assert.equal(fanout.spawned.filter(value => value.kind === 'youtube').length, 1); assert.equal(fanout.spawned.filter(value => value.kind === 'facebook').length, 1);
  checks.push('Manual Studio scene switching reaches the public HLS picture while Main audio persists; stopping/retrying one destination leaves the independent recording and production sources running');
  operatorPage = await operator.newPage(); await instrument(operatorPage); await operatorPage.goto(`${base}/studio`); await open(operatorPage);
  assert.equal(await dialog(operatorPage).getByRole('navigation').count(), 0);
  assert.equal(await dialog(operatorPage).getByLabel('Stream quality', { exact: true }).isVisible(), true); assert.equal(await dialog(operatorPage).getByLabel('Stream quality', { exact: true }).isDisabled(), true); assert.equal((await operator.request.put(`${base}/api/studio/broadcast/config`, { data: { profile: '1080p' } })).status(), 403);
  await dialog(operatorPage).getByRole('button', { name: 'End stream', exact: true }).click();
  await dialog(operatorPage).getByRole('region', { name: 'Confirm stream end', exact: true }).waitFor();
  assert.equal(await dialog(operatorPage).getByRole('radio', { name: 'Keep recording when ending stream', exact: true }).isChecked(), true);
  await dialog(operatorPage).getByRole('button', { name: 'End stream', exact: true }).click(); await until(async () => (await snapshot()).session.state === 'stopped', 'operator ends the broadcast with default keep-recording');
  assert.equal((await status()).recording.id, recordingId); assert.equal((await status()).state, 'running'); await until(async () => (await (await fetch(`${relayOrigin}/api/watch/live`)).json()).status === 'offline', 'independent public relay visibly goes Offline');
  assert.deepEqual(await production(), switched);
  checks.push('Non-admin Studio operators can end a session but cannot change credentials; Keep recording is the default and leaves the same recording and engine running');
  await unifiedSetup(operatorPage, 'Operator setup after ending the stream');
  await dialog(operatorPage).getByLabel('Record with stream', { exact: true }).uncheck();
  await dialog(operatorPage).getByRole('button', { name: 'Review stream', exact: true }).click();
  await dialog(operatorPage).getByRole('heading', { name: 'Ready to go live?', exact: true }).waitFor();
  assert.equal(await dialog(operatorPage).locator('.broadcast-confirmation dl').getByText('Local recording', { exact: true }).count(), 0);
  assert.equal(await dialog(operatorPage).getByLabel('Service recording name', { exact: true }).count(), 0);
  assert.equal(await dialog(operatorPage).locator('.broadcast-program-monitor video').count(), 0, 'Entering confirmation releases the automatic monitor');
  await dialog(operatorPage).getByRole('button', { name: 'Go Live', exact: true }).click();
  await until(async () => (await snapshot()).session.watch.state === 'live', 'second session reuses the already-running local recording', 60000); assert.equal((await status()).recording.id, recordingId);
  await dialog(operatorPage).getByRole('button', { name: 'End stream', exact: true }).click(); await dialog(operatorPage).getByRole('radio', { name: 'Stop recording when ending stream', exact: true }).check(); await dialog(operatorPage).getByRole('button', { name: 'End stream', exact: true }).click();
  await until(async () => (await snapshot()).session.state === 'stopped' && !(await status()).recording, 'explicit stop-both ends the recording without stopping Studio');
  const recording = await until(async () => (await recordingList()).find(value => value.id === recordingId && value.status === 'complete'), 'independent local recording finalizes', 60000);
  assert.ok(recording.bytes > 10000); const file = await admin.request.get(`${base}/api/studio/recordings/${recordingId}/download`); assert.equal(file.status(), 200); const savedRecording = path.join(directory, 'actual-independent-recording.webm'); await fs.writeFile(savedRecording, await file.body());
  const recorded = await ff(['-hide_banner', '-i', savedRecording, '-t', '0.1', '-f', 'null', '-']); assert.match(recorded.diagnostics, /Video:[^\n]*1920x1080/); assert.match(recorded.diagnostics, /Audio:/);
  const finalFanout = await fixtureStats(); assert.equal(finalFanout.spawned.filter(value => value.kind === 'encoder').length, 2, 'Each of two broadcast sessions has one actual encoder'); assert.equal(finalFanout.spawned.filter(value => value.kind === 'youtube').length, 2); assert.equal(finalFanout.spawned.filter(value => value.kind === 'facebook').length, 2);
  assert.deepEqual(await production(), switched); assert.equal((await status()).state, 'running'); assert.deepEqual([digest(await fs.readFile(videoFile)), digest(await fs.readFile(toneFile))], sourceHashes);
  checks.push('Recording-off confirmation hides its row/name and preserves an existing recording on restart; explicit Stop both produces a real seekable video/audio recording while Studio, scene state, original media and Main audio remain intact');
  for (const [width, height] of [[1024, 768], [390, 844]]) {
    await operatorPage.setViewportSize({ width, height }); await panelBounds(operatorPage, `${width}px unified setup`); await unifiedSetup(operatorPage, `${width}px unified setup`);
    await operatorPage.screenshot({ path: path.join(directory, `go-live-unified-${width}.png`), fullPage: true });
    await dialog(operatorPage).getByText('Station defaults', { exact: true }).click();
    assert.equal(await dialog(operatorPage).getByLabel('Record new streams by default', { exact: true }).isVisible(), true);
    assert.equal(await dialog(operatorPage).getByLabel('Record new streams by default', { exact: true }).isDisabled(), true, 'Operators can inspect but cannot alter station defaults');
    await panelBounds(operatorPage, `${width}px optional station defaults`);
    await operatorPage.screenshot({ path: path.join(directory, `go-live-defaults-${width}.png`), fullPage: true });
    await dialog(operatorPage).getByText('Station defaults', { exact: true }).click();
  }
  assert.ok(publicRequests.every(url => url.startsWith(relayOrigin) || url.startsWith('blob:')), 'Public playback never depends on the station origin or an external CDN'); assert.deepEqual(errors, []);
  for (const target of [page, operatorPage]) assert.equal(await target.evaluate(() => window.__broadcastCaptureRequests), 0);
  console.log(JSON.stringify({ ok: true, directory, relayOrigin, checks, platforms, encoder: profile.processes.filter(value => value.kind === 'encoder'), recording: { id: recording.id, bytes: recording.bytes, durationMs: recording.durationMs }, errors, publicRequests: publicRequests.length }, null, 2));
} catch (error) {
  for (const [target, name] of [[page, 'broadcast-failure.png'], [operatorPage, 'broadcast-operator-failure.png'], [watchPage, 'broadcast-watch-failure.png']]) if (target && !target.isClosed()) await target.screenshot({ path: path.join(directory, name), fullPage: true }).catch(() => {});
  const publicVideo = watchPage && !watchPage.isClosed() ? await watchPage.locator('video').evaluate(video => ({ paused: video.paused, time: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight, ready: video.readyState, network: video.networkState, src: video.currentSrc, visibility: document.visibilityState, native: video.canPlayType('application/vnd.apple.mpegurl'), hls: window.Hls?.isSupported(), error: video.error?.message, buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]) })).catch(() => null) : null;
  await fs.writeFile(path.join(directory, 'server.log'), logs); const transport = admin ? await fixtureStats().catch(() => null) : null, broadcast = admin ? await snapshot().catch(() => null) : null; await fs.writeFile(path.join(directory, 'transport-failure.json'), JSON.stringify({ broadcast, transport }, null, 2)); console.error(JSON.stringify({ ok: false, directory, error: error.stack, errors, mutations, publicConsole, publicVideo, publicRequests: publicRequests.slice(-15), checks, broadcast, transport, logs: logs.replaceAll(privateKey, '[REDACTED]').replaceAll(facebookKey, '[REDACTED]').slice(-12000) }, null, 2)); process.exitCode = 1;
} finally { if (browser) await browser.close().catch(() => {}); await stopServer(); }
