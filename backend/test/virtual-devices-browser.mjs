// Exercises the real Program WebRTC receiver, scaling and audio worklet. The
// native sink is replaced only at the browser boundary; no system devices install.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-virtual-output-'));
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
let server, browser, logs = '';
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const audio = Buffer.alloc(44 + 48000 * 4 * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(2, 22);
  audio.writeUInt32LE(48000, 24); audio.writeUInt32LE(48000 * 4, 28); audio.writeUInt16LE(4, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  for (let n = 0; n < 96000; n++) {
    audio.writeInt16LE(Math.round(Math.sin(n / 48000 * 440 * 2 * Math.PI) * 5000), 44 + n * 4);
    audio.writeInt16LE(Math.round(Math.sin(n / 48000 * 880 * 2 * Math.PI) * 3000), 46 + n * 4);
  }
  await fs.mkdir(path.join(directory, 'media/music'), { recursive: true });
  await fs.writeFile(path.join(directory, 'media/music/tone.wav'), audio);
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base } });
  server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  await until(async () => (await fetch(`${base}/api/studio`)).ok, 'station startup');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext();
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const state = await (await request.get(`${base}/api/studio`)).json();
  state.sources = [{ id: 'tone', name: 'Generated stereo tone', kind: 'audio', url: '/media/music/tone.wav', loop: true,
    audio: { volume: 1, muted: false, mode: 'always', delayMs: 0 } }];
  state.scenes = [{ id: 'red', name: 'Red', background: '#cc4422', layers: [] }, { id: 'blue', name: 'Blue', background: '#2244cc', layers: [] }];
  state.previewSceneId = 'red';
  assert.equal((await request.put(`${base}/api/studio`, { data: state })).status(), 200);
  async function take(sceneId) {
    const state = await (await request.get(`${base}/api/studio`)).json();
    const response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: { type: 'take', sceneId } } });
    assert.equal(response.status(), 200, await response.text());
  }
  await take('red');
  assert.equal((await request.post(`${base}/api/studio/engine/start`, { timeout: 60000 })).status(), 200);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__sink = { video: 0, audio: 0, rms: 0, maxVideoPending: 0, maxAudioPending: 0, videoPending: 0, audioPending: 0, pixel: [], error: '' };
    window.lumenProgramSink = {
      async video(bytes) {
        const state = window.__sink;
        if (bytes.length !== 1280 * 720 * 4) throw new Error('Wrong video dimensions');
        state.maxVideoPending = Math.max(state.maxVideoPending, ++state.videoPending);
        state.pixel = Array.from(bytes.slice((360 * 1280 + 640) * 4, (360 * 1280 + 640) * 4 + 4));
        state.video++;
        await new Promise(resolve => setTimeout(resolve, 45)); // slower than frame cadence
        state.videoPending--; return true;
      },
      async audio(bytes) {
        const state = window.__sink;
        state.maxAudioPending = Math.max(state.maxAudioPending, ++state.audioPending);
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        let sum = 0; for (const sample of samples) sum += sample * sample;
        state.rms = Math.max(state.rms, Math.sqrt(sum / samples.length)); state.audio++;
        await new Promise(resolve => setTimeout(resolve, 30));
        state.audioPending--; return true;
      },
      fail(message) { window.__sink.error = message; },
    };
  });
  await page.goto(`${base}/studio/virtual-output`);
  await until(() => page.evaluate(() => window.__sink.video > 20 && window.__sink.audio > 20 && window.__sink.rms > 0.02), 'picture and Main audio reach native boundary');
  let received = await page.evaluate(() => window.__sink);
  assert.equal(received.error, '');
  assert.ok(received.pixel[2] > 150 && received.pixel[0] < 70, `BGRA red pixel: ${received.pixel}`);
  assert.equal(received.maxVideoPending, 1); assert.equal(received.maxAudioPending, 1);
  await take('blue');
  await until(() => page.evaluate(() => window.__sink.pixel[0] > 150 && window.__sink.pixel[2] < 70), 'live scene switch reaches camera');
  const stopped = await request.post(`${base}/api/studio/engine/stop`, { timeout: 30000 });
  assert.equal(stopped.status(), 200);
  await page.waitForTimeout(1000);
  const counts = await page.evaluate(() => ({ video: window.__sink.video, audio: window.__sink.audio }));
  await page.waitForTimeout(700);
  received = await page.evaluate(() => window.__sink);
  assert.deepEqual({ video: received.video, audio: received.audio }, counts, 'stopped engine cannot send its last picture or old sound');
  assert.deepEqual(errors, []); assert.equal(received.error, '');
  console.log(JSON.stringify({ videoFrames: received.video, audioPackets: received.audio, audioRms: received.rms,
    maxVideoPending: received.maxVideoPending, maxAudioPending: received.maxAudioPending }));
  console.log('PASS: Program picture, Main audio, BGRA scaling, scene switching, backpressure and engine-stop cleanup.');
} catch (error) { console.error(logs.slice(-6000)); throw error; }
finally {
  await browser?.close(); server?.kill('SIGTERM');
  if (server && server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 5000).unref(); });
  await fs.rm(directory, { recursive: true, force: true });
}
