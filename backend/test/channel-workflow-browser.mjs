// Real rendered video on an isolated station; never reads the operator's deck
// or requests physical devices. Channel publication and scene control are
// deliberately separate even when an older controller calls a retired route.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-channel-workflow-'));
const port = Number(process.env.LUMEN_CHANNEL_WORKFLOW_TEST_PORT ?? 3423), base = `http://127.0.0.1:${port}`;
const proxyPort = port + 1, rendererOrigin = `http://127.0.0.1:${proxyPort}`;
const proxySockets = new Set();
// Delay selected already-published cues only inside the test renderer, so Studio
// Take arrives first. No debug/delay hook is added to the real application.
const delayScript = `<script>{const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(...args){super(...args);if(new URL(String(args[0]),location.href).pathname==='/ws')this.addEventListener('message',event=>{if(!event.isTrusted)return;let m;try{m=JSON.parse(event.data)}catch{return}if(m.t==='state'&&m.channel==='scripture'&&[2,7].includes(m.payload?.channelRevision)){event.stopImmediatePropagation();setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:event.data})),2500)}})}}}</script>`;
const proxy = http.createServer((req, res) => {
  const upstream = http.request(`${base}${req.url}`, { method: req.method, headers: req.headers }, response => {
    if (req.url === '/studio/engine') {
      const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => {
        const headers = { ...response.headers }; delete headers['content-length']; delete headers.etag;
        res.writeHead(response.statusCode ?? 502, headers); res.end(Buffer.concat(chunks).toString().replace('<head>', `<head>${delayScript}`));
      });
    } else { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); }
  }); upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
});
proxy.on('connection', socket => { proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); });
proxy.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(port, '127.0.0.1', () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((lines, value, i) => i % 2 ? lines : [...lines, `${value}: ${req.rawHeaders[i + 1]}`], []).join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  }); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
});
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let server, browser, page, logs = '';
const errors = [], checks = [];
async function until(fn, label, timeout = 25000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const layer = (id, patch = {}) => ({ id, name: id, kind: 'shape', visible: true, locked: false, x: 0, y: 0, width: 100, height: 100,
  opacity: 1, fit: 'cover', text: '', color: '#ffffff', background: '#00000000', fontSize: 54, fontWeight: 500, align: 'left', radius: 0, ...patch });
const selection = verse => ({ kind: 'scripture', versionId: 'KJV', book: 43, chapter: 3, verse });
const sample = async video => video.evaluate(element => {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d'); ctx.drawImage(element, 0, 0, 640, 360);
  const data = ctx.getImageData(0, 0, 640, 360).data;
  const pixel = (x, y) => [...data.slice((Math.floor(y * 360) * 640 + Math.floor(x * 640)) * 4, (Math.floor(y * 360) * 640 + Math.floor(x * 640)) * 4 + 3)];
  let cyan = 0, digest = 0;
  for (let y = 210; y < 350; y++) for (let x = 20; x < 620; x++) {
    const i = (y * 640 + x) * 4;
    if (data[i + 2] > 130 && data[i + 2] > data[i] * 1.15 && data[i + 1] > data[i] * 1.1) { cyan++; digest += x * 13 + y * 7; }
  }
  return { camera: pixel(.2, .2), logo: pixel(.9, .08), corner: pixel(.02, .02), panel: pixel(.1, .7), cyan, digest };
});
const green = p => p.camera[1] > p.camera[0] * 2 && p.camera[1] > p.camera[2] * 1.2;
const logo = p => p.logo[0] > 190 && p.logo[1] < 75 && p.logo[2] < 75;
const blue = p => p.corner[2] > 190 && p.corner[0] < 50;

try {
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, '127.0.0.1', resolve); });
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: rendererOrigin }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'station ready');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, permissions: ['camera'] });
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const fixture = { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: ['scripture', 'lyrics'].map(kind => ({ id: kind, name: kind === 'scripture' ? 'Scripture' : 'Lyrics', kind, playlistId: `p_${kind}`, defaultMode: 'manual' })),
    playlists: ['scripture', 'lyrics'].map(kind => ({ id: `p_${kind}`, name: kind, items: [] })) };
  const seeded = await request.put(`${base}/api/content`, { data: fixture }); assert.equal(seeded.status(), 200, await seeded.text());
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const worship = async id => (await request.get(`${base}/api/worship/channels/${id}`)).json();
  const save = async mutate => { const state = await get(); mutate(state); const r = await request.put(`${base}/api/studio`, { data: state }); assert.equal(r.status(), 200, await r.text()); return r.json(); };
  const command = async command => { const state = await get(); const r = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } }); assert.equal(r.status(), 200, await r.text()); return r.json(); };
  const publish = async (id, command) => { const state = await worship(id); const r = await request.post(`${base}/api/worship/channels/${id}/command`, { data: { revision: state.revision, command } }); assert.equal(r.status(), 200, await r.text()); return r.json(); };
  const offline = await get();
  await publish('scripture', { type: 'take', selection: selection(16) });
  assert.deepEqual(await get(), offline, 'Publishing without an engine must not write production');
  const beforeRetired = await worship('scripture');
  for (const route of ['channel-program', 'channel-program/return']) {
    const response = await request.post(`${base}/api/studio/${route}`, { data: { revision: offline.revision, channelId: 'scripture', mode: 'fullscreen', worship: { revision: beforeRetired.revision, selection: selection(17) } } });
    assert.equal(response.status(), 410); assert.match((await response.json()).error, /Studio scene/);
  }
  assert.deepEqual(await get(), offline); assert.deepEqual(await worship('scripture'), beforeRetired);
  checks.push('Send live works offline; retired takeover routes cannot publish content or change Program');

  const camera = layer('camera_layer', { kind: 'source', sourceId: 'camera' });
  const branding = layer('logo', { x: 85, y: 4, width: 10, height: 8, background: '#ee2222' });
  // Intentionally legacy slide mode: dedicated text channels must now ignore
  // channel theme and honor their Studio design, without rewriting snapshots.
  const text = layer('scripture_text', { kind: 'source', sourceId: 'scripture_feed', x: 7, y: 66, width: 86, height: 28,
    channelStyle: 'slide', background: '#11151bd9', color: '#80cfff', fontSize: 48 });
  await save(state => {
    state.sources = [
      { id: 'camera', name: 'Generated camera', kind: 'camera', loop: false, audio: { volume: .6, muted: true, mode: 'follow', delayMs: 0 } },
      { id: 'scripture_feed', name: 'Scripture feed', kind: 'channel', channelId: 'scripture', loop: false, audio: { volume: 0, muted: true, mode: 'follow', delayMs: 0 } },
    ];
    state.scenes = [
      { id: 'camera_only', name: 'Camera and branding', background: '#000000', layers: [camera, branding] },
      { id: 'camera_scripture', name: 'Camera with scripture', background: '#000000', layers: [camera, text, branding] },
      { id: 'independent', name: 'Independent screen', background: '#0000ff', layers: [] },
    ]; state.previewSceneId = 'camera_scripture';
  });
  await command({ type: 'take', sceneId: 'camera_only' });
  await command({ type: 'route', outputId: 'screen_main', sceneId: 'independent' });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#135e3b'; ctx.fillRect(0, 0, 1280, 720);
      const timer = setInterval(() => { ctx.fillStyle = '#135e3b'; ctx.fillRect(0, 0, 1280, 720); }, 33);
      const stream = canvas.captureStream(30); window.__generatedInput = { canvas, timer, stream }; return stream;
    };
  });
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Collapse toolbar', exact: true }).click();
  await page.locator('.source-row').filter({ hasText: 'Generated camera' }).getByRole('button', { name: 'Connect', exact: true }).click();
  const start = await request.post(`${base}/api/studio/engine/start`, { timeout: 50000 }); assert.equal(start.status(), 200, await start.text());
  assert.equal((await (await request.get(`${base}/api/studio/diagnostics`)).json()).startup.origin, rendererOrigin, 'Delay proxy actually hosts this renderer');
  const monitor = await context.newPage(); monitor.on('pageerror', e => errors.push(e.message)); await monitor.goto(`${base}/studio/output/program`);
  const video = monitor.locator('video');
  await until(async () => await video.evaluate(v => v.readyState >= 2) && green(await sample(video)) && logo(await sample(video)), 'camera and logo output');
  const pinned = await context.newPage(); await pinned.goto(`${base}/studio/output/screen_main`);
  await until(async () => await pinned.locator('video').evaluate(v => v.readyState >= 2) && blue(await sample(pinned.locator('video'))), 'independent output');
  const beforePublish = await get();
  await publish('scripture', { type: 'take', selection: selection(17) });
  assert.deepEqual(await get(), beforePublish);
  await until(async () => { const p = await sample(video); return green(p) && logo(p) && p.cyan < 5; }, 'absent channel does not acquire Program');
  checks.push('Publishing an absent channel leaves the current camera scene and pinned screen untouched');

  const taken = await command({ type: 'take', sceneId: 'camera_scripture', transition: 'fade', durationMs: 600 });
  assert.deepEqual(taken.programCueGates, [{ channelId: 'scripture', revision: 2 }]);
  const waiting = [];
  for (let i = 0; i < 8; i++) {
    await video.evaluate(v => new Promise(resolve => v.requestVideoFrameCallback(resolve)));
    waiting.push(await sample(video));
  }
  assert.ok(waiting.every(p => green(p) && logo(p) && p.cyan < 5 && p.panel[1] > 80), 'Pending scene holds prior picture, never the old verse');
  const fading = []; const fadeDeadline = Date.now() + 7000;
  while (Date.now() < fadeDeadline) {
    await video.evaluate(v => new Promise(resolve => v.requestVideoFrameCallback(resolve)));
    const p = await sample(video); fading.push(p);
    if (p.cyan > 40 && p.panel[1] < 40) break;
  }
  assert.ok(fading.some(p => p.panel[1] > 45 && p.panel[1] < 80), 'Requested Fade begins after readiness, not exhausted during socket delay');
  checks.push('A delayed renderer cue cannot flash stale text or consume the requested Fade while waiting');
  await until(async () => { const p = await sample(video); return green(p) && logo(p) && p.cyan > 40; }, 'Studio-designed legacy text layer on real output');
  const onAir = await get(), firstPixels = await sample(video);
  await publish('scripture', { type: 'theme', theme: { background: '#ff00ff', color: '#00ff00', size: '2xl', align: 'right' } });
  await publish('scripture', { type: 'take', selection: selection(18) });
  assert.deepEqual(await get(), onAir, 'On-air content updates cannot change geometry, transition/run IDs, audio or outputs');
  await until(async () => { const p = await sample(video); return green(p) && logo(p) && p.cyan > 40 && p.digest !== firstPixels.digest; }, 'new text honors Studio cyan typography not legacy green theme');
  assert.ok(blue(await sample(pinned.locator('video'))));
  await monitor.screenshot({ path: path.join(dir, 'scripture-on-program.png') });
  await publish('scripture', { type: 'blank', value: true });
  assert.deepEqual(await get(), onAir);
  await until(async () => { const p = await sample(video); return green(p) && logo(p) && p.cyan < 5; }, 'cleared channel reveals camera including its filled text layer');
  checks.push('Live text uses Studio typography and updates in place; clear removes its fill without blanking camera, logo or pinned output');

  // A never-displayed, gated CUT cannot become the outgoing scene of a later
  // Fade. Restore a visible old verse first: testing against blank revision5
  // would miss a stale-text flash because its old channel layer draws nothing.
  const restored = await publish('scripture', { type: 'take', selection: selection(19) });
  assert.equal(restored.revision, 6, 'Fixture revision6 restores the old visible text');
  await until(async () => { const p = await sample(video); return green(p) && logo(p) && p.cyan > 40; }, 'restored old cue reaches renderer');
  await command({ type: 'take', sceneId: 'camera_only', transition: 'cut' });
  await until(async () => { const p = await sample(video); return green(p) && logo(p) && p.cyan < 5; }, 'Camera is actually on Program before pending Cut');
  const delayed = await publish('scripture', { type: 'take', selection: selection(20) });
  const delayedAt = Date.now();
  assert.equal(delayed.revision, 7, 'Proxy delays revision7 while renderer still has visible revision6');
  const pendingCut = await command({ type: 'take', sceneId: 'camera_scripture', transition: 'cut' });
  assert.deepEqual(pendingCut.programCueGates, [{ channelId: 'scripture', revision: 7 }]);
  for (let i = 0; i < 4; i++) {
    await video.evaluate(v => new Promise(resolve => v.requestVideoFrameCallback(resolve)));
    const p = await sample(video);
    assert.ok(green(p) && logo(p) && p.cyan < 5, 'Pending Cut holds Camera, not old Scripture');
  }
  await command({ type: 'take', sceneId: 'camera_only', transition: 'fade', durationMs: 600 });
  const interrupted = [];
  for (let i = 0; i < 25; i++) {
    await video.evaluate(v => new Promise(resolve => v.requestVideoFrameCallback(resolve)));
    interrupted.push(await sample(video));
  }
  assert.ok(interrupted.every(p => green(p) && logo(p) && p.cyan < 5), 'Fade away from a gated Cut must use the actual held Camera; never flash stale Scripture');
  // Let every delayed revision7 replay settle. Its late arrival must not
  // automatically retake the discarded Scripture scene.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, delayedAt + 3000 - Date.now())));
  const settled = await sample(video);
  assert.ok(green(settled) && logo(settled) && settled.cyan < 5);
  assert.equal((await get()).program.id, 'camera_only');
  assert.ok(blue(await sample(pinned.locator('video'))));
  checks.push('Interrupting a gated Cut uses the actual on-air Camera for the next Fade, with no stale-text flash or late automatic takeover');

  // Inspector exposes text placement and typography, never a second worship
  // theme editor. Applying a preset remains draft-only until a deliberate Take.
  const showInspector = page.getByRole('button', { name: 'Show inspector', exact: true });
  if (await showInspector.isVisible()) await showInspector.click();
  await page.locator('.layer-row').filter({ hasText: 'scripture_text' }).click();
  await page.getByRole('group', { name: 'Channel text placement' }).waitFor();
  assert.equal(await page.getByLabel('Channel presentation', { exact: true }).count(), 0);
  const beforeDesign = await get();
  await page.getByRole('button', { name: 'Upper third', exact: true }).click();
  await until(async () => (await get()).scenes.find(s => s.id === 'camera_scripture').layers.find(l => l.id === 'scripture_text').y === 6, 'upper third draft');
  assert.deepEqual((await get()).program, beforeDesign.program);
  await page.getByRole('button', { name: 'Lower third', exact: true }).click();
  await until(async () => (await get()).scenes.find(s => s.id === 'camera_scripture').layers.find(l => l.id === 'scripture_text').y === 78, 'lower third draft');
  await page.getByRole('button', { name: 'Full view', exact: true }).click();
  await until(async () => (await get()).scenes.find(s => s.id === 'camera_scripture').layers.find(l => l.id === 'scripture_text').height === 100, 'full text frame draft');
  assert.deepEqual((await get()).program, beforeDesign.program);
  await page.screenshot({ path: path.join(dir, 'studio-text-inspector.png'), fullPage: true });
  checks.push('Studio placement presets and typography apply to draft layers only, including old slide-mode text sources');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
  for (const socket of proxySockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
}
