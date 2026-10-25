// Run on the same OS/architecture as an unpacked desktop build. Both app
// launches use newly-created stations; no operator data or physical input opens.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'backend/package.json'));
const { _electron } = require('playwright-core');
const run = promisify(execFile);
const args = process.argv.slice(2);
const defaultApp = process.platform === 'win32'
  ? path.join(root, 'desktop/dist/win-unpacked/Lumen.exe')
  : process.platform === 'darwin'
    ? path.join(root, `desktop/dist/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Lumen.app`)
    : null;
const appArg = args.length === 0 ? defaultApp : args[0] === '--app' && args.length === 2 ? args[1] : args.length === 1 ? args[0] : null;
if (!appArg) throw new Error('Usage: node desktop/scripts/smoke.mjs [--app <packaged executable or .app>]');
let executablePath = path.resolve(appArg);
if (executablePath.endsWith('.app')) executablePath = path.join(executablePath, 'Contents/MacOS/Lumen');
await fs.access(executablePath);
const resources = process.platform === 'darwin'
  ? path.resolve(executablePath, '../../Resources')
  : path.join(path.dirname(executablePath), 'resources');
const manifest = JSON.parse(await fs.readFile(path.join(resources, 'runtime-manifest.json'), 'utf8'));
assert.equal(manifest.platform, process.platform, 'Smoke testing must use a native package');
assert.equal(manifest.arch, process.arch, 'Smoke testing must use the matching architecture');
function resource(relative) {
  assert.equal(typeof relative, 'string');
  const target = path.resolve(resources, relative);
  assert.ok(target.startsWith(resources + path.sep), 'Runtime manifest paths stay within resources');
  return target;
}
const bundledNode = resource(manifest.nodeRelativePath);
const bundledFfmpeg = resource(manifest.ffmpegRelativePath);
await fs.access(resource(manifest.chromiumRelativePath));

// Only system tools remain on PATH. The app must use the runtimes it ships,
// even when the developer/CI host has Node, Chrome or FFmpeg installed.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(LUMEN_|VPS_|MEDIA_ENGINE_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
environment.PATH = process.platform === 'win32'
  ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32;${process.env.SystemRoot || 'C:\\Windows'}`
  : '/usr/bin:/bin:/usr/sbin:/sbin';
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-desktop-checks-'));
const checks = [], errors = [], stations = [];
let application, page, base, log = '';
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
function pass(message) { checks.push(message); console.log(`[desktop smoke] ${message}`); }
async function api(endpoint, data, method = data === undefined ? 'GET' : 'POST') {
  // Fetch inside the app's persistent Electron session, which need not share
  // cookies with Playwright's default BrowserContext APIRequestContext.
  const response = await page.evaluate(async ({ endpoint, data, method }) => {
    const response = await fetch(`/api/${endpoint}`, { method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    return { status: response.status, ok: response.ok, body: await response.text() };
  }, { endpoint, data, method });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${response.body}`);
  return JSON.parse(response.body);
}
async function probeListening() {
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolve(value)); });
  });
  const whisper = resource(manifest.whisperRelativePath);
  const child = spawn(whisper, ['--host', '127.0.0.1', '--port', String(port), '-m', resource(manifest.modelRelativePath), '-t', '2', '--max-context', '0'], { env: environment, cwd: path.dirname(whisper), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', failure;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.on('error', error => { failure = error; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const health = await until(async () => {
      if (failure || child.exitCode !== null) return { error: failure || new Error(`Bundled Whisper exited ${child.exitCode}: ${output.slice(-4000)}`) };
      return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok ? { ready: true } : false;
    }, 'bundled Whisper model warmup', 90000);
    if (health.error) throw health.error;
    pass('Bundled Whisper loads the default model and answers its local health check without a microphone');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    let timeout;
    await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10000); })]);
    clearTimeout(timeout);
    await fs.writeFile(path.join(artifacts, 'listening.log'), output);
  }
}
async function launch(name) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-desktop-smoke-')));
  stations.push(dir);
  application = await _electron.launch({ executablePath, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'], env: { ...environment, LUMEN_DESKTOP_SMOKE_DIR: dir }, timeout: 90000 });
  application.process().stdout?.on('data', chunk => { log += chunk; });
  application.process().stderr?.on('data', chunk => { log += chunk; });
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true, 'Exercise a packaged app, not the development shell');
  page = await application.firstWindow({ timeout: 90000 });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  await page.getByRole('heading', { name: 'Sign in to your station', exact: true }).waitFor({ timeout: 90000 });
  const url = new URL(page.url());
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/studio');
  base = url.origin;
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  assert.deepEqual(await api('worship/songs'), [], 'A new package never ships the developer song library');
  assert.deepEqual((await api('studio')).sources, [], 'A new package never ships the developer capture sources');
  const userData = await application.evaluate(({ app }) => app.getPath('userData'));
  assert.ok(path.resolve(userData).startsWith(dir + path.sep), 'Electron profile belongs to the disposable station');
  await fs.access(path.join(dir, 'station', 'lumen.db'));
  pass(`${name}: packaged app boots and signs in to a fresh isolated station`);
  return dir;
}
async function close() {
  if (!application) return;
  const oldBase = base;
  await application.close();
  application = undefined;
  await until(async () => {
    try { await fetch(`${oldBase}/api/studio`, { signal: AbortSignal.timeout(750) }); return false; }
    catch { return true; }
  }, 'backend exits with desktop app', 15000);
}
async function transferDialog() {
  await page.getByRole('button', { name: /^Account menu for / }).click();
  await page.getByRole('menuitem', { name: 'Data settings', exact: true }).click();
  const dialog = page.getByTestId('transfer-dialog');
  await dialog.waitFor();
  return dialog;
}

try {
  const nativeProbe = `
    const { createRequire } = require('node:module');
    const dependency = createRequire(process.argv[1]);
    const Database = dependency('better-sqlite3');
    const db = new Database(':memory:');
    if (db.prepare('SELECT 42 AS value').get().value !== 42) throw new Error('SQLite failed');
    db.close();
    dependency('sharp')({ create: { width: 4, height: 4, channels: 4, background: '#234567' } }).png().toBuffer()
      .then(buffer => { if (!buffer.length) throw new Error('Sharp failed'); console.log(JSON.stringify({ node: process.version, sqlite: true, sharp: true })); })
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const native = await run(bundledNode, ['-e', nativeProbe, path.join(resources, 'lumen/backend/package.json')], { env: environment, timeout: 30000 });
  const versions = JSON.parse(native.stdout.trim());
  assert.match(versions.node, /^v22\./);
  assert.equal(versions.sqlite, true); assert.equal(versions.sharp, true);
  const ffmpeg = await run(bundledFfmpeg, ['-version'], { env: environment, timeout: 30000 });
  assert.match(ffmpeg.stdout, /ffmpeg version/);
  pass('Bundled Node, SQLite, image processing and FFmpeg work without developer tools on PATH');
  await probeListening();

  const sourceDir = await launch('Source');
  await page.getByRole('button', { name: 'Add source', exact: true }).first().click();
  const source = page.getByRole('dialog', { name: 'Add a source', exact: true });
  await source.waitFor();
  await source.getByRole('button', { name: 'Camera / capture card', exact: true }).click();
  await source.getByLabel('Video device', { exact: true }).waitFor();
  const startPreview = source.getByRole('button', { name: 'Start preview', exact: true });
  if (await startPreview.isVisible()) await startPreview.click();
  const camera = await until(() => source.getByTestId('source-camera-preview').evaluate(video => {
    const tracks = video.srcObject?.getVideoTracks() || [];
    if (video.readyState < 2 || !video.videoWidth || !tracks.length) return false;
    window.__desktopSmokeTracks = video.srcObject.getTracks();
    return { label: tracks[0].label, width: video.videoWidth, height: video.videoHeight };
  }), 'synthetic camera preview');
  assert.match(camera.label, /fake|dummy/i, 'Smoke preview uses the forced synthetic camera');
  await source.getByLabel('Resolution', { exact: true }).waitFor();
  await source.getByLabel('Frame rate', { exact: true }).waitFor();
  await source.getByRole('button', { name: 'Cancel', exact: true }).click();
  await until(() => page.evaluate(() => window.__desktopSmokeTracks.every(track => track.readyState === 'ended')), 'cancelled preview tracks stop');
  pass('Camera source setup previews a synthetic feed, exposes format controls and releases it on cancel');

  const listening = await api('worship/listening/status');
  assert.equal(listening.modelId, 'base.en');
  assert.notEqual(listening.state, 'unavailable', JSON.stringify(listening));
  assert.ok(listening.profiles.some(profile => profile.id === 'base.en' && profile.installed));
  pass('Fresh station discovers the bundled local English listening model');

  const song = await api('worship/songs', { id: 'desktop_smoke_song', title: 'Desktop package fixture', author: 'Synthetic fixture', sections: [{ id: 'verse', label: 'Verse', text: 'Lanterns glow beside the quiet courtyard.' }] });
  const dialog = await transferDialog();
  await dialog.getByTestId('transfer-export-tab').click();
  await dialog.getByTestId('transfer-clear-all').click();
  await dialog.getByTestId('transfer-category-songs').click();
  await dialog.getByTestId(`transfer-item-songs-${song.id}`).setChecked(true);
  const exported = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/data-transfer/export'));
  await dialog.getByTestId('transfer-export').click();
  assert.equal((await exported).status(), 200);
  const downloaded = await until(async () => {
    const files = await fs.readdir(path.join(sourceDir, 'downloads')).catch(() => []);
    const filename = files.find(file => file.endsWith('.lumen'));
    if (!filename) return false;
    const full = path.join(sourceDir, 'downloads', filename);
    return (await fs.stat(full)).size > 0 ? full : false;
  }, 'native .lumen export download');
  const archive = path.join(artifacts, 'desktop-fixture.lumen');
  await fs.copyFile(downloaded, archive);
  await close();
  pass('Native export saves a .lumen archive and closing Lumen stops its backend');

  await launch('Destination');
  const importDialog = await transferDialog();
  await importDialog.getByTestId('transfer-import-tab').click();
  await importDialog.getByTestId('transfer-file').setInputFiles(archive);
  const preview = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/data-transfer/preview'));
  await importDialog.getByTestId('transfer-preview').click();
  assert.equal((await preview).status(), 200);
  await until(() => importDialog.getByTestId('transfer-import').isEnabled(), 'archive preview ready');
  const importing = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/data-transfer/import'));
  await importDialog.getByTestId('transfer-import').click();
  const imported = await importing;
  assert.equal(imported.status(), 200, await imported.text());
  assert.equal((await imported.json()).imported.songs, 1);
  await importDialog.getByTestId('transfer-result').waitFor();
  assert.equal((await api('worship/songs')).find(value => value.id === song.id)?.title, song.title);
  await importDialog.press('Escape');
  pass('A second fresh installation imports the archive through Data settings');

  await page.getByRole('button', { name: 'Start engine', exact: true }).click();
  await until(async () => (await api('studio/status')).state === 'running', 'bundled production Chromium', 90000);
  const state = await api('studio');
  await api('studio/command', { revision: state.revision, command: { type: 'take', sceneId: state.scenes[0].id, transition: 'cut' } });
  const outputReady = application.waitForEvent('window');
  await page.getByRole('button', { name: 'Open Live View', exact: true }).click();
  const output = await outputReady;
  output.on('pageerror', error => errors.push(`Output: ${error.message}`));
  await output.waitForURL(`${base}/studio/output/program`);
  await until(() => output.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'desktop output receives Program');
  await output.close();
  pass('Open Live View creates a desktop output window and receives the live Program feed');
  const recording = await api('studio/recordings', { name: 'Desktop smoke fixture' });
  await until(async () => (await api('studio/status')).recording?.bytes > 0, 'bundled renderer records frames', 45000);
  await api(`studio/recordings/${recording.id}/stop`, {});
  await until(async () => (await api('studio/recordings')).some(value => value.id === recording.id && value.status === 'complete'), 'recording finalization', 60000);
  const media = await page.evaluate(async id => {
    const response = await fetch(`/api/studio/recordings/${id}/download`);
    return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  }, recording.id);
  assert.equal(media.status, 200);
  const mediaPath = path.join(artifacts, 'recording.webm');
  await fs.writeFile(mediaPath, Buffer.from(media.bytes));
  await run(bundledFfmpeg, ['-v', 'error', '-i', mediaPath, '-f', 'null', '-'], { env: environment, timeout: 30000 });
  pass('Bundled Chromium starts the production engine and records playable video');
  await page.screenshot({ path: path.join(artifacts, 'desktop-studio.png') });
  await close();
  assert.deepEqual(errors, [], 'No unhandled application page errors');
  pass('Desktop shutdown closes the live engine and backend');
  console.log(JSON.stringify({ result: 'PASS', checks, versions, artifacts, stations }, null, 2));
} finally {
  if (application) await application.close().catch(() => application.process().kill());
  await fs.writeFile(path.join(artifacts, 'desktop.log'), log);
  console.log(`[desktop smoke] Artifacts: ${artifacts}`);
}
