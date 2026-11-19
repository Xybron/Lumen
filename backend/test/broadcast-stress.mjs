// Isolated generated-media station. All social egress is rewritten by the
// fixture to verified loopback TLS receivers; no real keys/devices are loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-browser-stress-'));
const port = Number(process.env.LUMEN_BROADCAST_TEST_PORT ?? 3471), base = `http://127.0.0.1:${port}`;
const cycles = Number(process.env.LUMEN_STARTUP_CYCLES ?? 10), seconds = Number(process.env.LUMEN_STRESS_SECONDS ?? 900);
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 50);
assert.ok(Number.isInteger(seconds) && seconds >= 0 && seconds <= 3600);
let server, browser, cameraPage, cookie = '', logs = '', relayOrigin;
const camera = process.env.LUMEN_STRESS_CAMERA === '1';
const competingEncode = camera && process.env.LUMEN_STRESS_COMPETING_ENCODE === '1';
const samples = [], starts = [], report = { directory, cycles, seconds, camera,
  faultInjection: process.env.LUMEN_FIXTURE_STALL_FIRST_AUDIO === '1' ? 'first-audio-context-stalled' : null,
  extra1080pEncode: competingEncode, starts, samples, ok: false };
const save = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await response.text(); assert.ok(response.ok, `${method} ${url}: ${response.status} ${text}`); return JSON.parse(text);
}
async function until(fn, label, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(250); }
  throw new Error(`Timed out: ${label}`);
}
async function media(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve({ output, error }) : reject(new Error(error)));
  });
}
async function sample(phase) {
  const [d, b, transport] = await Promise.all([api('/api/studio/diagnostics'), api('/api/studio/broadcast'), api('/__fixture/broadcast')]);
  const value = { at: new Date().toISOString(), phase, status: d.status, timing: d.renderer?.timing,
    audioState: d.renderer?.audioState, audioTime: d.renderer?.audioTime, mediaStartup: d.renderer?.mediaStartup, recording: d.renderer?.recording,
    capture: d.renderer?.broadcast, broadcast: d.broadcast, session: b.session,
    peers: d.renderer?.peers?.map(p => ({ key: p.key, state: p.state })),
    camera: d.renderer?.peers?.find(p => p.key === 'in:stress_camera')?.stats?.find(s => s.type === 'inbound-rtp' && s.kind === 'video'),
    competingEncode: competingEncode && cameraPage ? await cameraPage.evaluate(() => ({ ...window.__stressEncode.stats, state: window.__stressEncode.recorder.state })) : null,
    processes: transport.spawned.map(({ diagnostics, ...p }) => p), receivers: transport.receivers };
  samples.push(value); await save(); return value;
}
async function end() {
  const recordingId = (await api('/api/studio/status')).recording?.id;
  await api('/api/studio/broadcast/stop', 'POST', { stopRecording: true });
  if (recordingId) await until(async () => {
    const recording = (await api('/api/studio/recordings')).find(item => item.id === recordingId);
    assert.ok(recording && !['error', 'interrupted'].includes(recording.status), 'Recording finalizes without failure');
    return recording.status === 'complete';
  }, 'recording finalizes', 120000);
  await api('/api/studio/engine/stop', 'POST', {});
}
async function openCamera() {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(directory, 'camera.y4m')}`] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const [name, value] = cookie.split('='); await context.addCookies([{ name, value, url: base }]);
  await context.grantPermissions(['camera'], { origin: base });
  await context.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__stressPeers = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.__stressPeers.push(this); }
    };
  });
  const page = cameraPage = await context.newPage(); await page.goto(`${base}/studio`);
  await page.locator('[data-source-id="stress_camera"].source-row').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('[data-source-id="stress_camera"].source-row').getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open Go Live controls', exact: true }).click();
  if (competingEncode) await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    const ctx = c.getContext('2d', { alpha: false }); let frame = 0;
    const timer = setInterval(() => { ctx.fillStyle = '#245f93'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = 'white'; ctx.fillRect((frame++ * 17) % 1800, 100, 100, 800); }, 1000 / 30);
    const stream = c.captureStream(30), recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 6000000 });
    const stats = { chunks: 0, bytes: 0, failed: false };
    recorder.ondataavailable = e => { stats.chunks++; stats.bytes += e.data.size; };
    recorder.onerror = () => { stats.failed = true; };
    recorder.start(500); window.__stressEncode = { recorder, timer, stream, stats };
  });
}

try {
  const mediaDirectory = path.join(directory, 'media', 'backgrounds'); await fs.mkdir(mediaDirectory, { recursive: true });
  await media(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-b:a', '192k', path.join(mediaDirectory, 'stress.mp4')]);
  if (camera) await media(['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(mediaDirectory, 'stress.mp4'), '-t', '3', '-an', '-vf', 'scale=960:540', '-pix_fmt', 'yuv420p', path.join(directory, 'camera.y4m')]);
  server = spawn(process.execPath, ['backend/test/broadcast-fixture.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), LUMEN_DATA_DIR: directory, LUMEN_BROADCAST_FIXTURE: 'yes' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; for (const line of chunk.toString().split('\n')) try { const m = JSON.parse(line); if (m.phase === 'broadcast-fixture-ready') relayOrigin = m.relayOrigin; } catch {} });
  server.stderr.on('data', chunk => { logs += chunk; });
  await until(() => { if (server.exitCode !== null) throw new Error(`Fixture exited: ${logs}`); return relayOrigin; }, 'fixture starts');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  const state = await api('/api/studio');
  state.sources = [{ id: 'stress_video', name: 'Generated 1080p motion and stereo tone', kind: 'video', url: 'media/backgrounds/stress.mp4', loop: true, audio: { muted: false, volume: 1, mode: 'follow', delayMs: 0 } }];
  state.scenes = [{ id: 'stress_scene', name: 'Generated stress scene', background: '#000000', layers: [{ id: 'stress_layer', name: 'Generated motion', kind: 'source', sourceId: 'stress_video', visible: true, locked: false, x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'cover', text: '', color: '#ffffff', background: '#00000000', fontSize: 72, fontWeight: 500, align: 'center', radius: 0 }] }];
  state.previewSceneId = 'stress_scene'; state.mainAudioSourceId = 'stress_video'; state.masterMuted = false; state.masterVolume = 1;
  if (camera) {
    state.sources.push({ id: 'stress_camera', name: 'Generated camera', kind: 'camera', loop: false, audio: { muted: true, volume: 1, mode: 'follow', delayMs: 0 } });
    state.scenes[0].layers[0].sourceId = 'stress_camera';
  }
  const saved = await api('/api/studio', 'PUT', state);
  const routed = await api('/api/studio/command', 'POST', { revision: saved.revision, command: { type: 'set-main-audio', sourceId: 'stress_video' } });
  await api('/api/studio/command', 'POST', { revision: routed.revision, command: { type: 'take', sceneId: 'stress_scene' } });
  await api('/api/studio/broadcast/config', 'PUT', { profile: '720p', recordOnStart: true, destinations: [
    { id: 'youtube', enabled: true, streamKey: 'fixture-youtube-key-loopback-only' },
    { id: 'facebook', enabled: true, streamKey: 'fixture-facebook-key-loopback-only' },
    { id: 'instagram', enabled: true, streamUrl: 'rtmps://edgetee-upload-los4-1.xx.fbcdn.net:443/rtmp/', streamKey: 'fixture-instagram-key-loopback-only?s_bl=1&s_fbp=lhr11-1&s_prp=' }], watch: { enabled: true } });
  if (camera) await openCamera();
  console.log(JSON.stringify({ phase: 'ready', directory, base, cycles, seconds, media: path.join(mediaDirectory, 'stress.mp4') }));
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const started = Date.now(); await api('/api/studio/broadcast/start', 'POST', { record: true, title: `Startup stress ${cycle}` });
    let lastSample = 0;
    await until(async () => {
      if (Date.now() - lastSample < 1000) return false;
      lastSample = Date.now(); const s = await sample(`startup-${cycle}`);
      assert.notEqual(s.session.state, 'error', `Startup ${cycle}: ${s.session.error}; capture ${JSON.stringify(s.capture)}; audio ${s.audioState}/${s.audioTime}`);
      return s.session.state === 'live' && [...s.session.destinations, s.session.watch].every(d => d.state === 'live' && d.retries === 0) && s.status.recording?.bytes > 0
        && (!camera || s.status.sources.stress_camera === 'ready') && s.status.levels.master > 0.01;
    }, `cold start ${cycle}`, 45000);
    if (process.env.LUMEN_FIXTURE_STALL_FIRST_AUDIO === '1') assert.equal(samples.at(-1).mediaStartup?.attempts, 2, 'The stalled first audio engine was rebuilt before capture began');
    starts.push({ cycle, elapsedMs: Date.now() - started, mediaStartup: samples.at(-1).mediaStartup }); await save(); console.log(JSON.stringify({ phase: 'started', ...starts.at(-1) }));
    if (cycle < cycles) {
      await end();
      if (camera) {
        await browser.close(); browser = null; cameraPage = null;
        await openCamera();
      }
    }
  }
  const began = Date.now(); let previous;
  while (Date.now() - began < seconds * 1000) {
    await sleep(Math.min(10000, seconds * 1000 - (Date.now() - began)));
    const s = await sample('sustained');
    assert.equal(s.session.state, 'live'); assert.ok([...s.session.destinations, s.session.watch].every(d => d.state === 'live' && d.retries === 0));
    assert.equal(s.capture.capture.effectiveFrameRate, 30, 'Stream cadence stays at the selected 30 fps');
    assert.equal(s.capture.capture.videoBitsPerSecond, 2500000); assert.equal(s.capture.capture.width, 1280); assert.equal(s.capture.capture.height, 720);
    assert.equal(s.status.recording?.status, 'recording'); assert.equal(s.audioState, 'running');
    assert.ok(s.status.levels.master > 0.01, 'Main audio stays audible');
    if (camera) {
      assert.equal(s.status.sources.stress_camera, 'ready', 'Camera stays ready');
      assert.ok(!s.peers.some(p => p.key === 'out:preview' || p.key === 'out:program'), 'Covered silent monitors do not consume encoders behind Go Live');
      if (competingEncode) {
        assert.equal(s.competingEncode.state, 'recording'); assert.equal(s.competingEncode.failed, false);
        if (previous) assert.ok(s.competingEncode.bytes > previous.competingEncode.bytes, 'Competing encode keeps producing media');
      }
      if (previous) assert.ok(s.camera?.framesDecoded - previous.camera?.framesDecoded >= 20 * (Date.parse(s.at) - Date.parse(previous.at)) / 1000, 'Camera continues delivering frames during each sampling interval');
    }
    if (previous) { assert.ok(s.session.bytes > previous.session.bytes); assert.ok(s.status.recording.bytes > previous.status.recording.bytes); assert.ok(s.audioTime > previous.audioTime); }
    previous = s; console.log(JSON.stringify({ phase: 'sustained', elapsedSeconds: Math.round((Date.now() - began) / 1000), fps: s.timing?.fps, pauses: s.timing?.pauses, queuedBytes: s.broadcast.queuedBytes, maxInputWaitMs: s.broadcast.maxInputWaitMs }));
  }
  if (camera && seconds >= 30) {
    const sustained = samples.filter(s => s.phase === 'sustained');
    const first = sustained[0], last = sustained.at(-1);
    report.cameraAverageFps = (last.camera.framesDecoded - first.camera.framesDecoded) / ((Date.parse(last.at) - Date.parse(first.at)) / 1000);
    assert.ok(report.cameraAverageFps >= 28.5, 'Camera retains its selected cadence over the full run');
  }
  await end();
  const transport = await api('/__fixture/broadcast');
  report.media = [];
  for (const name of ['youtube', 'facebook', 'instagram']) {
    const receiver = transport.receivers.filter(r => r.name === name).at(-1); assert.ok(receiver?.bytes > 10000);
    const filename = path.join(directory, 'local-rtmps', receiver.filename);
    const check = await media(['-hide_banner', '-i', filename, '-t', '2', '-f', 'null', '-']);
    assert.match(check.error, /Video: h264[^\n]*1280x720/); assert.match(check.error, /Audio: aac[^\n]*stereo/);
    report.media.push({ name, bytes: receiver.bytes, filename });
  }
  report.ok = true; await save(); console.log(JSON.stringify({ phase: 'passed', directory, cycles, seconds }));
} catch (error) {
  report.error = error.stack;
  if (cameraPage) report.cameraSenders = await cameraPage.evaluate(async () => Promise.all(window.__stressPeers.map(async p => ({ state: p.connectionState, stats: Array.from((await p.getStats()).values()).filter(s => s.type === 'outbound-rtp' || s.type === 'media-source') })))).catch(() => null);
  await sample('failure').catch(() => {}); await save(); console.error(error);
  await fs.writeFile(path.join(directory, 'server.log'), logs); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server?.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(10000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
}
