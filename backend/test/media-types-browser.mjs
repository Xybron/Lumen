// Media type, reuse and deletion checks run only against a temporary station.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-media-types-'));
const port = Number(process.env.LUMEN_MEDIA_TYPES_TEST_PORT ?? 3458), base = `http://127.0.0.1:${port}`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LUMEN_|VPS_|MEDIA_ENGINE_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
let server, browser, page, logs = '';
const checks = [], errors = [];
async function until(operation, label, timeout = 20000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function json(response, expected = 200) { assert.equal(response.status(), expected, await response.text()); return response.json(); }
const live = state => ({ program: state.program, outputs: state.outputs, programTransition: state.programTransition, channelInsert: state.channelInsert, mainAudioSourceId: state.mainAudioSourceId, masterMuted: state.masterMuted, masterVolume: state.masterVolume });
try {
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  const videoFile = path.join(dir, 'welcome.mp4'), audioFile = path.join(dir, 'reflection.wav');
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10', '-t', '2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile]);
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '2', '-c:a', 'pcm_s16le', audioFile]);
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...environment, HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio/status`, { signal: AbortSignal.timeout(1000) })).ok, 'temporary station ready');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  context.setDefaultTimeout(15000);
  await json(await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  const catalog = async () => (await json(await request.get(`${base}/api/media-library`))).assets;
  const studio = async () => json(await request.get(`${base}/api/studio`));
  const content = async () => json(await request.get(`${base}/api/content`));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/media`); await page.getByRole('heading', { name: 'Media library', exact: true }).waitFor();
  await page.getByLabel('Upload media to Media', { exact: true }).setInputFiles([videoFile, audioFile]);
  await until(async () => (await catalog()).filter(asset => asset.origin === 'library').length === 2, 'mixed video/audio upload');
  const uploaded = await catalog(), video = uploaded.find(asset => asset.kind === 'video'), audio = uploaded.find(asset => asset.kind === 'audio');
  assert.ok(video.libraryPath.startsWith('media/backgrounds/'));
  assert.ok(audio.libraryPath.startsWith('media/music/'));
  const upload = async (kind, name, mimeType, buffer) => json(await request.post(`${base}/api/media/${kind}`, { multipart: { file: { name, mimeType, buffer } } }));
  const alternateVideo = await upload('backgrounds', 'alternate-video.mp4', 'video/mp4', await fs.readFile(videoFile));
  const alternateAudio = await upload('music', 'alternate-audio.wav', 'audio/wav', await fs.readFile(audioFile));
  await upload('backgrounds', 'artwork.png', 'image/png', await sharp({ create: { width: 320, height: 180, channels: 4, background: '#31576d' } }).png().toBuffer());
  for (const [file, name, mimeType] of [[videoFile, 'private-video.mp4', 'video/mp4'], [audioFile, 'private-audio.wav', 'audio/wav']]) {
    await json(await request.post(`${base}/api/clips/assets`, { multipart: { durationMs: '2000', width: '320', height: '180', file: { name, mimeType, buffer: await fs.readFile(file) } } }), 201);
  }
  const initial = await studio();
  initial.sources.push({ id: 'audio_source', name: 'Audio file source', kind: 'audio', url: alternateAudio.path, loop: false, audio: { volume: 1, muted: true, mode: 'always', delayMs: 0 } });
  await json(await request.put(`${base}/api/studio`, { data: initial }));
  const saved = await content();
  saved.channels = [{ id: 'video_channel', name: 'Video presentation', kind: 'presentation', playlistId: 'video_playlist', defaultMode: 'manual' }];
  saved.playlists = [{ id: 'video_playlist', name: 'Video presentation', items: [{ id: 'video_slide', type: 'video', title: 'Welcome video', durationMs: 2000, background: { kind: 'video', src: video.libraryPath, fit: 'contain', muted: true } }] }];
  saved.music = { ...saved.music, current: audio.libraryPath, queue: [audio.libraryPath] };
  await json(await request.put(`${base}/api/content`, { data: saved }));
  const initialLive = live(await studio());
  const refresh = async () => { await page.getByRole('button', { name: 'Refresh media library', exact: true }).click(); await until(async () => !(await page.getByRole('button', { name: 'Refresh media library', exact: true }).isDisabled()), 'refresh finished'); };
  await refresh();
  const inspector = () => page.getByTestId('media-inspector');
  const tile = (id, scope = page) => scope.locator(`[data-asset-id=${JSON.stringify(id)}]`);
  const select = async id => { await tile(id).locator('.media-asset-button').click(); };
  const type = () => page.getByLabel('Media type', { exact: true });
  const list = await catalog();
  assert.equal(list.length, 7);
  for (const kind of ['image', 'video', 'audio']) {
    await type().selectOption(kind);
    assert.equal(await page.locator('[data-asset-id]').count(), list.filter(asset => asset.kind === kind).length);
  }
  await type().selectOption('video'); await select(video.id);
  await until(async () => inspector().locator('video').evaluate(element => element.readyState >= 1), 'video preview metadata');
  assert.equal(await inspector().locator('video').evaluate(element => element.paused), true, 'Video preview never autoplays');
  await inspector().locator('video').evaluate(async element => { window.__previousMediaPreview = element; element.muted = true; await element.play(); });
  await type().selectOption('audio'); await select(audio.id);
  assert.equal(await page.evaluate(() => window.__previousMediaPreview.paused), true, 'Changing selection pauses old preview');
  await until(async () => inspector().locator('audio').evaluate(element => element.readyState >= 1), 'audio preview metadata');
  assert.equal(await inspector().locator('audio').evaluate(element => element.paused), true, 'Audio preview never autoplays');
  assert.ok(await inspector().getByRole('button', { name: 'Delete', exact: true }).isDisabled());
  await page.getByTestId('media-filter-unused').click();
  assert.equal(await tile(audio.id).count(), 0);
  assert.equal(await page.locator('[data-asset-id]').count(), 1, 'Only the unused private audio import remains');
  await page.getByTestId('media-filter-all').click(); await type().selectOption('all');
  checks.push('All types, private Clip imports, filtered usage, and manual preview lifecycle');

  await select(video.id); await inspector().getByRole('link', { name: /^Open Presentation:/ }).click();
  const slide = page.getByRole('dialog', { name: 'Edit slide', exact: true }); await slide.waitFor();
  await slide.getByRole('button', { name: 'Choose from Media', exact: true }).click();
  let picker = page.getByRole('dialog', { name: 'Choose a video', exact: true }); await picker.waitFor();
  await picker.locator('[data-asset-id]').first().waitFor();
  assert.equal(await picker.locator('[data-asset-id]').count(), 2, 'Video picker contains only shared videos');
  const replacementVideo = (await catalog()).find(asset => asset.libraryPath === alternateVideo.path);
  await tile(replacementVideo.id, picker).locator('.media-asset-button').click();
  await picker.getByRole('button', { name: 'Use video', exact: true }).click();
  await slide.getByRole('button', { name: 'Save', exact: true }).click(); await slide.waitFor({ state: 'hidden' });
  await until(async () => (await content()).playlists[0].items[0].background.src === alternateVideo.path, 'video slide reused');
  await page.getByRole('link', { name: 'Back to Media', exact: true }).click();
  await until(async () => await inspector().getByRole('button', { name: 'Delete', exact: true }).isEnabled(), 'old video released');
  const replacementAudio = (await catalog()).find(asset => asset.libraryPath === alternateAudio.path);
  await select(replacementAudio.id); await inspector().getByRole('link', { name: /^Open Studio source:/ }).click();
  const source = page.getByRole('dialog', { name: 'Source properties', exact: true }); await source.waitFor();
  await source.getByRole('button', { name: 'Choose from Media', exact: true }).click();
  picker = page.getByRole('dialog', { name: 'Choose an audio file', exact: true }); await picker.waitFor();
  await picker.locator('[data-asset-id]').first().waitFor();
  assert.equal(await picker.locator('[data-asset-id]').count(), 2, 'Audio picker contains only shared audio files');
  await tile(audio.id, picker).locator('.media-asset-button').click(); await picker.getByRole('button', { name: 'Use audio', exact: true }).click();
  await source.getByRole('button', { name: 'Save changes', exact: true }).click(); await source.waitFor({ state: 'hidden' });
  await until(async () => (await studio()).sources.find(value => value.id === 'audio_source').url === audio.libraryPath, 'audio source reused');
  assert.deepEqual(live(await studio()), initialLive, 'Picker edits do not publish or alter live controls');
  await page.getByRole('link', { name: 'Back to Media', exact: true }).click();
  checks.push('Video presentation and audio source reuse stay type-specific and do not Take');

  await select(audio.id); await inspector().getByRole('link', { name: /^Open Music:/ }).first().click();
  const music = page.getByRole('dialog', { name: 'Music queue', exact: true }); await music.waitFor();
  assert.equal(await music.locator('[data-media-track]').count(), 1);
  assert.deepEqual((await content()).music, saved.music, 'Opening music usage does not change queue/current track');
  await music.getByRole('button', { name: /^Remove .* from music$/ }).click();
  await page.getByRole('dialog', { name: 'Remove track from music?', exact: true }).getByRole('button', { name: 'Remove track', exact: true }).click();
  await until(async () => !(await content()).music.current && !(await content()).music.queue.length, 'current and queued music references cleared');
  await music.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('link', { name: 'Back to Media', exact: true }).click();
  await until(async () => await inspector().getByRole('button', { name: 'Delete', exact: true }).isDisabled(), 'remaining source still protects music file');
  checks.push('Music usage opens exact queue and removes current/queue references while preserving other usages');

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await tile(video.id).getByRole('checkbox').check(); await tile(replacementAudio.id).getByRole('checkbox').check(); await tile(audio.id).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Delete unused (2)', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete 2 unused files?', exact: true }).getByRole('button', { name: 'Delete 2 files', exact: true }).click();
  await until(async () => !(await catalog()).some(asset => asset.id === video.id || asset.id === replacementAudio.id), 'mixed unused cleanup');
  assert.ok((await catalog()).some(asset => asset.id === audio.id), 'Used audio survives mixed selection');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  checks.push('Mixed video/audio bulk cleanup removes only unused selections');
  await page.goto(base);
  const miniPlayer = page.locator('.music-mini-player:visible').first();
  await miniPlayer.getByTitle('Open queue', { exact: true }).click();
  const queuePopover = page.locator('[data-slot="popover-content"]').filter({ hasText: 'Music queue' });
  await queuePopover.getByRole('button', { name: 'Choose from Media', exact: true }).click();
  picker = page.getByRole('dialog', { name: 'Choose an audio file', exact: true }); await picker.waitFor();
  await tile(audio.id, picker).locator('.media-asset-button').click();
  await picker.getByRole('button', { name: 'Use audio', exact: true }).click();
  await until(async () => (await content()).music.queue.includes(audio.libraryPath), 'shared audio added to music queue');
  assert.deepEqual(live(await studio()), initialLive, 'Choosing music does not publish or start playback');
  await page.goto(`${base}/media`); await page.getByRole('heading', { name: 'Media library', exact: true }).waitFor();
  await tile(audio.id).waitFor(); await select(audio.id);
  checks.push('Music queue reuses shared audio without uploading or starting playback');
  await page.screenshot({ path: path.join(dir, 'media-types-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'All media controls fit mobile width');
  await page.screenshot({ path: path.join(dir, 'media-types-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(logs.slice(-5000)); console.error(`Media type artifacts: ${dir}`); throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped; }
}
