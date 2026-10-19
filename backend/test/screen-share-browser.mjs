// Run after npm run build. Generated canvas + oscillator tracks only: no screen,
// microphone, camera, operator files or real station data are captured or changed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import esbuild from '../../frontend/node_modules/esbuild/lib/main.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-screen-share-'));
const port = Number(process.env.LUMEN_SCREEN_SHARE_TEST_PORT ?? 3434), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let logs = '', browser, page, server;
const errors = [], checks = [];
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function sampleAudio(target) {
  return target.locator('video').evaluate(async video => {
    const audio = new AudioContext(); await audio.resume();
    const input = audio.createMediaStreamSource(video.srcObject), analyser = audio.createAnalyser(), silent = audio.createGain();
    analyser.fftSize = 2048; silent.gain.value = 0;
    input.connect(analyser); analyser.connect(silent); silent.connect(audio.destination);
    const samples = new Float32Array(2048); let peak = 0;
    for (let sample = 0; sample < 8; sample++) {
      await new Promise(resolve => setTimeout(resolve, 60)); analyser.getFloatTimeDomainData(samples);
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
    }
    input.disconnect(); analyser.disconnect(); silent.disconnect(); await audio.close(); return peak;
  });
}

try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'temporary station ready');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const status = async () => (await request.get(`${base}/api/studio/status`)).json();
  const command = async command => { const state = await get(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const state = await get();
  state.sources = [{ id: 'screen_test', name: 'Generated screen share', kind: 'screen', loop: false, audio: { volume: .8, muted: true, mode: 'follow', delayMs: 0 } }];
  state.scenes = [{ id: 'screen_scene', name: 'Screen scene', background: '#111111', layers: [{ id: 'screen_layer', name: 'Screen', kind: 'source', sourceId: 'screen_test', visible: true, locked: false,
    x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'cover', text: '', color: '#ffffff', background: '#00000000', fontSize: 48, fontWeight: 500, align: 'left', radius: 0 }] }];
  state.previewSceneId = 'screen_scene'; state.masterVolume = 1; state.masterMuted = false;
  const saved = await request.put(`${base}/api/studio`, { data: state }); assert.equal(saved.status(), 200, await saved.text());
  await command({ type: 'take', sceneId: 'screen_scene' });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__screenCaptures = []; window.__screenWithAudio = true;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      const index = window.__screenCaptures.length;
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const paint = () => { ctx.fillStyle = index % 2 ? '#315ed4' : '#2b9f65'; ctx.fillRect(0, 0, 640, 360); };
      paint(); const timer = setInterval(paint, 80), stream = canvas.captureStream(12);
      const audio = new AudioContext(); await audio.resume();
      const oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
      oscillator.frequency.value = 440 + index * 110; gain.gain.value = .2;
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      if (window.__screenWithAudio) stream.addTrack(destination.stream.getAudioTracks()[0]);
      window.__screenCaptures.push({ stream, audio, timer, destination }); return stream;
    } });
  });
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  assert.equal((await request.post(`${base}/api/studio/engine/start`)).status(), 200);
  const row = page.locator('.source-row').filter({ has: page.locator('b', { hasText: 'Generated screen share' }) });
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  await until(async () => { const data = await status(); return data.sources.screen_test === 'ready' && !data.sourceErrors.screen_test; }, 'audio/video screen share ready without playback error');
  assert.equal((await get()).sources[0].audio.muted, true, 'Connecting a screen does not opt its audio into the mix');
  assert.equal((await get()).mainAudioSourceId, null);
  await until(async () => (await status()).levels.master === 0, 'screen audio remains muted by default');
  await command({ type: 'set-main-audio', sourceId: 'screen_test' });
  await until(async () => (await status()).levels.master > .03, 'screen audio explicitly selected as Main');
  const output = await context.newPage(); output.on('pageerror', error => errors.push(error.message));
  await output.goto(`${base}/studio/output/program`);
  await until(() => output.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0 && video.srcObject?.getAudioTracks().length > 0), 'Program audio/video tracks');
  const pixel = () => output.locator('video').evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; });
  await until(async () => { const p = await pixel(); return p[1] > p[0] * 2 && p[1] > p[2]; }, 'actual green screen frame reaches Program');
  assert.ok(await sampleAudio(output) > .03, 'Actual remote screen audio reaches Program when explicitly Main');
  const diagnostics = await (await request.get(`${base}/api/studio/diagnostics`)).json();
  assert.deepEqual(diagnostics.renderer.inputs.find(input => input.id === 'screen_test').tracks.map(track => track.kind).sort(), ['audio', 'video']);
  checks.push('generated two-track screen connects without false playback errors, delivers real picture and opt-in Main audio');

  await row.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await until(async () => (await status()).sources.screen_test === 'missing', 'disconnect is missing, not playback error');
  assert.equal((await get()).mainAudioSourceId, 'screen_test', 'Disconnect never chooses a fallback');
  await until(async () => (await status()).levels.master === 0, 'disconnected Main is silent');
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  await until(async () => { const data = await status(); return data.sources.screen_test === 'ready' && !data.sourceErrors.screen_test && data.levels.master > .03; }, 'replacement screen reconnects with Main audio intact');
  await until(async () => { const p = await pixel(); return p[2] > p[0] * 2 && p[2] > p[1]; }, 'actual replacement blue frame reaches Program');
  for (let sample = 0; sample < 8; sample++) {
    const data = await status(); assert.equal(data.sources.screen_test, 'ready'); assert.equal(data.sourceErrors.screen_test, undefined);
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  assert.ok(await sampleAudio(output) > .03);
  checks.push('disconnect/reconnect preserves selected Main, replaces the picture and keeps a clean source status');

  await row.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.evaluate(() => { window.__screenWithAudio = false; });
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  await until(async () => /no live audio track/i.test((await status()).sourceErrors.screen_test ?? ''), 'real no-audio Main warning remains visible');
  assert.equal((await get()).mainAudioSourceId, 'screen_test');
  await row.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.evaluate(() => { window.__screenWithAudio = true; });
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  await until(async () => { const data = await status(); return data.sources.screen_test === 'ready' && !data.sourceErrors.screen_test && data.levels.master > .03; }, 'audio-enabled reconnect clears only resolved warning');
  checks.push('missing screen audio remains actionable with no fallback; explicitly reconnecting with audio restores Main');
  await page.screenshot({ path: path.join(dir, 'screen-share-healthy.png'), fullPage: true });
  await row.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await output.close();
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);

  // Exercise the actual SourceBank with deterministic delayed play promises.
  // This test-only bundle runs in a blank same-origin page; production code
  // exposes no test globals and the real operator app is not monkeypatched.
  const bundle = await esbuild.build({ absWorkingDir: root, entryPoints: ['frontend/src/lib/studio/sources.ts'], tsconfig: 'frontend/tsconfig.json', bundle: true,
    format: 'iife', globalName: 'LumenSourceBankTest', write: false, logLevel: 'silent' });
  await context.route('**/__source-playback-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Generated playback lifecycle test</title>' }));
  const harness = await context.newPage(); harness.on('pageerror', error => errors.push(error.message));
  await harness.goto(`${base}/__source-playback-harness`); await harness.addScriptTag({ content: bundle.outputFiles[0].text });
  const lifecycle = await harness.evaluate(async () => {
    const audio = new AudioContext(), bank = new LumenSourceBankTest.SourceBank(audio);
    const source = { id: 'share', name: 'Generated share', kind: 'screen', loop: false, audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } };
    bank.sync([source]);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16; canvas.getContext('2d').fillRect(0, 0, 16, 16);
    const video = canvas.captureStream(12).getVideoTracks()[0], oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start(); const tone = destination.stream.getAudioTracks()[0];
    const requests = [], originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return new Promise((resolve, reject) => requests.push({ element: this, resolve, reject })); };
    const results = {};
    try {
      const initial = new MediaStream([video]); bank.setStream('share', initial);
      const element = bank.inputs.get('share').element;
      initial.addTrack(tone); bank.setStream('share', initial);
      results.sameElement = bank.inputs.get('share').element === element && requests.length === 1;
      results.lateAudioConnected = !!bank.inputs.get('share').node;
      initial.removeTrack(tone); bank.setStream('share', initial);
      results.removedAudioDisconnected = bank.inputs.get('share').node === null;
      initial.addTrack(tone); initial.dispatchEvent(new Event('addtrack'));
      results.readdedAudioConnected = !!bank.inputs.get('share').node && requests.length === 1;
      const replacement = new MediaStream([video.clone(), tone.clone()]); bank.setStream('share', replacement);
      requests[0].reject(new DOMException('The play() request was interrupted by a call to pause(). https://invalid.example', 'AbortError'));
      await new Promise(resolve => queueMicrotask(resolve));
      results.staleReplacementError = bank.inputs.get('share').error;
      results.replacementIntact = bank.inputs.get('share').stream === replacement;
      bank.setStream('share', null); requests[1].reject(new DOMException('Disconnected', 'AbortError'));
      await new Promise(resolve => queueMicrotask(resolve));
      results.staleDisconnectError = bank.inputs.get('share').error;
      results.disconnectedStatus = bank.status().sources.share;
      bank.setStream('share', replacement);
      requests[2].reject(new DOMException('Raw browser text https://invalid.example', 'NotAllowedError'));
      await new Promise(resolve => queueMicrotask(resolve));
      results.realError = bank.inputs.get('share').error; results.realErrorStatus = bank.status().sources.share;
      bank.setStream('share', initial); const obsoleteElement = bank.inputs.get('share').element;
      bank.sync([]); bank.sync([source]); bank.setStream('share', replacement);
      requests[3].reject(new DOMException('Source removed', 'AbortError'));
      obsoleteElement.dispatchEvent(new Event('error'));
      await new Promise(resolve => queueMicrotask(resolve));
      results.removedSourceError = bank.inputs.get('share').error;
      results.newSourceIntact = bank.inputs.get('share').stream === replacement;
      replacement.getTracks().forEach(track => track.stop());
      return results;
    } finally {
      bank.close(); HTMLMediaElement.prototype.play = originalPlay;
      video.stop(); tone.stop(); oscillator.stop(); await audio.close();
    }
  });
  assert.equal(lifecycle.sameElement, true); assert.equal(lifecycle.lateAudioConnected, true);
  assert.equal(lifecycle.removedAudioDisconnected, true); assert.equal(lifecycle.readdedAudioConnected, true);
  assert.equal(lifecycle.staleReplacementError, ''); assert.equal(lifecycle.replacementIntact, true);
  assert.equal(lifecycle.staleDisconnectError, ''); assert.equal(lifecycle.disconnectedStatus, 'missing');
  assert.equal(lifecycle.realErrorStatus, 'error'); assert.match(lifecycle.realError, /blocked.*Reconnect/i); assert.doesNotMatch(lifecycle.realError, /https?:|Raw browser/);
  assert.equal(lifecycle.removedSourceError, ''); assert.equal(lifecycle.newSourceIntact, true);
  await harness.close();
  checks.push('deterministic stale play promises cannot poison a replacement, disconnect or re-created source; genuine errors remain actionable');
  await page.evaluate(async () => { for (const capture of window.__screenCaptures) { clearInterval(capture.timer); capture.stream.getTracks().forEach(track => track.stop()); capture.destination.stream.getTracks().forEach(track => track.stop()); await capture.audio.close(); } });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks, lifecycle }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]); }
}
