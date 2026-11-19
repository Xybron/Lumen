// Isolated generated-media benchmark: never loads station data or platform keys.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = path.join(root, 'frontend/dist/assets');
const filename = (await fs.readdir(assets)).find(name => /^broadcast-encoder\.worker-.*\.js$/.test(name));
assert.ok(filename, 'Build frontend before running the benchmark.');
const workerCode = await fs.readFile(path.join(assets, filename), 'utf8');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-encoder-benchmark-'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/worker.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/worker.js' ? workerCode : '<!doctype html><title>Generated stream benchmark</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const results = [];
try {
  for (const hardware of [false, true]) {
    const browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
      args: [...(process.env.LUMEN_BENCHMARK_GPU === '1' ? ['--enable-gpu'] : []), '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    try {
      const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
      const cdp = await browser.newBrowserCDPSession();
      await page.evaluate(hardware => {
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext('2d', { alpha: false });
        const recordingCanvas = document.createElement('canvas'); recordingCanvas.width = 1920; recordingCanvas.height = 1080;
        const recordingContext = recordingCanvas.getContext('2d', { alpha: false });
        const audio = new AudioContext({ sampleRate: 48000 }), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
        oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
        const stream = canvas.captureStream(30), recordingStream = recordingCanvas.captureStream(30);
        recordingStream.addTrack(destination.stream.getAudioTracks()[0]);
        const recorder = new MediaRecorder(recordingStream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 6000000 });
        recorder.ondataavailable = () => {}; recorder.start(500);
        window.frames = 0; window.chunks = []; window.failed = false;
        const timer = setInterval(() => {
          ctx.fillStyle = '#132e64'; ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = '#ff784b'; ctx.fillRect((window.frames * 11) % 1200, 250, 80, 180);
          ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText(String(window.frames), 100, 100);
          recordingContext.drawImage(canvas, 0, 0, 1920, 1080); window.frames++;
        }, 1000 / 30);
        const worker = new Worker('/worker.js', { type: 'module' });
        worker.onerror = () => { window.failed = true; };
        worker.onmessage = ({ data }) => {
          if (data === 'error') { window.failed = true; return; }
          if (data === 'ready') {
            const video = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0], maxBufferSize: 1 }).readable;
            const sound = new MediaStreamTrackProcessor({ track: destination.stream.getAudioTracks()[0].clone(), maxBufferSize: 8 }).readable;
            worker.postMessage({ video, audio: sound }, [video, sound]); return;
          }
          window.chunks.push(data); worker.postMessage('ack');
        };
        worker.postMessage({ hardware, bitrate: 2500000 });
        window.stopBenchmark = () => { worker.terminate(); recorder.stop(); clearInterval(timer); void audio.close(); };
      }, hardware);
      await page.waitForTimeout(2000);
      const before = await cdp.send('SystemInfo.getProcessInfo'), start = performance.now();
      await page.waitForTimeout(8000);
      const after = await cdp.send('SystemInfo.getProcessInfo'), seconds = (performance.now() - start) / 1000;
      const cpuBefore = new Map(before.processInfo.map(item => [item.id, item.cpuTime]));
      const cpuSeconds = after.processInfo.reduce((sum, item) => sum + Math.max(0, item.cpuTime - (cpuBefore.get(item.id) ?? item.cpuTime)), 0);
      const media = await page.evaluate(async () => { window.stopBenchmark(); return { frames: window.frames, chunks: window.chunks.length, failed: window.failed,
        bytes: [...new Uint8Array(await new Blob(window.chunks).arrayBuffer())] }; });
      const file = path.join(directory, hardware ? 'hardware.mkv' : 'software.mkv'); await fs.writeFile(file, Buffer.from(media.bytes));
      const gpu = (await cdp.send('SystemInfo.getInfo')).gpu.featureStatus;
      const result = { hardware, gpu, cpuPercent: Math.round(cpuSeconds / seconds * 100), frames: media.frames, chunks: media.chunks, failed: media.failed, bytes: media.bytes.length, file };
      results.push(result); console.log(JSON.stringify(result));
    } finally { await browser.close(); }
  }
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
