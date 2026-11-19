// Exact Media usage links run against a disposable station and generated media.
// Nothing connects to the operator's station, inputs, or saved content.
// Run after npm run build: node backend/test/media-navigation-browser.mjs
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
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-media-navigation-'));
const port = Number(process.env.LUMEN_MEDIA_NAVIGATION_TEST_PORT ?? 3497), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
const recordingId = 'rec_media_navigation', recordedFile = path.join(directory, 'recordings', recordingId, 'recording.webm');
const imagePath = 'media/backgrounds/navigation.png';
let server, browser, page, logs = '';
const errors = [], checks = [];
async function until(operation, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await operation(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function start() {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...environment, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base, LUMEN_CHROME_PATH: executablePath },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station starts');
}
async function stop() {
  const child = server; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 6000).unref(); });
}
async function json(response, status = 200) { assert.equal(response.status(), status, await response.text()); return response.json(); }
function layer(id, patch = {}) { return { id, name: id, kind: 'text', visible: true, locked: false, x: 0, y: 0, width: 100, height: 100, opacity: 1,
  fit: 'cover', text: 'Navigation fixture', color: '#ffffff', background: '#00000000', fontSize: 54, fontWeight: 500, align: 'center', radius: 0, ...patch }; }
function item(id, name, source, startMs = 0) { return { id, name, kind: source.kind === 'recording' ? 'video' : 'image', source, startMs, inMs: 0, durationMs: source.kind === 'recording' ? 2000 : 1000,
  x: 0, y: 0, width: 1, height: 1, fit: 'contain', positionX: .5, positionY: .5, opacity: 1, volume: 0, muted: true, text: '', fontSize: 64, fontWeight: 600, color: '#ffffff', background: '#00000000', align: 'center' }; }

try {
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  await fs.mkdir(path.dirname(recordedFile), { recursive: true });
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '2', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', recordedFile]);
  const recordedBytes = (await fs.stat(recordedFile)).size;
  await fs.writeFile(path.join(path.dirname(recordedFile), 'recording.json'), JSON.stringify({ id: recordingId, name: 'Media navigation recording', status: 'complete', createdAt: new Date().toISOString(), durationMs: 2000, bytes: recordedBytes, nextChunk: 1 }));
  await fs.mkdir(path.join(directory, 'media/backgrounds'), { recursive: true });
  const image = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#287c59' } }).png().toBuffer();
  await fs.writeFile(path.join(directory, imagePath), image);
  await start();
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  context.setDefaultTimeout(15000);
  const request = context.request;
  // Keep request promises explicit so assertion diagnostics include the response.
  await json(await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  const seeded = await json(await request.put(`${base}/api/content`, { data: {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [
      { id: 'lyrics', name: 'Lyrics', kind: 'lyrics', playlistId: 'p_lyrics', defaultMode: 'manual' },
      { id: 'alpha', name: 'Alpha presentation', kind: 'presentation', playlistId: 'p_alpha', defaultMode: 'manual' },
    ],
    playlists: [
      { id: 'p_lyrics', name: 'Lyrics archive', items: [] },
      { id: 'p_alpha', name: 'Alpha presentation', items: [
        { id: 'first', type: 'text', title: 'Live first slide', body: 'Live first slide' },
        { id: 'image_slide', type: 'image', title: 'Image slide target', background: { kind: 'image', src: imagePath } },
      ] },
      { id: 'p_orphan', name: 'Archived playlist', items: [{ id: 'orphan_slide', type: 'image', title: 'Orphan image target', background: { kind: 'image', src: imagePath } }] },
    ],
    sources: [{ id: 'routing_alpha', kind: 'channel', ref: 'alpha' }], destinations: [], routes: [], program: { programSourceId: 'routing_alpha', previewSourceId: null },
  } }));
  const getStudio = () => request.get(`${base}/api/studio`).then(response => json(response));
  const studio = await getStudio();
  studio.sources = ['image_one', 'image_two'].map(id => ({ id, name: id === 'image_one' ? 'First image source' : 'Second image source', kind: 'image', url: imagePath, loop: false, audio: { muted: true, volume: 1, mode: 'follow', delayMs: 0 } }));
  studio.scenes = [{ id: 'live', name: 'Live scene', background: '#001122', layers: [layer('live_image', { kind: 'source', sourceId: 'image_one' })] },
    { id: 'target', name: 'Target scene', background: '#002244', layers: [layer('background_target', { name: 'Target background layer', mediaBackground: { kind: 'image', url: imagePath, fit: 'cover', dim: 0, loop: false } })] }];
  studio.previewSceneId = 'live';
  await json(await request.put(`${base}/api/studio`, { data: studio }));
  await json(await request.post(`${base}/api/studio/command`, { data: { revision: (await getStudio()).revision, command: { type: 'take', sceneId: 'live' } } }));
  const state = await getStudio();
  const outputId = state.outputs[0].id;
  await json(await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: { type: 'route', outputId, sceneId: 'target' } } }));
  const asset = await json(await request.post(`${base}/api/clips/assets`, { multipart: { file: { name: 'Navigation clip image.png', mimeType: 'image/png', buffer: image }, durationMs: '0', width: '160', height: '90' } }), 201);
  const timeline = { version: 1, background: '#000000', tracks: [
    { id: 'main', name: 'Main video', kind: 'video', hidden: false, muted: true, locked: false, items: [item('video_item', 'Original recording', { kind: 'recording', id: recordingId })] },
    { id: 'overlay', name: 'Images', kind: 'video', hidden: false, muted: true, locked: false, items: [item('image_item', 'Exact image target', { kind: 'asset', id: asset.id }, 500)] },
  ] };
  const draft = await json(await request.post(`${base}/api/clips/drafts`, { data: { recordingId, name: 'Navigation project', inMs: 0, outMs: 2000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5, timeline } }), 201);
  await stop();
  const indexFile = path.join(directory, 'clips/clips.json');
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  const settings = Object.fromEntries(['inMs', 'outMs', 'format', 'fit', 'positionX', 'positionY', 'timeline'].map(key => [key, draft[key]]));
  index.exports.push({ id: 'export_media_navigation', draftId: draft.id, draftRevision: draft.revision, recordingId, ownerId: draft.ownerId,
    name: 'Exact export target', status: 'complete', progress: 1, bytes: recordedBytes, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), settings });
  await fs.writeFile(indexFile, JSON.stringify(index));
  await fs.copyFile(recordedFile, path.join(directory, 'clips/exports/export_media_navigation.mp4'));
  await start();
  await json(await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  const before = await getStudio();
  const liveState = value => ({ program: value.program, programTransition: value.programTransition, outputs: value.outputs, mainAudioSourceId: value.mainAudioSourceId, masterVolume: value.masterVolume, masterMuted: value.masterMuted, channelInsert: value.channelInsert });
  const unchangedLive = async label => {
    assert.deepEqual(liveState(await getStudio()), liveState(before), `${label}: Program, pinned outputs and audio remain unchanged`);
    const content = await json(await request.get(`${base}/api/content`));
    assert.deepEqual(content.program, seeded.program, `${label}: content routing remains unchanged`);
    assert.deepEqual(content.playlists, seeded.playlists, `${label}: merely opening an editor never edits content`);
  };
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const navigate = target => page.evaluate(target => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(target), target);
  const targetUrl = params => `${params}${params.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent('/media?asset=library-navigation')}&from=media`;
  await page.goto(base);
  await page.getByRole('button', { name: 'Lyrics — lyrics', exact: true }).waitFor();
  await navigate(targetUrl('/?channel=alpha&slide=image_slide'));
  let dialog = page.getByRole('dialog', { name: 'Edit slide', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('input').first().inputValue(), 'Image slide target');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).searchParams.has('slide'), false, 'Consumed slide query does not reopen the dialog');
  await unchangedLive('Presentation reference from previously focused Lyrics');
  checks.push('Presentation deep link works when Worship was focused, without changing playback');
  await navigate(targetUrl('/?playlist=p_orphan&slide=orphan_slide'));
  await dialog.waitFor();
  assert.equal(await dialog.locator('input').first().inputValue(), 'Orphan image target');
  await page.keyboard.press('Escape');await dialog.waitFor({ state: 'hidden' });
  await unchangedLive('Orphan playlist reference');
  checks.push('Orphan playlist opens its exact slide without creating a channel');
  await navigate(targetUrl('/studio?source=image_one'));
  dialog = page.getByRole('dialog', { name: 'Source properties', exact: true });await dialog.waitFor();
  assert.equal(await dialog.getByPlaceholder('Name this source', { exact: true }).inputValue(), 'First image source');
  await page.keyboard.press('Escape');await dialog.waitFor({ state: 'hidden' });
  await navigate(targetUrl('/studio?source=image_two'));await dialog.waitFor();
  assert.equal(await dialog.getByPlaceholder('Name this source', { exact: true }).inputValue(), 'Second image source');
  await page.keyboard.press('Escape');await dialog.waitFor({ state: 'hidden' });
  await page.evaluate(() => { window.__mediaNavigationStudio = document.querySelector('.studio-app'); });
  await page.getByRole('link', { name: 'Open Media library', exact: true }).click();
  await page.getByRole('heading', { name: 'Media library', exact: true }).waitFor();
  await page.locator('body').click({ position: { x: 2, y: 2 } });await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.studio-app') === window.__mediaNavigationStudio), true, 'Media return retains the cached Studio DOM');
  await unchangedLive('Media dock round trip and Space key');
  checks.push('Exact source properties, repeated same-route navigation, cached Studio retained through Media');
  await navigate(targetUrl('/studio?scene=target&layer=background_target'));
  await until(() => page.getByLabel('Layer name', { exact: true }).inputValue().then(value => value === 'Target background layer'), 'exact layer selected');
  assert.equal((await getStudio()).previewSceneId, 'target');
  await unchangedLive('Scene/layer reference');
  await navigate(targetUrl('/studio?output=program'));
  await page.getByRole('button', { name: 'Clear Program', exact: true }).waitFor();
  await navigate(targetUrl(`/studio?output=${outputId}`));
  await page.getByText('This pinned output still holds the image.', { exact: false }).waitFor();
  await unchangedLive('Program and pinned output reference');
  checks.push('Layer reference selects Preview only; Program and pinned output links only reveal controls');
  await navigate(targetUrl(`/recordings/${recordingId}/editor?draft=${draft.id}&item=image_item&play=1`));
  await until(() => page.locator('[data-item-id="image_item"]').getAttribute('aria-pressed').then(value => value === 'true'), 'exact timeline image selected');
  assert.equal(await page.getByLabel('Timeline clip name', { exact: true }).inputValue(), 'Exact image target');
  assert.equal(await page.getByRole('button', { name: 'Pause', exact: true }).count(), 0, 'Media reference never autoplays');
  await page.getByRole('link', { name: 'Back to Media', exact: true }).click();
  await page.getByRole('heading', { name: 'Media library', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('asset'), 'library-navigation', 'Return keeps the requested Media image selection');
  await navigate(targetUrl('/recordings?export=export_media_navigation'));
  const exported = page.locator('[data-export-id="export_media_navigation"]');await exported.waitFor();
  assert.ok((await exported.getAttribute('style')).includes('border-color'), 'Exact export is visibly highlighted');
  await page.getByRole('heading', { name: 'Previous exports', exact: true }).waitFor();
  await unchangedLive('Clip and export reference');
  await navigate('/switch?from=media');
  await page.getByRole('button', { name: 'Back to Media', exact: true }).waitFor();
  await navigate('/media');
  await page.getByRole('heading', { name: 'Media library', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.studio-app') === window.__mediaNavigationStudio), true, 'Media usage destinations retain Studio, including Clips, exports and routing sources');
  await unchangedLive('All Media usage destination round trips');
  checks.push('Exact clip image selected paused; exact export shown; safe asset-specific Back to Media');
  await navigate('/studio?source=does-not-exist&from=media');
  await page.getByText('This source no longer exists. Refresh its usage in Media.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Source properties', exact: true }).count(), 0);
  await unchangedLive('Removed usage destination');
  checks.push('Stale source link gives recoverable feedback and never opens another source');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', directory, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(logs.slice(-5000)); console.error(`Navigation artifacts: ${directory}`); throw error;
} finally { await browser?.close(); await stop(); }
