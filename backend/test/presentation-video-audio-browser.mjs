// End-to-end slide audio check on an isolated temporary station.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-slide-audio-'));
const port = Number(process.env.LUMEN_SLIDE_AUDIO_TEST_PORT ?? 3431);
const base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
await fs.mkdir(path.join(dir, 'media', 'backgrounds'), { recursive: true });
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=#225588:size=320x180:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-c:a', 'aac', '-b:a', '128k', '-shortest', path.join(dir, 'media', 'backgrounds', 'test.mp4')]);

let logs = '', browser;
let updates;
const server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(2000) })).ok, 'temporary station');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  updates = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { updates.once('open', resolve); updates.once('error', reject); });
  const notify = content => updates.send(JSON.stringify({ t: 'content-updated', updatedAt: content.updatedAt }));
  const slide = { id: 'video_slide', type: 'video', title: 'Conference video', durationMs: 8000,
    background: { kind: 'video', src: 'media/backgrounds/test.mp4', fit: 'contain', overlayOpacity: 0, loop: true, muted: false, volume: 1 } };
  const body = { version: 2, updatedAt: new Date().toISOString(), settings: {}, music: { mode: 'off' },
    channels: [{ id: 'conference', name: 'Conference', kind: 'presentation', playlistId: 'p_conference', defaultMode: 'manual' }],
    playlists: [{ id: 'p_conference', name: 'Conference', items: [slide] }] };
  const putContent = async content => { const r = await request.put(`${base}/api/content`, { data: content }); assert.equal(r.status(), 200, await r.text()); return r.json(); };
  let content = await putContent(body);
  const state = await (await request.get(`${base}/api/studio`)).json();
  state.sources = [{ id: 'conference_source', name: 'Conference', kind: 'channel', channelId: 'conference', loop: false,
    audio: { volume: 1, muted: false, mode: 'follow', delayMs: 0 } }];
  state.scenes = [{ id: 'conference_scene', name: 'Conference scene', background: '#000000', layers: [{ id: 'video_layer', name: 'Conference', kind: 'source', sourceId: 'conference_source', visible: true, locked: false,
    x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'cover', text: '', color: '#ffffff', background: '#00000000', fontSize: 48, fontWeight: 500, align: 'center', radius: 0 }] }];
  state.previewSceneId = 'conference_scene'; state.masterMuted = false; state.masterVolume = 1;
  const saved = await request.put(`${base}/api/studio`, { data: state }); assert.equal(saved.status(), 200, await saved.text());
  const current = await saved.json();
  const take = await request.post(`${base}/api/studio/command`, { data: { revision: current.revision, command: { type: 'take', sceneId: 'conference_scene' } } });
  assert.equal(take.status(), 200, await take.text());
  const started = await request.post(`${base}/api/studio/engine/start`, { timeout: 50000 }); assert.equal(started.status(), 200, await started.text());
  const level = async () => (await (await request.get(`${base}/api/studio/status`)).json()).levels.master;
  const baseline = await until(async () => { const value = await level(); return value > .02 ? value : null; }, 'video audio reaches Studio');
  content.playlists[0].items[0].background.muted = true;
  content = await putContent(content);
  notify(content);
  await until(async () => (await level()) < .001, 'slide mute silences Studio audio');
  content.playlists[0].items[0].background.muted = false;
  content.playlists[0].items[0].background.volume = .2;
  content = await putContent(content);
  notify(content);
  await until(async () => { const value = await level(); return value > .002 && value < baseline * .5; }, 'slide volume reaches Studio');

  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Conference', exact: true }).waitFor();
  const listen = page.getByRole('button', { name: 'Listen to video', exact: true }); await listen.waitFor(); await listen.click();
  const preview = page.locator('.cue-current video');
  await until(async () => preview.evaluate(video => video.readyState >= 2 && !video.muted && Math.abs(video.volume - .2) < .01), 'local presentation audio monitor');
  const edit = page.locator('.presentation-slide-card').getByTitle('Edit').first(); await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Edit slide' }); await dialog.waitFor();
  assert.equal(await dialog.getByText('Video file', { exact: true }).count(), 1);
  assert.equal(await dialog.getByText('Body', { exact: true }).count(), 0);
  assert.equal(await dialog.getByText('Reference', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Loop video: On' }).click();
  await dialog.getByRole('button', { name: 'Mute slide' }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => { const saved = await (await request.get(`${base}/api/content`)).json(); return saved.playlists[0].items[0].background.muted && saved.playlists[0].items[0].background.loop === false; }, 'video settings saved');
  await until(async () => (await level()) < .001, 'saved slide mute reaches Studio');
  await edit.click(); await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Image', exact: true }).click();
  assert.equal(await dialog.getByText('Image file', { exact: true }).count(), 1);
  assert.equal(await dialog.getByText('Video volume', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Text', exact: true }).click();
  assert.equal(await dialog.getByText('Body', { exact: true }).count(), 1);
  assert.equal(await dialog.getByText('Text appearance', { exact: true }).count(), 1);
  await dialog.getByRole('button', { name: 'Lyrics', exact: true }).click();
  assert.equal(await dialog.getByText('Stanzas', { exact: true }).count(), 1);
  assert.equal(await dialog.getByText('Reference', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Announcement', exact: true }).click();
  assert.equal(await dialog.getByText('Subtitle', { exact: true }).count(), 1);
  await dialog.getByRole('button', { name: 'Section', exact: true }).click();
  assert.equal(await dialog.getByLabel('Duration in seconds').count(), 0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', baseline, checks: ['type-specific editor', 'local listen', 'Studio audio mute and volume', 'saved loop and mute'] }));
} catch (error) {
  console.error(logs.slice(-4500)); console.error(`Test artifacts: ${dir}`); throw error;
} finally {
  updates?.close();
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited;
  }
  await fs.rm(dir, { recursive: true, force: true });
}
