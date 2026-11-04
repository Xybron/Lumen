// Run after npm run build. All content, media and reorder writes belong to this
// disposable station. Never opens physical inputs or an operator's session.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-scene-sidebar-'));
const port = await new Promise((resolve, reject) => {
  const listener = net.createServer(); listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
await fs.mkdir(path.join(dir, 'media/backgrounds'), { recursive: true });
await fs.mkdir(path.join(dir, 'media/thumbnails'), { recursive: true });
const picture = (color, output) => sharp({ create: { width: 160, height: 90, channels: 3, background: color } }).jpeg().toFile(path.join(dir, output));
await picture('#70a060', 'media/backgrounds/sidebar-green.jpg');
await picture('#d28050', 'media/backgrounds/sidebar-orange.jpg');
await picture('#70a060', 'media/thumbnails/sidebar-green.jpg');
await picture('#d28050', 'media/thumbnails/sidebar-orange.jpg');
await fs.writeFile(path.join(dir, 'media/backgrounds/sidebar-video.mp4'), 'This is a poster-only fixture; no video decoder should open it.');
await picture('#627ce0', 'media/thumbnails/sidebar-video.jpg');

let browser, logs = '', passed = false;
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const pipe of [server.stdout, server.stderr]) pipe.on('data', data => { logs = (logs + data).slice(-10000); });
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function json(response) { assert.ok(response.ok(), await response.text()); return response.json(); }

try {
  await until(async () => (await fetch(base + '/api/content').catch(() => null))?.ok, 'temporary station startup');
  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.LUMEN_CHROME_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const api = context.request, errors = [], requests = [];
  await json(await api.post(base + '/api/auth/login', { data: { username: 'admin', password: 'admin' } }));
  const content = {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [
      { id: 'sidebar_lyrics', name: 'Sidebar Lyrics', kind: 'lyrics', playlistId: 'lyrics_list', defaultMode: 'manual' },
      { id: 'sidebar_scripture', name: 'Sidebar Scripture', kind: 'scripture', playlistId: 'scripture_list', defaultMode: 'manual' },
      { id: 'sidebar_slides', name: 'Sidebar Slides', kind: 'presentation', playlistId: 'slides_list', defaultMode: 'manual' },
    ],
    playlists: [
      { id: 'lyrics_list', name: 'Lyrics', items: [] },
      { id: 'scripture_list', name: 'Scripture', items: [] },
      { id: 'slides_list', name: 'Slides', items: [{ id: 'sidebar_slide', type: 'image', title: 'Welcome image', durationMs: 30000, background: { kind: 'image', src: 'media/backgrounds/sidebar-green.jpg' } }] },
    ],
  };
  await json(await api.put(base + '/api/content', { data: content }));
  await json(await api.post(base + '/api/worship/versions/import', { data: {
    version: { id: 'SIDEBAR', name: 'Sidebar fixture', language: 'en', attribution: 'Original test text' },
    verses: [{ book: 1, chapter: 1, verse: 1, text: 'Published scripture in the scene thumbnail' }],
  } }));
  const song = await json(await api.post(base + '/api/worship/songs', { data: {
    title: 'Sidebar song', showSectionLabels: false, sections: [
      { id: 'first', label: 'Verse 1', text: 'Published lyrics in the scene thumbnail' },
      { id: 'next', label: 'Chorus', text: 'A new chorus appears in every scene' },
      { id: 'private', label: 'Verse 2', text: 'Private lyrics must stay off thumbnails' },
    ],
  } }));
  const worship = async (channel, command) => {
    const url = `${base}/api/worship/channels/${channel}`, state = await json(await api.get(url));
    return json(await api.post(url + '/command', { data: { revision: state.revision, command } }));
  };
  await worship('sidebar_lyrics', { type: 'take', selection: { kind: 'lyrics', songId: song.id, sectionId: 'first' } });
  await worship('sidebar_scripture', { type: 'take', selection: { kind: 'scripture', versionId: 'SIDEBAR', book: 1, chapter: 1, verse: 1 } });

  const studio = async () => json(await api.get(base + '/api/studio'));
  const save = async mutate => { const state = await studio(); mutate(state); return json(await api.put(base + '/api/studio', { data: state })); };
  const command = async command => { const state = await studio(); return json(await api.post(base + '/api/studio/command', { data: { revision: state.revision, command } })); };
  const source = (id, name, kind, extra = {}) => ({ id, name, kind, loop: false, audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 }, ...extra });
  const layer = (id, sourceId, extra = {}) => ({ id, name: id, kind: 'source', sourceId, visible: true, locked: false,
    x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'contain', text: '', color: '#ffffff', background: '#00000000', fontSize: 68, fontWeight: 500, align: 'center', radius: 0, ...extra });
  await save(state => {
    state.sources = [
      source('source_lyrics', 'Lyrics content', 'channel', { channelId: 'sidebar_lyrics' }),
      source('source_scripture', 'Scripture content', 'channel', { channelId: 'sidebar_scripture' }),
      source('source_slides', 'Presentation content', 'channel', { channelId: 'sidebar_slides' }),
      source('source_camera', 'Camera input', 'camera'),
      source('source_video', 'Video file', 'video', { url: 'media/backgrounds/sidebar-video.mp4' }),
    ];
    state.scenes = [
      { id: 'lyrics', name: 'Channel Lyrics', background: '#152432', layers: [layer('lyrics_layer', 'source_lyrics', { channelStyle: 'overlay' })] },
      { id: 'scripture', name: 'Channel Scripture', background: '#241532', layers: [layer('scripture_layer', 'source_scripture', { channelStyle: 'overlay' })] },
      { id: 'slides', name: 'Channel Slides', background: '#141b21', layers: [layer('slides_layer', 'source_slides')] },
      { id: 'camera', name: 'Camera with lyrics', background: '#17241b', layers: [layer('camera_layer', 'source_camera'), layer('lower_lyrics', 'source_lyrics', { channelStyle: 'overlay', y: 70, height: 30 })] },
      { id: 'video', name: 'Video poster', background: '#141b21', layers: [layer('video_layer', 'source_video')] },
    ];
    state.previewSceneId = 'slides';
  });
  await command({ type: 'take', sceneId: 'lyrics' });
  await command({ type: 'route', outputId: 'screen_main', sceneId: 'scripture' });
  const baseline = await studio();

  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  let delayInitialContent = true;
  await page.route('**/api/content', async route => {
    if (delayInitialContent && route.request().method() === 'GET') {
      delayInitialContent = false;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await route.continue();
  });
  await page.route('**/api/media/backgrounds', async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.continue();
  });
  await page.goto(base + '/studio');
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  const sidebar = page.locator('.scene-list'), card = id => sidebar.locator(`.scene-card[data-scene-id="${id}"]`);
  const poster = id => card(id).locator('.scene-poster');
  const order = () => sidebar.locator('.scene-card').evaluateAll(cards => cards.map(card => card.dataset.sceneId));
  const persisted = async expected => until(async () => JSON.stringify((await studio()).scenes.map(scene => scene.id)) === JSON.stringify(expected), 'saved scene order');
  const isolated = async label => {
    const state = await studio();
    assert.equal(state.previewSceneId, baseline.previewSceneId, `${label} preserves Preview selection`);
    assert.deepEqual(state.program, baseline.program, `${label} preserves live Program snapshot`);
    assert.deepEqual(state.outputs, baseline.outputs, `${label} preserves output routing`);
  };
  await until(async () => (await order()).length === 5, 'all scene cards');
  await page.getByRole('button', { name: 'Show compact scene list', exact: true }).click();
  await until(async () => (await poster('lyrics').textContent()).includes(song.sections[0].text), 'published lyrics thumbnail');
  await until(async () => (await poster('camera').textContent()).includes(song.sections[0].text), 'the same channel in another scene');
  await until(async () => (await poster('scripture').textContent()).includes('Published scripture in the scene thumbnail'), 'scripture thumbnail');
  await until(() => poster('slides').locator('img[src$="media/thumbnails/sidebar-green.jpg"]').evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0)), 'presentation image thumbnail');
  await until(() => poster('video').locator('img[src$="sidebar-video.jpg"]').evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0)), 'saved video poster');
  assert.equal(await sidebar.locator('video,audio,iframe').count(), 0, 'Scene cards never add video players, audio or channel iframes');
  assert.equal(requests.some(url => url.endsWith('sidebar-video.mp4')), false, 'Reading a video poster does not fetch or decode its video');
  assert.equal(requests.some(url => /media\/backgrounds\/sidebar-(green|orange)\.jpg$/.test(url)), false, 'Scene cards wait for saved thumbnails instead of downloading original images');
  await json(await api.post(base + '/api/worship/preview', { data: { kind: 'lyrics', songId: song.id, sectionId: 'private' } }));
  assert.equal((await sidebar.textContent()).includes(song.sections[2].text), false, 'A private Prepared cue does not leak into thumbnails');
  await worship('sidebar_lyrics', { type: 'take', selection: { kind: 'lyrics', songId: song.id, sectionId: 'next' } });
  await until(async () => (await poster('lyrics').textContent()).includes(song.sections[1].text) && (await poster('camera').textContent()).includes(song.sections[1].text), 'published chorus updates shared channel thumbnails');
  await worship('sidebar_lyrics', { type: 'blank', value: true });
  await until(async () => !(await poster('lyrics').textContent()).includes(song.sections[1].text) && !(await poster('camera').textContent()).includes(song.sections[1].text), 'blanked channel clears all thumbnails');
  await worship('sidebar_lyrics', { type: 'blank', value: false });
  await until(async () => (await poster('lyrics').textContent()).includes(song.sections[1].text), 'unblanked thumbnail');

  const nextContent = await json(await api.get(base + '/api/content'));
  nextContent.playlists.find(list => list.id === 'slides_list').items[0] = { id: 'sidebar_slide', type: 'text', title: 'Updated welcome', body: 'Presentation content also updates here', durationMs: 30000, background: { kind: 'image', src: 'media/backgrounds/sidebar-orange.jpg' } };
  const savedContent = await json(await api.put(base + '/api/content', { data: nextContent }));
  // Content writes notify other operator windows through this existing relay.
  const cookie = (await context.cookies(base)).map(value => `${value.name}=${value.value}`).join('; ');
  await new Promise((resolve, reject) => {
    const publisher = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
    publisher.once('error', reject);
    publisher.once('open', () => publisher.send(JSON.stringify({ t: 'content-updated', updatedAt: savedContent.updatedAt }), error => {
      publisher.close(); if (error) reject(error); else resolve();
    }));
  });
  await until(async () => (await poster('slides').textContent()).includes('Presentation content also updates here'), 'updated presentation text');
  await until(() => poster('slides').locator('img[src$="media/thumbnails/sidebar-orange.jpg"]').evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0)), 'updated presentation art');
  assert.equal(requests.some(url => /media\/backgrounds\/sidebar-(green|orange)\.jpg$/.test(url)), false, 'Presentation changes reuse the shared thumbnail catalog');

  // Sortable's native desktop drag starts from the visible grip. The actual
  // pointer movement covers both the native and fallback drag implementations.
  async function drag(id, targetId, placement) {
    await card(id).scrollIntoViewIfNeeded();
    const grip = await card(id).locator('.scene-drag-handle').boundingBox();
    await card(targetId).scrollIntoViewIfNeeded();
    const target = await card(targetId).boundingBox();
    assert.ok(grip && target);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 8, grip.y + grip.height / 2 + 8, { steps: 4 });
    await page.mouse.move(target.x + target.width / 2, target.y + (placement === 'before' ? 5 : target.height - 5), { steps: 15 });
    await page.waitForTimeout(180);
    await page.mouse.up();
  }
  await drag('video', 'lyrics', 'before');
  const compactOrder = ['video', 'lyrics', 'scripture', 'slides', 'camera'];
  await persisted(compactOrder); assert.deepEqual(await order(), compactOrder); await isolated('Compact drag');
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  await until(async () => JSON.stringify(await order()) === JSON.stringify(compactOrder), 'reordered scenes after reload');
  await page.getByRole('button', { name: 'Show scene thumbnails', exact: true }).click();
  await drag('lyrics', 'video', 'before');
  const thumbnailOrder = ['lyrics', 'video', 'scripture', 'slides', 'camera'];
  await persisted(thumbnailOrder); await isolated('Thumbnail drag');
  await page.getByRole('button', { name: 'Show compact scene list', exact: true }).click();
  await page.getByLabel('Find a scene', { exact: true }).fill('Channel');
  assert.deepEqual(await order(), ['lyrics', 'scripture', 'slides']);
  await card('slides').focus(); await page.keyboard.press('Alt+ArrowUp');
  const filteredOrder = ['lyrics', 'video', 'slides', 'scripture', 'camera'];
  await persisted(filteredOrder); assert.deepEqual(await order(), ['lyrics', 'slides', 'scripture']);
  await isolated('Filtered keyboard move');
  await page.getByLabel('Find a scene', { exact: true }).fill('');
  assert.deepEqual(await order(), filteredOrder, 'Hidden scenes retain their relative order');
  await card('lyrics').focus();
  const beforeEdge = (await studio()).revision;
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForTimeout(150);
  assert.equal((await studio()).revision, beforeEdge, 'Moving the first scene up is a no-op');
  assert.equal(await sidebar.locator('video,audio,iframe').count(), 0);
  assert.equal(requests.some(url => url.endsWith('sidebar-video.mp4')), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/private/tmp/lumen-scene-sidebar.png' });
  console.log('Passed: compact/thumbnail drag, persisted order, filtered keyboard reordering, Preview/Program/output isolation, current channel content, private/blanked cues, still media posters and no thumbnail video players.');
  passed = true;
} catch (error) {
  console.error(error, logs, 'Station fixture:', dir); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) { const exit = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exit; }
  if (passed) await fs.rm(dir, { recursive: true, force: true });
}
