// Runs the real local launcher and Vite proxy against a disposable station.
// Generated picture/tone only: never loads the operator's station or real keys.
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
import { initialProduction } from '../dist/production-schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-local-watch-browser-'));
const savedKey = 'fixture-youtube-key-loopback-only', facebookKey = 'fixture-facebook-key-loopback-only';
const checks = [], errors = [], viewerRequests = [];
let launcher, browser, combinedFixture, combinedDirectory, logs = '', combinedLogs = '', studioUrl, watchUrl;
const digest = value => createHash('sha256').update(value).digest('hex');
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function ports() { const values = new Set(); while (values.size < 3) values.add(await freePort()); return [...values]; }
async function until(fn, label, milliseconds = 45000) {
  const deadline = Date.now() + milliseconds; let last;
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function ff(args) { return new Promise((resolve, reject) => { const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }), out = [], err = []; child.stdout.on('data', value => out.push(value)); child.stderr.on('data', value => err.push(value)); child.once('error', reject); child.once('exit', code => code === 0 ? resolve({ bytes: Buffer.concat(out), diagnostics: Buffer.concat(err).toString() }) : reject(new Error(Buffer.concat(err).toString()))); }); }
async function json(response, status = 200) { assert.equal(response.status(), status, await response.text()); return response.json(); }
async function seedDeadOwnerLock() {
  // Obtain a real, exited fixture PID rather than guessing an unused system PID.
  // Signal0 only probes liveness; this test never signals an unrelated process.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('The fixture lock owner did not exit cleanly.'))); });
  assert.ok(Number.isInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'The seeded lock owner is positively confirmed dead');
  const filename = path.join(directory, '.lumen-runtime.lock');
  // Match the legacy lock shape left by the reported interrupted shutdown.
  const raw = JSON.stringify({ pid, nonce: 'f'.repeat(48) });
  await fs.writeFile(filename, raw, { mode: 0o600, flag: 'wx' });
  return { pid, filename, raw };
}
async function confirmationFits(page, dialog) {
  const viewport = page.viewportSize();
  await until(async () => { const box = await dialog.boundingBox(); return box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1; }, 'confirmation finishes resizing inside the viewport', 4000);
}
function startLauncher(values) {
  return spawn(process.execPath, ['scripts/dev-watch.mjs', '--backend-port', String(values[0]), '--studio-port', String(values[1]), '--watch-port', String(values[2])], { cwd: root, env: { ...process.env, NODE_ENV: 'development', LUMEN_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function stopLauncher() {
  if (!launcher || launcher.exitCode !== null || launcher.signalCode !== null) return;
  const exited = new Promise(resolve => launcher.once('exit', resolve)); launcher.kill('SIGTERM');
  let timer; await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local launcher did not stop gracefully.')), 18000); })]); clearTimeout(timer);
  assert.equal(launcher.exitCode, 0, logs);
}
async function stopCombinedFixture() {
  const child = combinedFixture;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 12000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}
async function decodedPictureAndAudio(filename, label) {
  const probe = await ff(['-hide_banner', '-i', filename, '-t', '0.1', '-f', 'null', '-']);
  assert.match(probe.diagnostics, /Video: h264[^\n]*1280x720/, `${label}: selected720p H.264 is actually decodable`);
  assert.match(probe.diagnostics, /Audio: aac[^\n]*stereo/, `${label}: the existing Main mix is encoded as AAC stereo`);
  const pixel = (await ff(['-hide_banner', '-loglevel', 'error', '-i', filename, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])).bytes;
  assert.ok(pixel.length >= 3 && pixel[0] > pixel[1] + 80 && pixel[0] > pixel[2] + 80, `${label}: actual red Program pixels, not a placeholder`);
  const samples = (await ff(['-hide_banner', '-loglevel', 'error', '-i', filename, '-t', '0.5', '-vn', '-ac', '2', '-ar', '16000', '-f', 'f32le', '-'])).bytes;
  assert.ok(samples.length > 5000, `${label}: actual audio samples exist`);
  const energy = [0, 0];
  for (let index = 0; index < samples.length; index += 8) { energy[0] += samples.readFloatLE(index) ** 2; energy[1] += samples.readFloatLE(index + 4) ** 2; }
  const rms = energy.map(value => Math.sqrt(value / (samples.length / 8)));
  assert.ok(rms.every(value => value > .02), `${label}: persistent Main audio is audible in both channels (${rms})`);
  return rms;
}
async function combinedLocalFlow(savedProduction) {
  // This phase does NOT use the real launcher for social publishing. Its only
  // backend is an explicitly guarded test fixture whose constructor routes
  // every provider connection to the existing local TLS/RTMP receivers.
  combinedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-browser-local-watch-'));
  await fs.mkdir(path.join(combinedDirectory, 'media', 'music'), { recursive: true });
  await fs.mkdir(path.join(combinedDirectory, 'broadcast'), { mode: 0o700 });
  await fs.copyFile(path.join(directory, 'media', 'music', 'main.wav'), path.join(combinedDirectory, 'media', 'music', 'main.wav'));
  await fs.writeFile(path.join(combinedDirectory, 'production.json'), JSON.stringify(savedProduction));
  await fs.writeFile(path.join(combinedDirectory, 'broadcast', 'broadcast-private.json'), JSON.stringify({ version: 1, profile: '1080p', recordOnStart: true,
    destinations: [{ id: 'youtube', enabled: false, key: savedKey }, { id: 'facebook', enabled: false, key: facebookKey }], watch: { enabled: false } }), { mode: 0o600 });
  const protectedFiles = ['production.json', 'broadcast/broadcast-private.json', 'media/music/main.wav'];
  const hashes = () => Promise.all(protectedFiles.map(async file => digest(await fs.readFile(path.join(combinedDirectory, file)))));
  const before = await hashes(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  let relayOrigin;
  combinedFixture = spawn(process.execPath, ['backend/test/broadcast-fixture.mjs'], { cwd: root,
    env: { ...process.env, PORT: String(port), LUMEN_DATA_DIR: combinedDirectory, LUMEN_BROADCAST_FIXTURE: 'yes', LUMEN_BROADCAST_FIXTURE_LOCAL_WATCH: 'yes' }, stdio: ['ignore', 'pipe', 'pipe'] });
  combinedFixture.stdout.on('data', bytes => { combinedLogs += bytes; for (const line of bytes.toString().split('\n')) { try { const value = JSON.parse(line); if (value.phase === 'broadcast-fixture-ready') relayOrigin = value.relayOrigin; } catch { /* Fixture startup only. */ } } });
  combinedFixture.stderr.on('data', bytes => { combinedLogs += bytes; });
  await until(async () => { if (combinedFixture.exitCode !== null) throw new Error('The safe constructor fixture stopped during startup.'); try { return relayOrigin && (await fetch(`${base}/api/studio/status`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }, 'constructor-only local-mode fixture starts');
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  await context.addInitScript(() => { window.__captureRequests = 0; navigator.mediaDevices.getUserMedia = async () => { window.__captureRequests++; throw new DOMException('No physical inputs in this fixture.', 'NotAllowedError'); }; });
  await json(await context.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  const snapshot = async () => json(await context.request.get(`${base}/api/studio/broadcast`));
  const initial = await snapshot();
  assert.equal(initial.mode, 'local-watch'); assert.equal(initial.config.profile, '1080p'); assert.equal(initial.config.recordOnStart, true);
  assert.ok(initial.config.destinations.every(value => value.configured && !value.enabled)); assert.equal(initial.config.watch.enabled, true); assert.equal(initial.config.watch.configured, true);
  assert.equal(initial.config.watch.publicUrl, `${relayOrigin}/watch/live`);
  assert.ok(!JSON.stringify(initial).includes(savedKey) && !JSON.stringify(initial).includes(facebookKey));
  const cloneFile = path.join(combinedDirectory, 'local-watch-runtime-broadcast', 'broadcast-private.json');
  assert.equal((await fs.stat(cloneFile)).mode & 0o077, 0, 'The fixture uses a private600 clone, not the saved source file');
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const starts = []; page.on('request', value => { if (value.method() === 'POST' && new URL(value.url()).pathname === '/api/studio/broadcast/start') starts.push(value.postDataJSON()); });
  await page.goto(`${base}/studio`); await page.getByRole('button', { name: 'Open Go Live controls', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Go Live', exact: true }); await dialog.getByLabel('Local Lumen Watch', { exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-destination]').count(), 3);
  for (const platform of ['YouTube', 'Facebook']) await dialog.getByLabel(`Enable ${platform} destination`, { exact: true }).check();
  assert.equal(await dialog.getByLabel('Enable Lumen Watch destination', { exact: true }).isChecked(), true);
  await dialog.getByLabel('Stream quality', { exact: true }).selectOption('720p');
  await dialog.getByRole('button', { name: 'Save setup', exact: true }).click(); await dialog.getByText('Setup saved', { exact: true }).waitFor();
  await dialog.getByLabel('Record with stream', { exact: true }).uncheck();
  assert.deepEqual(await hashes(), before, 'Combined setup changes only the private cloned settings');
  await dialog.getByRole('button', { name: 'Review stream', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Ready to go live?', exact: true }).waitFor();
  const confirmation = await dialog.getByRole('region', { name: 'Confirm stream start', exact: true }).textContent();
  for (const name of ['YouTube', 'Facebook', 'Lumen Watch']) assert.ok(confirmation.includes(name));
  assert.equal(starts.length, 0, 'Combined confirmation remains a distinct user action');
  await page.screenshot({ path: path.join(combinedDirectory, 'local-all-three-confirmation.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Go Live', exact: true }).click();
  const active = await until(async () => { const value = await snapshot(); return value.session?.watch.state === 'live' && value.session.destinations.every(destination => destination.state === 'live') && value.session.chunks > 0 && value; }, 'both local TLS platforms and local Watch receive Program simultaneously', 90000);
  assert.ok(active.session.destinations.every(value => value.retries === 0)); assert.equal(starts.length, 1); assert.equal(starts[0].record, false);
  const stats = await until(async () => { const value = await json(await context.request.get(`${base}/__fixture/broadcast`)); return value.receivers.length === 2 && value.receivers.every(receiver => receiver.bytes > 10000) && value; }, 'both constructor-intercepted TLS receivers store actual FLV');
  assert.equal(stats.tlsDials.length, 2); assert.ok(stats.tlsDials.every(value => value.connected && value.authorized && value.certificateVerification));
  assert.equal(stats.spawned.filter(value => value.kind === 'encoder').length, 1, 'All three destinations use one actual encode');
  const energy = {};
  for (const receiver of stats.receivers) energy[receiver.name] = await decodedPictureAndAudio(path.join(combinedDirectory, 'local-rtmps', receiver.filename), receiver.name);
  const viewer = await browser.newContext({ viewport: { width: 1280, height: 800 } }), requests = [];
  const watch = await viewer.newPage(); watch.on('pageerror', error => errors.push(error.message)); watch.on('request', value => requests.push(value.url())); await watch.goto(`${relayOrigin}/watch/live`);
  await until(() => watch.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth === 1280 && !video.paused && video.currentTime > .1), 'combined local Watch independently decodes actual720p Program', 60000);
  const pixel = await watch.locator('video').evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); });
  assert.ok(pixel[0] > pixel[1] + 80 && pixel[0] > pixel[2] + 80);
  const live = await (await fetch(`${relayOrigin}/api/watch/live`)).json(), playlist = new URL(live.playlistUrl, relayOrigin), manifest = await (await fetch(playlist)).text();
  const segment = manifest.split('\n').filter(value => /^segment-.*\.ts$/.test(value)).at(-1); assert.ok(segment);
  const segmentFile = path.join(combinedDirectory, 'actual-combined-main.ts'); await fs.writeFile(segmentFile, Buffer.from(await (await fetch(new URL(segment, playlist))).arrayBuffer()));
  energy.watch = await decodedPictureAndAudio(segmentFile, 'Lumen Watch');
  assert.ok(requests.every(value => value.startsWith(relayOrigin) || value.startsWith('blob:')));
  await page.screenshot({ path: path.join(combinedDirectory, 'local-all-three-live.png'), fullPage: true }); await watch.screenshot({ path: path.join(combinedDirectory, 'local-all-three-watch.png'), fullPage: true });
  assert.deepEqual(await hashes(), before); assert.equal(await page.evaluate(() => window.__captureRequests), 0);
  assert.equal((await json(await context.request.get(`${base}/api/studio/status`))).recording, null);
  await dialog.getByRole('button', { name: 'End stream', exact: true }).click(); await dialog.getByRole('button', { name: 'End stream', exact: true }).click();
  await until(async () => (await snapshot()).session?.state === 'stopped', 'combined stream stops all three destinations');
  assert.equal((await json(await context.request.get(`${base}/api/studio/status`))).state, 'running'); assert.deepEqual(await hashes(), before);
  assert.ok(!combinedLogs.includes(savedKey) && !combinedLogs.includes(facebookKey));
  await viewer.close(); await context.close(); await stopCombinedFixture(); assert.deepEqual(await hashes(), before);
  checks.push('Local-mode normal controls and confirmation publish real720p H.264/AAC Program plus persistent Main audio to both verified loopback TLS/FLV platforms and local HLS at once, using one encode and no physical inputs; stop preserves saved source settings and Studio');
  return energy;
}
try {
  await fs.mkdir(path.join(directory, 'media', 'music'), { recursive: true });
  await fs.mkdir(path.join(directory, 'broadcast'), { recursive: true });
  await ff(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '15', '-c:a', 'pcm_s16le', path.join(directory, 'media', 'music', 'main.wav')]);
  const production = initialProduction();
  production.sources = [{ id: 'main', name: 'Persistent Main tone', kind: 'audio', url: 'media/music/main.wav', loop: true, audio: { volume: .8, muted: false, mode: 'follow', delayMs: 0 } }];
  production.scenes = [{ id: 'red', name: 'Actual red Program', background: '#ff0000', layers: [] }, { id: 'blue', name: 'Blue Preview', background: '#0000ff', layers: [] }];
  production.program = structuredClone(production.scenes[0]); production.previewSceneId = 'blue'; production.mainAudioSourceId = 'main'; production.masterVolume = .8; production.masterMuted = false;
  await fs.writeFile(path.join(directory, 'production.json'), JSON.stringify(production));
  await fs.writeFile(path.join(directory, 'broadcast', 'broadcast-private.json'), JSON.stringify({ version: 1, profile: '1080p', recordOnStart: true, destinations: [{ id: 'youtube', enabled: false, key: savedKey }, { id: 'facebook', enabled: false, key: facebookKey }], watch: { enabled: false } }), { mode: 0o600 });
  const files = ['production.json', 'broadcast/broadcast-private.json'];
  const before = await Promise.all(files.map(async file => digest(await fs.readFile(path.join(directory, file)))));
  const staleLock = await seedDeadOwnerLock();
  const values = await ports(); studioUrl = `http://127.0.0.1:${values[1]}`; watchUrl = `http://127.0.0.1:${values[2]}/watch/live`;
  console.log(JSON.stringify({ phase: 'starting', directory, studioUrl, watchUrl }));
  launcher = startLauncher(values); launcher.stdout.on('data', bytes => { logs += bytes; }); launcher.stderr.on('data', bytes => { logs += bytes; });
  await until(async () => { if (launcher.exitCode !== null) throw new Error(logs); try { return (await fetch(`${studioUrl}/api/studio/status`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }, 'one command starts backend, Studio and Watch');
  const activeLockRaw = await fs.readFile(staleLock.filename, 'utf8'), activeLock = JSON.parse(activeLockRaw);
  assert.notEqual(activeLockRaw, staleLock.raw, 'The normal launcher automatically replaces a positively dead legacy owner without manual lock removal');
  assert.notEqual(activeLock.pid, staleLock.pid); assert.ok(Number.isInteger(activeLock.pid) && activeLock.pid > 1);
  assert.doesNotThrow(() => process.kill(activeLock.pid, 0), 'The replacement lease belongs to a live fixture backend');
  assert.equal((await fs.stat(staleLock.filename)).mode & 0o077, 0, 'The recovered runtime lease remains private');
  assert.deepEqual(await Promise.all(files.map(async file => digest(await fs.readFile(path.join(directory, file))))), before, 'Dead-owner lock recovery preserves saved scenes, Main audio and social settings');
  checks.push('Normal local startup automatically recovers a legacy runtime lock from a positively dead fixture process, acquires a fresh private live-owner lease and preserves saved scene/audio/social bytes');
  const occupied = startLauncher(values); let occupiedLogs = ''; occupied.stdout.on('data', bytes => { occupiedLogs += bytes; }); occupied.stderr.on('data', bytes => { occupiedLogs += bytes; });
  assert.equal(await new Promise(resolve => occupied.once('exit', resolve)), 1); assert.match(occupiedLogs, /already in use/);
  const duplicate = startLauncher(await ports()); let duplicateLogs = ''; duplicate.stdout.on('data', bytes => { duplicateLogs += bytes; }); duplicate.stderr.on('data', bytes => { duplicateLogs += bytes; });
  assert.equal(await new Promise(resolve => duplicate.once('exit', resolve)), 1); assert.match(duplicateLogs, /already|lock|station/i);
  assert.equal(await fs.readFile(staleLock.filename, 'utf8'), activeLockRaw, 'Duplicate launch attempts never replace or remove a live backend lease');
  assert.equal((await fetch(`${studioUrl}/api/studio/status`)).ok, true, 'Refusing another instance never stops the first station');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  await context.addInitScript(() => { window.__captureRequests = 0; navigator.mediaDevices.getUserMedia = async () => { window.__captureRequests++; throw new DOMException('Physical inputs are outside this fixture.', 'NotAllowedError'); }; });
  const request = context.request;
  await json(await request.post(`${studioUrl}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  const snapshot = async () => json(await request.get(`${studioUrl}/api/studio/broadcast`));
  const initial = await snapshot(); assert.equal(initial.mode, 'local-watch'); assert.equal(initial.config.watch.enabled, true); assert.equal(initial.config.watch.configured, true); assert.equal(initial.config.watch.publicUrl, watchUrl); assert.equal(initial.config.recordOnStart, true); assert.equal(initial.config.profile, '1080p');
  assert.ok(initial.config.destinations.every(value => !value.enabled && value.configured), 'Local setup clones saved social keys but preserves their disabled selections'); assert.ok(!JSON.stringify(initial).includes(savedKey)); assert.ok(!JSON.stringify(initial).includes(facebookKey));
  assert.deepEqual(await Promise.all(files.map(async file => digest(await fs.readFile(path.join(directory, file))))), before, 'Startup copies saved streaming setup without rewriting scenes, Main audio or original key bytes');
  const page = await context.newPage(), startRequests = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', value => { if (value.method() === 'POST' && new URL(value.url()).pathname === '/api/studio/broadcast/start') startRequests.push(value.postDataJSON()); });
  await page.goto(`${studioUrl}/studio`); await page.getByRole('button', { name: 'Open Go Live controls', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Go Live', exact: true });
  await dialog.getByLabel('Local Lumen Watch', { exact: true }).waitFor(); assert.equal(await dialog.locator('[data-destination="youtube"], [data-destination="facebook"]').count(), 2); assert.equal(await dialog.locator('[data-destination="watch"]').count(), 1);
  assert.equal(await dialog.getByLabel('Record with stream', { exact: true }).isChecked(), true, 'The saved recording default is retained rather than silently disabled');
  assert.equal(await dialog.getByLabel('Stream quality', { exact: true }).inputValue(), '1080p');
  for (const platform of ['YouTube', 'Facebook']) {
    await dialog.getByRole('button', { name: `Configure ${platform} destination`, exact: true }).click();
    assert.equal(await dialog.getByLabel(`${platform} stream key`, { exact: true }).inputValue(), '', 'Cloned credentials stay write-only and never hydrate a password input');
    await dialog.getByLabel(`Enable ${platform} destination`, { exact: true }).check();
  }
  await dialog.getByLabel('Stream quality', { exact: true }).selectOption('720p');
  await dialog.getByRole('button', { name: 'Save setup', exact: true }).click();
  await dialog.getByText('Setup saved', { exact: true }).waitFor();
  assert.ok((await snapshot()).config.destinations.every(value => value.enabled && value.configured), 'Normal social toggles save to the temporary clone');
  assert.deepEqual(await Promise.all(files.map(async file => digest(await fs.readFile(path.join(directory, file))))), before, 'Normal destination saves do not rewrite the saved source configuration');
  await dialog.getByLabel('Record with stream', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Review stream', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Ready to go live?', exact: true }).waitFor();
  for (const name of ['YouTube', 'Facebook', 'Lumen Watch']) assert.ok((await dialog.getByRole('region', { name: 'Confirm stream start', exact: true }).textContent()).includes(name), `The normal confirmation names ${name}`);
  assert.equal(await dialog.locator('.broadcast-local-notice').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'The local notice wraps inside the narrower confirmation view');
  await page.setViewportSize({ width: 390, height: 844 });
  await confirmationFits(page, dialog);
  assert.equal(await dialog.locator('.broadcast-local-notice').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'The local notice also wraps on a phone-sized confirmation');
  await page.screenshot({ path: path.join(directory, 'local-watch-combined-review-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await confirmationFits(page, dialog);
  assert.equal(startRequests.length, 0, 'Saving and reviewing combined local/social setup never starts an external stream');
  assert.equal((await json(await request.get(`${studioUrl}/api/studio/status`))).state, 'offline');
  await page.screenshot({ path: path.join(directory, 'local-watch-combined-review.png'), fullPage: true });
  // This is the REAL launcher: disable socials before starting anything. The
  // actual three-destination publish is tested below using constructor-only
  // interception, never via an environment bypass in the local launcher.
  await dialog.getByRole('button', { name: 'Back to setup', exact: true }).click();
  for (const platform of ['YouTube', 'Facebook']) await dialog.getByLabel(`Enable ${platform} destination`, { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save setup', exact: true }).click(); await dialog.getByText('Setup saved', { exact: true }).waitFor();
  assert.ok((await snapshot()).config.destinations.every(value => !value.enabled && value.configured), 'Both real-launcher social destinations are definitely disabled before Go Live');
  assert.equal((await snapshot()).config.recordOnStart, true, 'A per-session choice leaves the station recording default intact');
  await dialog.getByLabel('Record with stream', { exact: true }).uncheck();
  await page.screenshot({ path: path.join(directory, 'local-watch-setup.png'), fullPage: true });
  const viewer = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const watch = await viewer.newPage(); watch.on('pageerror', error => errors.push(error.message)); watch.on('request', value => viewerRequests.push(value.url()));
  await watch.goto(watchUrl); await until(() => watch.locator('#status').textContent().then(value => value === 'Offline'), 'Watch is Offline before explicit Go Live');
  await dialog.getByRole('button', { name: 'Review stream', exact: true }).click(); await dialog.getByRole('heading', { name: 'Ready to go live?', exact: true }).waitFor();
  assert.equal(await dialog.getByText('Local recording', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Go Live', exact: true }).click();
  await until(async () => (await snapshot()).session?.watch.state === 'live', 'actual Studio renderer reaches the separate local relay', 60000);
  await until(() => watch.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth === 1280 && !video.paused && video.currentTime > .1), 'real Watch page decodes actual Program', 60000);
  await until(() => watch.locator('#status').textContent().then(value => value === 'Live'), 'decoded Watch displays Live');
  const pixel = await watch.locator('video').evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); }); assert.ok(pixel[0] > pixel[1] + 80 && pixel[0] > pixel[2] + 80, `Watch shows actual red Program: ${pixel}`);
  const watchOrigin = new URL(watchUrl).origin, live = await (await fetch(`${watchOrigin}/api/watch/live`)).json();
  const playlistUrl = new URL(live.playlistUrl, watchOrigin), manifest = await (await fetch(playlistUrl)).text(); const segment = manifest.split('\n').filter(value => /^segment-.*\.ts$/.test(value)).at(-1); assert.ok(segment);
  const segmentFile = path.join(directory, 'actual-main-audio.ts'); await fs.writeFile(segmentFile, Buffer.from(await (await fetch(new URL(segment, playlistUrl))).arrayBuffer()));
  const samples = (await ff(['-hide_banner', '-loglevel', 'error', '-i', segmentFile, '-t', '0.5', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'])).bytes;
  let energy = 0; for (let index = 0; index < samples.length; index += 4) energy += samples.readFloatLE(index) ** 2; energy = Math.sqrt(energy / (samples.length / 4)); assert.ok(energy > .02, `Watch carries persistent Main audio: ${energy}`);
  const status = await json(await request.get(`${studioUrl}/api/studio/status`)); assert.equal(status.recording, null); assert.equal(status.state, 'running'); assert.ok((await snapshot()).session.destinations.every(value => value.state === 'disabled'));
  assert.deepEqual(await Promise.all(files.map(async file => digest(await fs.readFile(path.join(directory, file))))), before, 'Real streaming never rewrites scenes, Main audio or saved social configuration');
  await watch.screenshot({ path: path.join(directory, 'local-watch-real-program.png'), fullPage: true });
  await watch.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await until(() => watch.evaluate(() => !!document.fullscreenElement), 'Watch fullscreen'); await watch.evaluate(() => document.exitFullscreen());
  assert.ok(viewerRequests.every(url => url.startsWith(watchOrigin) || url.startsWith('blob:')), 'Independent Watch loads no station/operator/external endpoints');
  assert.equal(await page.evaluate(() => window.__captureRequests), 0); assert.deepEqual(errors, []); assert.ok(!logs.includes(savedKey)); assert.ok(!logs.includes(facebookKey));
  checks.push('Real launcher starts three loopback services, refuses occupied ports/duplicate ownership, clones saved quality/recording defaults and write-only social keys, and preserves the original source bytes');
  checks.push('Normal all-three destination controls save and review only the private clone; socials are explicitly disabled before the real launcher starts Watch, which decodes actual720p Program/Main audio with fullscreen and no unrequested recording');
  await stopLauncher();
  assert.deepEqual(await Promise.all(files.map(async file => digest(await fs.readFile(path.join(directory, file))))), before, 'Graceful shutdown preserves original station settings');
  assert.equal(await fs.stat(path.join(directory, '.lumen-runtime.lock')).then(() => true, () => false), false, 'Shutdown releases station ownership');
  for (const port of values) { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); await new Promise(resolve => server.close(resolve)); }
  checks.push('Ctrl+C/SIGTERM stops only launcher-owned services, closes the live encoder/relay, frees all ports and releases station ownership');
  const combinedAudio = await combinedLocalFlow(production);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, directory, combinedDirectory, checks, mainAudioRms: energy, combinedAudioRms: combinedAudio, errors }, null, 2));
} catch (error) { await fs.writeFile(path.join(directory, 'launcher.log'), logs.replaceAll(savedKey, '[REDACTED]').replaceAll(facebookKey, '[REDACTED]')); if (combinedDirectory) await fs.writeFile(path.join(combinedDirectory, 'fixture.log'), combinedLogs.replaceAll(savedKey, '[REDACTED]').replaceAll(facebookKey, '[REDACTED]')); console.error(JSON.stringify({ ok: false, directory, combinedDirectory, error: error.stack, logs: logs.replaceAll(savedKey, '[REDACTED]').replaceAll(facebookKey, '[REDACTED]'), combinedLogs: combinedLogs.replaceAll(savedKey, '[REDACTED]').replaceAll(facebookKey, '[REDACTED]'), errors }, null, 2)); process.exitCode = 1; }
finally {
  try { if (browser) await browser.close(); }
  finally { try { await stopLauncher(); } finally { await stopCombinedFixture(); } }
}
