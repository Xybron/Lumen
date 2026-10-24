// Disposable station + generated tone only. No live station, real captures,
// saved credentials or publishing destinations enter this test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-output-delivery-browser-'));
const tracked = ['data/content.json', 'data/production.json', 'data/broadcast/broadcast-private.json'];
async function hashes() {
  return Object.fromEntries(await Promise.all(tracked.map(async filename => {
    const bytes = await fs.readFile(path.join(root, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    return [filename, bytes ? createHash('sha256').update(bytes).digest('hex') : null];
  })));
}
const before = await hashes(), secrets = new Set(), checks = [];
function safe(value) {
  let message = value instanceof Error ? value.stack ?? value.message : String(value);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/#key=[^\s"'<>]+/g, '#key=[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_.-]{25,}/g, '[redacted JWT]');
}
function remember(url) { const key = new URLSearchParams(new URL(url).hash.slice(1)).get('key'); if (key) secrets.add(key); return url; }
async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); }); }
const port = await freePort(), gatewayPort = await freePort(), base = `http://127.0.0.1:${port}`;
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (/^(?:LUMEN_|VITE_|SUPABASE_|POWERSYNC_)/.test(key)) delete environment[key];
Object.assign(environment, { HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test', LUMEN_DATA_DIR: directory });
await fs.mkdir(path.join(directory, 'media', 'music'), { recursive: true });
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:a', 'pcm_s16le', path.join(directory, 'media', 'music', 'main.wav')]);
let browser, page, request, server, logs = '', stage = 'startup';
const errors = [], requestedUrls = [];
const check = label => { checks.push(label); console.log(`PASS: ${label}`); };
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (cause) { last = cause; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${safe(last.message)})` : ''}`);
}
async function videoReady(target) {
  await until(() => target.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0 && !video.paused && !!video.srcObject?.getVideoTracks().length), 'actual output video decode');
}
async function pixel(target) { return target.locator('video').evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); }); }
async function audioPeak(target) {
  return target.locator('video').evaluate(async video => {
    const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
    const input = context.createMediaStreamSource(video.srcObject), analyser = context.createAnalyser(), silent = context.createGain();
    analyser.fftSize = 2048; silent.gain.value = 0; input.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
    const samples = new Float32Array(2048); let peak = 0;
    for (let index = 0; index < 8; index++) { await new Promise(resolve => setTimeout(resolve, 50)); analyser.getFloatTimeDomainData(samples); for (const sample of samples) peak = Math.max(peak, Math.abs(sample)); }
    input.disconnect(); analyser.disconnect(); silent.disconnect(); await context.close(); return peak;
  });
}
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', bytes => { if (logs.length < 32000) logs += bytes.toString(); });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated backend');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const operator = await browser.newContext({ viewport: { width: 1512, height: 982 } }); request = operator.request;
  await operator.addInitScript(() => {
    window.__displayCalls = 0; window.__displayOpens = [];
    const internal = { label: 'Built-in display', isPrimary: true, isInternal: true, left: 0, top: 0, width: 1512, height: 982, availLeft: 0, availTop: 0, availWidth: 1512, availHeight: 940 };
    const projector = { label: 'Auditorium projector', isPrimary: false, isInternal: false, left: 1920, top: 0, width: 1920, height: 1080, availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080 };
    const details = Object.assign(new EventTarget(), { screens: [internal, projector], currentScreen: internal });
    Object.defineProperty(window, 'getScreenDetails', { configurable: true, value: async () => { window.__displayCalls++; return details; } });
    const nativeOpen = window.open.bind(window);
    window.open = (url, name, features) => { window.__displayOpens.push({ path: new URL(url, location.href).pathname, name, features }); return nativeOpen(url, name, features); };
  });
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = async () => (await request.get(`${base}/api/studio`)).json(), status = async () => (await request.get(`${base}/api/studio/status`)).json();
  const command = async value => { const state = await get(), response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: value } }); assert.equal(response.status(), 200, safe(await response.text())); return response.json(); };
  const state = await get();
  state.sources = [{ id: 'main', name: 'Generated Main tone', kind: 'audio', url: 'media/music/main.wav', loop: true, audio: { volume: .6, muted: true, mode: 'follow', delayMs: 0 } }];
  state.scenes = [{ id: 'red', name: 'Red test scene', background: '#a62c34', layers: [] }, { id: 'blue', name: 'Blue test scene', background: '#214e91', layers: [] }];
  state.previewSceneId = 'red'; state.program = null; state.mainAudioSourceId = null; state.masterVolume = 1; state.masterMuted = false;
  for (const output of state.outputs) { output.mode = 'program'; output.scene = null; output.blanked = false; }
  const saved = await request.put(`${base}/api/studio`, { data: state }); assert.equal(saved.status(), 200, safe(await saved.text()));
  await command({ type: 'set-main-audio', sourceId: 'main' }); await command({ type: 'take', sceneId: 'red' });
  const network = await request.post(`${base}/api/studio/output-delivery/network`, { data: { host: '127.0.0.1', port: gatewayPort } }); assert.equal(network.status(), 200, safe(await network.text()));
  page = await operator.newPage(); page.on('pageerror', cause => errors.push(safe(cause))); await page.goto(`${base}/studio`);
  assert.equal(await page.evaluate(() => window.__displayCalls), 0, 'No display permission query on workspace startup.');
  await page.getByRole('button', { name: 'Start engine', exact: true }).click();
  await until(async () => (await status()).state === 'running' && (await status()).levels.master > .02, 'isolated real renderer and generated Main audio');
  const routing = value => JSON.stringify({ scenes: value.scenes, sources: value.sources, main: value.mainAudioSourceId, masterMuted: value.masterMuted, masterVolume: value.masterVolume, outputs: value.outputs });
  const settingsBefore = routing(await get());
  stage = 'create Program link';
  await page.getByRole('button', { name: 'Program links', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Program output', exact: true });
  await dialog.getByRole('button', { name: 'Create output link', exact: true }).click();
  let capabilityUrl = remember(await dialog.getByLabel('View-only link', { exact: true }).inputValue());
  assert.equal(new URL(capabilityUrl).port, String(gatewayPort));
  await page.screenshot({ path: '/private/tmp/lumen-output-links-desktop.png', fullPage: true, mask: [page.locator('[data-team-private]')] });
  const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } }), viewer = await viewerContext.newPage();
  viewer.on('pageerror', cause => errors.push(safe(cause))); viewer.on('request', req => requestedUrls.push(req.url()));
  await viewer.goto(capabilityUrl); await videoReady(viewer);
  await until(async () => { const color = await pixel(viewer); return color[0] > color[2] * 1.5; }, 'actual red Program picture');
  assert.equal(new URL(viewer.url()).hash, '', 'Capability removed from viewer address.');
  assert.equal(await viewer.locator('video').evaluate(video => video.muted), true);
  assert.equal(await viewer.locator('#controls').evaluate(element => getComputedStyle(element).opacity), '0', 'No output controls until viewer interaction.');
  assert.equal(await viewer.locator('header,footer,[role=toolbar]').count(), 0);
  assert.ok(await audioPeak(viewer) > .02, 'Program gateway carries actual Main audio even while viewer playback starts muted.');
  for (const route of ['/api/studio', '/api/auth/me', '/api/content', '/api/studio/broadcast', '/studio', '/media/music/main.wav']) assert.equal((await viewerContext.request.get(new URL(route, capabilityUrl).href)).status(), 404, `${route} is unavailable through the view-only listener.`);
  assert.ok(requestedUrls.every(url => ![...secrets].some(secret => url.includes(secret))), 'No capability appears in request URLs.');
  await viewer.screenshot({ path: '/private/tmp/lumen-clean-program-output.png' });
  check('UI-created Program link decodes actual picture and Main audio in a separate signed-out context, with muted clean playback and no operator API access');
  stage = 'Program scene switching';
  await command({ type: 'take', sceneId: 'blue', transition: 'fade', durationMs: 300, swapPreview: true });
  await until(async () => { const color = await pixel(viewer); return color[2] > color[0] * 2; }, 'Program link follows the blue scene');
  assert.ok(await audioPeak(viewer) > .02); assert.equal(routing(await get()), settingsBefore);
  check('Program scene switching changes the live picture while Main audio and saved output routing stay unchanged');
  stage = 'revoke link';
  const oldUrl = capabilityUrl;
  await dialog.getByRole('button', { name: 'Revoke link', exact: true }).click();
  await page.getByRole('dialog', { name: 'Revoke this output link?', exact: true }).getByRole('button', { name: 'Revoke link', exact: true }).click();
  await until(() => viewer.locator('video').evaluate(video => video.srcObject === null), 'revocation disconnects active media');
  const rejected = await viewerContext.newPage(); await rejected.goto(oldUrl);
  await rejected.getByRole('status').filter({ hasText: /revoked/ }).waitFor();
  assert.equal(await rejected.locator('video').evaluate(video => video.srcObject === null), true);
  await dialog.getByRole('button', { name: 'Create output link', exact: true }).click();
  capabilityUrl = remember(await dialog.getByLabel('View-only link', { exact: true }).inputValue()); assert.notEqual(capabilityUrl, oldUrl);
  const fresh = await viewerContext.newPage(); await fresh.goto(capabilityUrl); await videoReady(fresh); assert.ok(await audioPeak(fresh) > .02);
  await viewerContext.close();
  check('Revoking disconnects active viewers, rejects the former capability and creates a different working replacement');
  stage = 'connected display fixture';
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Set up Auditorium display', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Auditorium output', exact: true });
  await dialog.getByRole('button', { name: 'Find displays', exact: true }).click();
  const displaySelect = dialog.getByRole('combobox');
  const projectorValue = await displaySelect.locator('option').filter({ hasText: 'Auditorium projector' }).getAttribute('value');
  await displaySelect.selectOption(projectorValue);
  const popupPromise = operator.waitForEvent('page'); await dialog.getByRole('button', { name: 'Open output', exact: true }).click();
  const popup = await popupPromise; await popup.waitForURL(`${base}/studio/output/screen_main?display=1`); await videoReady(popup);
  assert.equal(await popup.evaluate(() => opener === null), true);
  const opened = await page.evaluate(() => window.__displayOpens.at(-1));
  assert.equal(opened.name, 'lumen-output-screen_main'); assert.match(opened.features, /left=1920/); assert.match(opened.features, /width=1920/);
  assert.equal(await page.evaluate(() => window.__displayCalls), 1);
  assert.ok((await page.evaluate(() => localStorage.getItem('lumen.output.displays'))).includes('Auditorium projector'));
  await popup.keyboard.press('f'); await until(() => popup.evaluate(() => !!document.fullscreenElement), 'receiving output window fullscreen shortcut');
  await popup.close();
  assert.equal(routing(await get()), settingsBefore);
  check('Mocked display enumeration selects a projector and passes placement to a real detached popup; real output decode and fullscreen shortcut work (physical screen placement not claimed)');
  stage = 'mobile setup';
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Program links', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Program output', exact: true }); await dialog.waitFor();
  const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391, 'Output dialog fits the mobile viewport.');
  assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Output setup has no horizontal overflow.');
  assert.ok(await dialog.getAttribute('aria-labelledby')); assert.ok(await dialog.getAttribute('aria-describedby'));
  await dialog.getByRole('tab', { name: 'External', exact: true }).click();
  await dialog.getByText('Relay setup required', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Verify relay', exact: true }).count(), 0, 'No real external relay was inherited by the fixture.');
  await dialog.getByRole('tab', { name: 'This computer', exact: true }).click();
  await page.screenshot({ path: '/private/tmp/lumen-output-links-mobile.png', fullPage: true, mask: [page.locator('[data-team-private]')] });
  for (let count = 0; count < 12; count++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true, 'Modal focus remains inside output setup.'); }
  assert.equal(routing(await get()), settingsBefore);
  check('390px output setup fits, has accessible modal labeling/focus containment and clearly reports unconfigured external sharing');
  assert.deepEqual(errors, []); assert.deepEqual(await hashes(), before);
  check('Real station scene, Main audio and saved-key files are byte-for-byte unchanged');
  await request.post(`${base}/api/studio/engine/stop`);
  console.log(JSON.stringify({ result: 'PASS', checks, screenshots: ['/private/tmp/lumen-output-links-desktop.png', '/private/tmp/lumen-clean-program-output.png', '/private/tmp/lumen-output-links-mobile.png'] }, null, 2));
} catch (cause) {
  await page?.screenshot({ path: '/private/tmp/lumen-output-delivery-failure.png', fullPage: true, mask: [page.locator('[data-team-private]')] }).catch(() => {});
  const diagnostics = await request?.get(`${base}/api/studio/diagnostics`).then(response => response.json()).catch(() => null);
  console.error(JSON.stringify({ result: 'FAIL', stage, message: safe(cause), errors, stationFilesUnchanged: JSON.stringify(await hashes()) === JSON.stringify(before), diagnostics, logs: safe(logs) }, null, 2)); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]); }
  // Only this explicit disposable directory is removed, never the station.
  await fs.rm(directory, { recursive: true, force: true });
}
