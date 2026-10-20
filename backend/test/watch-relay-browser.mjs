// Independent public relay only. No station API, physical input or user media.
// From backend: node --import tsx test/watch-relay-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { createWatchRelay } from '../../watch-relay/server.mjs';
import { createBroadcastRelay } from '../src/broadcast-relay.ts';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-watch-browser-'));
const hlsDirectory = path.join(directory, 'station-private-hls'); await fs.mkdir(hlsDirectory);
const token = randomBytes(48).toString('hex'), errors = [], remoteRequests = [], writeRoutes = [], checks = [];
let relay, browser, time = Date.now();
const until = async (fn, label, timeout = 20000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${label}`); };
async function ff(args) { return new Promise((resolve, reject) => { const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }), out = [], err = []; child.stdout.on('data', data => out.push(data)); child.stderr.on('data', data => err.push(data)); child.once('error', reject); child.once('exit', code => code === 0 ? resolve({ out: Buffer.concat(out), err: Buffer.concat(err).toString() }) : reject(new Error(Buffer.concat(err).toString()))); }); }
console.log(JSON.stringify({ directory, phase: 'starting' }));
try {
  await ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-threads', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '24', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6', '-hls_start_number_source', 'epoch_us', '-hls_flags', 'independent_segments+discont_start', '-hls_segment_filename', path.join(hlsDirectory, 'segment-%08d.ts'), path.join(hlsDirectory, 'index.m3u8')]);
  relay = await createWatchRelay({ dataDir: path.join(directory, 'relay-public-media'), pushToken: token, allowedSlugs: ['live'], now: () => time });
  relay.server.on('request', req => { if (!['GET', 'HEAD'].includes(req.method ?? '')) writeRoutes.push(req.url); });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const publisher = createBroadcastRelay({ baseUrl: base, token, slug: 'live', allowLocalhostForTests: true });
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  // Chromium may advertise native HLS as "maybe" even when a live feed cannot
  // decode through that path. A supported MSE player must take precedence.
  await context.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
      configurable: true, writable: true,
      value(type) { return /mpegurl/i.test(type) ? 'maybe' : original.call(this, type); },
    });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== base && !request.url().startsWith('blob:')) remoteRequests.push(request.url()); });
  await page.goto(`${base}/watch/live`); await until(() => page.locator('#status').textContent().then(text => text === 'Offline'), 'initial Offline state');
  assert.equal(await page.locator('video').evaluate(video => video.canPlayType('application/vnd.apple.mpegurl')), 'maybe', 'Regression fixture advertises potentially misleading native HLS support');
  assert.equal(await page.evaluate(() => window.Hls.isSupported()), true, 'Locally packaged MSE playback is available');
  assert.equal((await fetch(`${base}/api/studio`)).status, 404);
  await publisher.begin({ epoch: 'actual-hls-session-0001' });
  assert.equal((await (await fetch(`${base}/api/watch/live`)).json()).status, 'connecting');
  assert.equal(await page.locator('video').evaluate(video => video.muted), true);
  await publisher.publish({ directory: hlsDirectory, playlist: 'index.m3u8' });
  const status = await (await fetch(`${base}/api/watch/live`)).json(); assert.equal(status.status, 'live');
  const publicPlaylist = await (await fetch(base + status.playlistUrl)).text(); const names = publicPlaylist.split('\n').filter(line => /^segment-/.test(line)); assert.ok(names.length >= 2 && names.every(name => /^segment-\d{16,20}\.ts$/.test(name)));
  assert.equal(writeRoutes.at(-1).split('/').at(-1), 'index.m3u8');
  const decoded = await ff(['-hide_banner', '-loglevel', 'error', '-i', base + status.playlistUrl, '-t', '0.2', '-f', 'null', '-']); assert.equal(decoded.err, '');
  await until(() => page.locator('video').evaluate(video => video.videoWidth === 640 && video.videoHeight === 360 && video.readyState >= 2 && video.currentTime > 0.1 && !video.paused && video.currentSrc.startsWith('blob:')), 'actual locally packaged HLS.js MSE decodes public H.264/AAC despite native HLS maybe', 25000);
  await until(() => page.locator('#status').textContent().then(text => text === 'Live'), 'decoded playback reports Live');
  const position = await page.locator('video').evaluate(video => video.currentTime); await new Promise(resolve => setTimeout(resolve, 350)); assert.ok(await page.locator('video').evaluate(video => video.currentTime) > position, 'Decoded video clock advances');
  const pixelVariance = await page.locator('video').evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 9; const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 16, 9); const data = ctx.getImageData(0, 0, 16, 9).data; return Math.max(...data) - Math.min(...data); }); assert.ok(pixelVariance > 100, 'Real decoded picture, not a blank player');
  await page.screenshot({ path: path.join(directory, 'watch-desktop-live.png'), fullPage: true });
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await until(() => page.evaluate(() => !!document.fullscreenElement), 'public player fullscreen'); await page.evaluate(() => document.exitFullscreen());
  await page.getByRole('button', { name: 'Copy link', exact: true }).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${base}/watch/live`);
  checks.push('Actual segment-first station upload, public HLS/AAC decode in FFmpeg and Chrome, MSE Blob precedence over native HLS maybe, muted playback, fullscreen and share link');
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: path.join(directory, 'watch-phone-live.png'), fullPage: true });
  const browserWritesBefore = writeRoutes.length; await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(writeRoutes.length, browserWritesBefore, 'Public viewer never writes operator state or publishing API');
  time += 19000; await publisher.publish({ directory: hlsDirectory, playlist: 'index.m3u8' });
  assert.equal((await (await fetch(`${base}/api/watch/live`)).json()).status, 'offline');
  assert.equal((await fetch(base + status.playlistUrl)).status, 410);
  await until(() => page.locator('#status').textContent().then(text => text === 'Offline'), 'frozen stream becomes visibly Offline', 10000);
  await page.screenshot({ path: path.join(directory, 'watch-phone-offline.png'), fullPage: true });
  await publisher.finish(); time += 121000; await relay.cleanup();
  assert.deepEqual(await fs.readdir(path.join(directory, 'relay-public-media', 'live')), ['session.json']);
  assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []); assert.ok(!(await page.content()).includes(token));
  checks.push('Mobile no-overflow layout, honest stale Offline state, no operator access, no external/CDN requests, secret isolation and bounded session cleanup');
  console.log(JSON.stringify({ ok: true, directory, checks, errors, remoteRequests }, null, 2));
} catch (error) { console.error(JSON.stringify({ ok: false, directory, error: error.stack ?? String(error), errors, remoteRequests }, null, 2)); process.exitCode = 1; }
finally { if (browser) await browser.close(); if (relay) await relay.close(); }
