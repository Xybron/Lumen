// Isolated station and generated canvas/audio tracks only. This never opens a
// physical camera, microphone, screen picker or the operator's live session.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-source-stills-'));
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer(); socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
let browser, passed = false, logs = '';
const server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'] });
for (const pipe of [server.stdout, server.stderr]) pipe.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function json(response) { assert.ok(response.ok(), await response.text()); return response.json(); }

async function installInputs(page, fallback) {
  await page.addInitScript(({ fallback }) => {
    localStorage.setItem('lumen.studio.scene-view', 'list');
    localStorage.setItem('lumen:input:still_camera', JSON.stringify({ includeAudio: true }));
    const byTrack = new Map(), captures = [], activePlayers = new Set();
    const trace = window.__stills = {
      opens: [], grabs: [], stops: [], clones: [], constraints: [], assignments: [], urls: [], revoked: [], peers: 0,
      maxPlayers: 0, hidden: false,
      setColor(kind, color) { for (const item of captures) if (item.kind === kind) { item.color = color; item.paint(); } },
      setMuted(kind, value) { for (const item of captures) if (item.kind === kind && item.video.readyState === 'live') { item.muted = value; item.video.dispatchEvent(new Event(value ? 'mute' : 'unmute')); } },
      setHidden(value) { trace.hidden = value; document.dispatchEvent(new Event('visibilitychange')); },
      status() { return {
        opens: trace.opens, grabs: trace.grabs, stops: trace.stops, clones: trace.clones, constraints: trace.constraints,
        assignments: trace.assignments, urls: trace.urls, revoked: trace.revoked, peers: trace.peers,
        activePlayers: activePlayers.size, maxPlayers: trace.maxPlayers,
        tracks: captures.flatMap(item => item.stream.getTracks().map(track => ({ source: item.kind, kind: track.kind, state: track.readyState, enabled: track.enabled, settings: track.getSettings() }))),
      }; },
    };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => trace.hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => trace.hidden ? 'hidden' : 'visible' });
    const nativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends nativePeer { constructor(...args) { super(...args); trace.peers++; } };
    const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { ...srcObject, set(value) {
      if (this instanceof HTMLVideoElement) {
        if (value) {
          activePlayers.add(this);
          trace.assignments.push({ at: performance.now(), audio: value.getAudioTracks().length, muted: this.muted });
        } else activePlayers.delete(this);
        trace.maxPlayers = Math.max(trace.maxPlayers, activePlayers.size);
      }
      srcObject.set.call(this, value);
    } });
    const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createUrl(blob); if (blob instanceof Blob && blob.type.startsWith('image/')) trace.urls.push(url); return url; };
    URL.revokeObjectURL = url => { trace.revoked.push(url); revokeUrl(url); };
    function watchTrack(track, kind, item) {
      const stop = track.stop.bind(track), clone = track.clone.bind(track), apply = track.applyConstraints.bind(track);
      track.stop = () => {
        trace.stops.push({ source: kind, kind: track.kind }); stop();
        if (item.stream.getTracks().every(track => track.readyState === 'ended')) {
          clearInterval(item.timer); item.oscillator?.stop(); void item.audio?.close();
        }
      };
      track.clone = () => { trace.clones.push(kind); return clone(); };
      track.applyConstraints = constraints => { trace.constraints.push({ source: kind, constraints }); return apply(constraints); };
    }
    async function input(kind, options) {
      trace.opens.push({ kind, options });
      const canvas = document.createElement('canvas'); canvas.width = kind === 'screen' ? 800 : 640; canvas.height = kind === 'screen' ? 600 : 360;
      const context = canvas.getContext('2d'), item = { kind, canvas, color: kind === 'screen' ? '#2255d0' : '#20b840', muted: false };
      item.paint = () => { context.fillStyle = item.color; context.fillRect(0, 0, canvas.width, canvas.height); };
      item.paint(); item.timer = setInterval(item.paint, 50);
      const stream = canvas.captureStream(20); item.stream = stream; item.video = stream.getVideoTracks()[0];
      Object.defineProperty(item.video, 'muted', { configurable: true, get: () => item.muted });
      byTrack.set(item.video, item);
      if (options.audio) {
        const audio = new AudioContext(), destination = audio.createMediaStreamDestination(), oscillator = audio.createOscillator();
        oscillator.frequency.value = 220; oscillator.connect(destination); oscillator.start(); await audio.resume();
        stream.addTrack(destination.stream.getAudioTracks()[0]);
        item.audio = audio; item.oscillator = oscillator;
      }
      for (const track of stream.getTracks()) watchTrack(track, kind, item);
      captures.push(item); return stream;
    }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: options => input('camera', options) });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: options => input('screen', options) });
    Object.defineProperty(window, 'ImageCapture', { configurable: true, value: fallback ? undefined : class {
      constructor(track) { this.track = track; }
      async grabFrame() {
        const item = byTrack.get(this.track);
        if (!item || this.track.readyState !== 'live') throw new DOMException('Stopped', 'InvalidStateError');
        trace.grabs.push({ kind: item.kind, at: performance.now() });
        return createImageBitmap(item.canvas);
      }
    } });
  }, { fallback });
}

try {
  await until(async () => (await fetch(base + '/api/content').catch(() => null))?.ok, 'temporary station');
  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.LUMEN_CHROME_PATH, headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const api = context.request;
  await json(await api.post(base + '/api/auth/login', { data: { username: 'admin', password: 'admin' } }));
  await json(await api.put(base + '/api/content', { data: { version: 2, updatedAt: new Date().toISOString(),
    settings: {}, music: { mode: 'off' }, channels: [], playlists: [] } }));
  const get = async () => json(await api.get(base + '/api/studio'));
  const command = async command => { const state = await get(); return json(await api.post(base + '/api/studio/command', { data: { revision: state.revision, command } })); };
  const state = await get();
  state.sources = ['camera', 'screen'].map(kind => ({ id: `still_${kind}`, name: `${kind} input`, kind, loop: false,
    audio: { volume: .8, muted: true, mode: 'follow', delayMs: 0 } }));
  const scene = (id, source) => ({ id, name: id, background: '#111111', layers: [{ id: `${id}_layer`, name: source,
    kind: 'source', sourceId: `still_${source}`, visible: true, locked: false, x: 0, y: 0, width: 100, height: 100,
    opacity: 1, fit: 'contain', text: '', color: '#ffffff', background: '#00000000', fontSize: 68, fontWeight: 500, align: 'center', radius: 0 }] });
  state.scenes = [scene('camera_one', 'camera'), scene('camera_two', 'camera'), scene('screen_one', 'screen')];
  state.previewSceneId = 'screen_one';
  await json(await api.put(base + '/api/studio', { data: state }));
  await command({ type: 'take', sceneId: 'camera_one' });
  await command({ type: 'route', outputId: 'screen_main', sceneId: 'camera_two' });
  const baseline = await get(), errors = [];

  async function exercise(context, fallback) {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await installInputs(page, fallback); await page.goto(base + '/studio');
    await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
    const row = kind => page.locator(`.source-row[data-source-id="still_${kind}"]`);
    const still = scene => page.locator(`.scene-card[data-scene-id="${scene}"] img.scene-source-still`);
    const trace = () => page.evaluate(() => window.__stills.status());
    for (const kind of ['camera', 'screen']) await row(kind).getByRole('button', { name: 'Connect', exact: true }).click();
    await until(async () => (await trace()).opens.length === 2, 'both synthetic inputs connected');
    const tracksBefore = (await trace()).tracks;
    const pixel = image => image.evaluate(img => {
      if (!img.complete || !img.naturalWidth) return null;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, 1, 1);
      return { color: [...ctx.getImageData(0, 0, 1, 1).data], width: img.naturalWidth, height: img.naturalHeight, url: img.src };
    });
    const green = result => result && result.color[1] > result.color[0] * 2 && result.color[1] > result.color[2] * 2;
    await until(async () => green(await pixel(still('camera_one'))), `${fallback ? 'fallback' : 'ImageCapture'} camera still`);
    await until(async () => { const p = await pixel(still('screen_one')); return p && p.color[2] > p.color[0] * 2; }, 'screen still');
    const first = await pixel(still('camera_one')), shared = await pixel(still('camera_two')), screen = await pixel(still('screen_one'));
    assert.equal(first.url, shared.url, 'Scenes sharing an input share the same snapshot URL');
    for (const image of [first, screen]) assert.ok(image.width <= 192 && image.height <= 108, 'Stills stay within thumbnail resolution');
    assert.ok(Math.abs(screen.width / screen.height - 4 / 3) < .03, 'Screen snapshot preserves original aspect ratio');
    assert.equal(await page.locator('.scene-list video,.scene-list audio').count(), 0, 'Scene cards contain no players');
    await page.evaluate(() => window.__stills.setColor('camera', '#c53020'));
    await until(async () => { const p = await pixel(still('camera_one')); return p && p.color[0] > p.color[1] * 2 && p.url !== first.url; }, 'occasional refresh uses current pixels', 16000);
    assert.equal(await still('camera_one').getAttribute('src'), await still('camera_two').getAttribute('src'));
    await until(async () => (await trace()).revoked.includes(first.url), 'replaced snapshot released');
    const active = await trace();
    assert.equal(active.opens.length, 2, 'Snapshots never request another device stream');
    assert.deepEqual(active.tracks, tracksBefore, 'Snapshotting preserves audio/video track settings and state');
    assert.deepEqual(active.stops, []); assert.deepEqual(active.clones, []); assert.deepEqual(active.constraints, []);
    assert.equal(active.peers, 0, 'Offline still preview does not establish a WebRTC connection');
    assert.ok(active.maxPlayers <= 1, 'At most one temporary fallback player is attached');
    assert.ok(active.assignments.every(item => item.audio === 0 && item.muted), 'Fallback only borrows muted video');
    if (!fallback) {
      for (const kind of ['camera', 'screen']) {
        const samples = active.grabs.filter(grab => grab.kind === kind);
        for (let i = 1; i < samples.length; i++) assert.ok(samples[i].at - samples[i - 1].at >= 4800, 'A source refreshes no faster than every five seconds');
      }
      const all = active.grabs;
      for (let i = 1; i < all.length; i++) assert.ok(all[i].at - all[i - 1].at >= 450, 'Snapshot work is staggered globally');
      assert.equal(active.assignments.length, 0, 'ImageCapture path never starts a video player');
    }
    await page.getByRole('button', { name: 'Collapse scenes', exact: true }).click();
    await page.waitForTimeout(350);
    const collapsed = await trace(); await page.waitForTimeout(5600);
    assert.equal((await trace()).urls.length, collapsed.urls.length, 'Collapsed sidebar stops sampling');
    assert.equal((await trace()).activePlayers, 0);
    await page.getByRole('button', { name: 'Show scenes', exact: true }).click();
    await until(() => still('camera_one').count(), 'sidebar resumes');
    await page.evaluate(() => window.__stills.setHidden(true));
    await page.waitForTimeout(350);
    const hidden = await trace(); await page.waitForTimeout(5600);
    assert.equal((await trace()).urls.length, hidden.urls.length, 'Hidden document stops sampling');
    assert.equal((await trace()).activePlayers, 0);
    await page.evaluate(() => window.__stills.setHidden(false));
    await until(() => still('camera_one').count(), 'visible document resumes');
    await page.evaluate(() => window.__stills.setMuted('screen', true));
    await until(async () => await still('screen_one').count() === 0, 'muted screen does not retain a misleading still');
    await page.evaluate(() => window.__stills.setMuted('screen', false));
    await until(() => still('screen_one').count(), 'unmuted screen resumes');
    await row('camera').getByRole('button', { name: 'Disconnect', exact: true }).click();
    await until(async () => await still('camera_one').count() === 0 && await still('camera_two').count() === 0, 'disconnect clears every shared camera still');
    await row('camera').getByRole('button', { name: 'Connect', exact: true }).click();
    await until(async () => green(await pixel(still('camera_one'))), 'replacement input produces a fresh still');
    const output = await get();
    assert.equal(output.previewSceneId, baseline.previewSceneId);
    assert.deepEqual(output.scenes, baseline.scenes, 'Thumbnail refresh preserves saved scenes and their order');
    assert.deepEqual(output.program, baseline.program); assert.deepEqual(output.outputs, baseline.outputs);
    assert.deepEqual(output.sources, baseline.sources, 'Thumbnail work never changes audio routing or sources');
    if (fallback) {
      // Exercise the real transport/compositor while fallback stills refresh.
      // Frame advancement is a correctness check, not a hardware FPS benchmark.
      await json(await api.post(base + '/api/studio/engine/start'));
      const program = await context.newPage(); program.on('pageerror', error => errors.push(error.message));
      await program.goto(base + '/studio/output/program');
      const programVideo = program.locator('video').first();
      await until(() => programVideo.evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'real Program video ready', 30000);
      await until(() => programVideo.evaluate(video => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return pixel[1] > pixel[0] * 2 && pixel[1] > pixel[2] * 2;
      }), 'actual connected camera reaches Program');
      await page.waitForTimeout(1000);
      const running = await trace(), frames = await programVideo.evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames);
      await page.waitForTimeout(6500);
      assert.ok(await programVideo.evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames) > frames + 5, 'Program continues delivering frames while stills refresh');
      const continued = await trace();
      assert.ok(continued.urls.length > running.urls.length, 'Still snapshots also refresh during real production rendering');
      assert.equal(continued.opens.length, running.opens.length, 'Still refreshes do not open devices during production');
      assert.equal(continued.peers, running.peers, 'Still refreshes do not add WebRTC peers during production');
      assert.deepEqual(continued.stops, running.stops); assert.deepEqual(continued.constraints, running.constraints);
      assert.deepEqual((await get()).program, baseline.program);
      await page.screenshot({ path: '/private/tmp/lumen-source-still-thumbnails.png' });
      await program.close();
      await json(await api.post(base + '/api/studio/engine/stop'));
    }
    for (const kind of ['camera', 'screen']) await row(kind).getByRole('button', { name: 'Disconnect', exact: true }).click();
    await until(async () => { const state = await trace(); return state.urls.every(url => state.revoked.includes(url)); }, 'unused snapshot URLs released');
    assert.equal((await trace()).activePlayers, 0);
    await page.close();
  }
  await exercise(context, false);
  const fallbackContext = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await json(await fallbackContext.request.post(base + '/api/auth/login', { data: { username: 'admin', password: 'admin' } }));
  await exercise(fallbackContext, true);
  assert.deepEqual(errors, []);
  console.log('Passed: shared camera/screen stills, periodic refresh, aspect ratio, ImageCapture and silent fallback, bounded work, hidden/collapsed suspension, disconnect replacement, URL cleanup, unchanged tracks/routing and advancing real Program frames.');
  passed = true;
} catch (error) {
  console.error(error, logs, 'Station fixture:', directory); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
  if (passed) await fs.rm(directory, { recursive: true, force: true });
}
