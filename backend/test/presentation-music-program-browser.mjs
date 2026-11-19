// An isolated station verifies the actual music player -> Program WebRTC path.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-program-music-'));
const port = Number(process.env.LUMEN_MUSIC_TEST_PORT || 3497), base = `http://127.0.0.1:${port}`;
let server, browser, logs = '';
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${label} ${last?.message || ''}`);
}
async function peak(page) {
  return page.locator('video').evaluate(async video => {
    const context = new AudioContext(), analyser = context.createAnalyser(), silent = context.createGain();
    silent.gain.value = 0;
    const source = context.createMediaStreamSource(video.srcObject);
    source.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
    await context.resume();
    const samples = new Float32Array(analyser.fftSize); let value = 0;
    for (let i = 0; i < 8; ++i) { await new Promise(r => setTimeout(r, 50)); analyser.getFloatTimeDomainData(samples); for (const sample of samples) value = Math.max(value, Math.abs(sample)); }
    source.disconnect(); analyser.disconnect(); silent.disconnect(); await context.close(); return value;
  });
}
try {
  const frames = 48000 * 60, audio = Buffer.alloc(44 + frames * 4);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(2, 22); audio.writeUInt32LE(48000, 24); audio.writeUInt32LE(192000, 28);
  audio.writeUInt16LE(4, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  for (let i = 0; i < frames; ++i) for (let channel = 0; channel < 2; ++channel)
    audio.writeInt16LE(Math.round(Math.sin(i / 48000 * 440 * Math.PI * 2) * 14000), 44 + i * 4 + channel * 2);
  await fs.mkdir(path.join(directory, 'media/music'), { recursive: true }); await fs.writeFile(path.join(directory, 'media/music/music.wav'), audio);
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base } });
  server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  await until(async () => (await fetch(`${base}/api/studio`)).ok, 'station ready');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const seeded = await request.put(`${base}/api/content`, { data: { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 },
    music: { mode: 'loop', volume: 0.6, current: 'music/music.wav', queue: ['music/music.wav'], fadeInMs: 0, fadeOutMs: 0 },
    channels: [{ id: 'prayer', name: 'Prayer', kind: 'presentation', playlistId: 'prayers', defaultMode: 'auto' }],
    playlists: [{ id: 'prayers', name: 'Prayer', items: [{ id: 'first', type: 'text', title: 'Pray together', body: 'Prayer for the nation', durationMs: 2000 }] }] } });
  assert.equal(seeded.status(), 200, await seeded.text());
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Prayer', exact: true }).waitFor();
  const musicState = () => page.evaluate(() => {
    const music = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('music');
    return { playing: music.playing, auto: music.autoEnabled, monitor: music.monitorEnabled };
  });
  assert.deepEqual(await musicState(), { playing: false, auto: false, monitor: false }, 'Legacy loop mode does not autoplay');
  // Configure a plain Program picture; music is independent of scene layers.
  const studio = await (await request.get(`${base}/api/studio`)).json();
  const take = await request.post(`${base}/api/studio/command`, { data: { revision: studio.revision, command: { type: 'take', sceneId: studio.scenes[0].id } } });
  assert.equal(take.status(), 200, await take.text());
  await page.locator('.music-mini-player:visible').getByRole('button', { name: 'Play music', exact: true }).click();
  await until(async () => (await musicState()).playing, 'Manual music Play');
  const output = await context.newPage(); await output.goto(`${base}/studio/output/program`);
  await until(() => output.locator('video').evaluate(v => v.readyState >= 2 && v.srcObject?.getAudioTracks().length), 'Program audio track');
  await until(async () => await peak(output) > 0.03, 'Presentation music audible in Program');
  const published = await (await request.get(`${base}/api/studio`)).json();
  assert.equal(published.sources.filter(s => s.id === 'lumen_presentation_music').length, 1);
  assert.equal(published.sources.find(s => s.id === 'lumen_presentation_music').audio.mode, 'always');
  // Route navigation must preserve the publisher and must not start Auto.
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await until(async () => page.url().endsWith('/studio'), 'Studio navigation');
  assert.equal((await musicState()).playing, true); assert.equal((await musicState()).auto, false);
  assert.ok(await peak(output) > 0.03, 'Music survives navigation');
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('music').pause());
  await until(async () => !(await musicState()).playing, 'Music pause');
  await until(async () => await peak(output) < 0.001, 'Paused music produces Program silence');
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/'));
  await page.getByRole('heading', { name: 'Prayer', exact: true }).waitFor();
  assert.equal((await musicState()).playing, false, 'Returning to Presentation never restarts paused music');
  await page.screenshot({ path: path.join(directory, 'studio-shared-controls.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS: music manual startup, real Program audio, one input, workspace continuity and pause silence. ${directory}`);
} catch (error) { console.error(logs.slice(-5000)); throw error; }
finally {
  await browser?.close();
  if (server && server.exitCode === null) { const exited = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await exited; }
}
