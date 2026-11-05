// Run after npm run build. All data/media and the renderer are disposable.
// Camera-source fixtures are never connected to physical devices.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-text-padding-'));
const port = Number(process.env.LUMEN_TEXT_PADDING_TEST_PORT ?? 3466), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
const mediaDir = path.join(dir, 'media', 'backgrounds'); await fs.mkdir(mediaDir, { recursive: true });
const mediaPath = 'media/backgrounds/padding-fixture.png';
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x172b3d:s=320x180', '-frames:v', '1', path.join(dir, mediaPath)]);
let logs = '', browser, page, request, releaseHeldSave, engineRunning = false;
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
const checks = [], errors = [];
async function until(fn, label, timeout = 10000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const withoutPadding = ({ textPadding, ...layer }) => layer;
const paddingValues = ({ top, right, bottom, left }) => ({ top, right, bottom, left });
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station starts', 30000);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 } }); request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const content = { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: ['lyrics', 'scripture', 'presentation'].map(kind => ({ id: kind, name: kind, kind, playlistId: `p_${kind}`, defaultMode: 'manual' })),
    playlists: ['lyrics', 'scripture', 'presentation'].map(kind => ({ id: `p_${kind}`, name: kind, items: [] })) };
  const seeded = await request.put(`${base}/api/content`, { data: content }); assert.equal(seeded.status(), 200, await seeded.text());
  const song = await request.post(`${base}/api/worship/songs`, { data: { id: 'padding_song', title: 'Padding fixture', sections: [{ id: 'verse', label: 'Verse', text: 'PADDING TEST' }] } });
  assert.equal(song.status(), 201, await song.text());
  const worship = await (await request.get(`${base}/api/worship/channels/lyrics`)).json();
  const cue = await request.post(`${base}/api/worship/channels/lyrics/command`, { data: { revision: worship.revision, command: { type: 'take', selection: { kind: 'lyrics', songId: 'padding_song', sectionId: 'verse' } } } });
  assert.equal(cue.status(), 200, await cue.text());
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const save = async mutate => {
    const document = await get(); mutate(document);
    const response = await request.put(`${base}/api/studio`, { data: document });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const command = async command => {
    const document = await get(), response = await request.post(`${base}/api/studio/command`, { data: { revision: document.revision, command } });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const sceneId = 'padding_scene', otherId = 'padding_other', lyricsId = 'padding_lyrics';
  const layer = (id, kind, patch = {}) => ({ id, name: id, kind, visible: false, locked: false,
    x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'contain', text: 'Plain text fixture', color: '#7dd3fc', background: '#14212b',
    fontSize: 88, fontWeight: 600, align: 'left', verticalAlign: 'top', radius: 0, ...patch });
  await save(document => {
    const audio = { muted: true, volume: 1, mode: 'follow', delayMs: 0 };
    for (const channelId of ['lyrics', 'scripture', 'presentation']) document.sources.push({ id: `source_${channelId}`, name: channelId, kind: 'channel', channelId, loop: false, audio });
    document.sources.push({ id: 'source_image', name: 'Synthetic image', kind: 'image', url: mediaPath, loop: false, audio });
    document.sources.push({ id: 'source_camera', name: 'Unconnected camera fixture', kind: 'camera', loop: false, audio });
    document.scenes.push({ id: sceneId, name: 'Lyrics text padding', background: '#101317', layers: [
      layer(lyricsId, 'source', { sourceId: 'source_lyrics', name: 'Lyrics', visible: true, channelStyle: 'overlay', mediaBackground: { kind: 'image', url: mediaPath, fit: 'cover', dim: .1, loop: false } }),
      layer('padding_plain', 'text'), layer('padding_shape', 'shape'),
      layer('padding_resized', 'text', { width: 5, height: 5, textPadding: { top: 100, right: 100, bottom: 100, left: 100, linked: false } }),
      layer('padding_image', 'source', { sourceId: 'source_image' }), layer('padding_camera', 'source', { sourceId: 'source_camera' }),
      layer('padding_slide', 'source', { sourceId: 'source_presentation', channelStyle: 'slide' }),
      layer('padding_overlay', 'source', { sourceId: 'source_presentation', channelStyle: 'overlay' }),
      layer('padding_scripture', 'source', { sourceId: 'source_scripture' }),
    ] });
    document.scenes.push({ id: otherId, name: 'Independent scene', background: '#101317', layers: [layer('padding_other_text', 'text', { visible: true })] });
    document.previewSceneId = sceneId;
  });
  await command({ type: 'take', sceneId }); await command({ type: 'route', outputId: 'screen_main', sceneId });
  const baseline = await get(), initialLayer = baseline.scenes.find(scene => scene.id === sceneId).layers.find(item => item.id === lyricsId);
  const getLayer = async (id = lyricsId, scene = sceneId) => (await get()).scenes.find(item => item.id === scene).layers.find(item => item.id === id);
  const unchangedLive = async () => {
    const state = await get(); assert.deepEqual(state.program, baseline.program, 'Padding edits never publish Program');
    assert.deepEqual(state.outputs, baseline.outputs, 'Pinned outputs preserve their committed padding');
    assert.deepEqual(state.sources, baseline.sources, 'Text padding never changes shared sources');
  };
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`Unexpected native ${dialog.type()} dialog`); void dialog.dismiss(); });
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await page.getByRole('button', { name: 'Show compact scene list', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Design inspector' });
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  const row = id => page.locator(`.layer-row[data-layer-id="${id}"]`);
  const sceneCard = id => page.locator(`.scene-card[data-scene-id="${id}"]`);
  const select = async (id = lyricsId, scene = sceneId) => {
    if (await sceneCard(scene).getAttribute('aria-pressed') !== 'true') await sceneCard(scene).click();
    await row(id).click(); await until(() => row(id).getAttribute('aria-selected').then(value => value === 'true'), `select ${id}`);
  };
  const field = side => inspector.getByLabel(`${side[0].toUpperCase() + side.slice(1)} text padding`, { exact: true });
  const edit = async (side, value) => { await field(side).fill(String(value)); await field(side).press('Enter'); };
  const link = () => inspector.getByRole('button', { name: 'Link text padding sides', exact: true });
  const unlink = () => inspector.getByRole('button', { name: 'Unlink text padding sides', exact: true });
  const previewLayer = () => page.locator(`.preview-panel .poster-layer[data-layer-id="${lyricsId}"]`);
  const geometry = () => previewLayer().evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { layer: rect(element), background: rect(element.querySelector('.layer-media-background')), fill: getComputedStyle(element).backgroundColor,
      media: element.querySelector('.layer-media-background').getAttribute('src'), dim: element.querySelector('.layer-media-dim').style.opacity };
  });
  await select(); await field('top').waitFor();
  await previewLayer().locator('.layer-media-background').waitFor();
  const originalGeometry = await geometry();
  assert.equal((await getLayer()).textPadding, undefined, 'Selecting legacy text does not persist a new padding default');
  for (const id of ['padding_plain', 'padding_scripture', 'padding_overlay']) { await select(id); assert.equal(await field('top').isVisible(), true, `${id} supports text padding`); }
  for (const id of ['padding_shape', 'padding_image', 'padding_camera', 'padding_slide']) { await select(id); assert.equal(await field('top').count(), 0, `${id} must not show text-only controls`); }
  await select('padding_resized'); await link().click();
  await until(async () => (await getLayer('padding_resized')).textPadding.linked === true, 'link preference saves on a resized layer');
  assert.deepEqual(paddingValues((await getLayer('padding_resized')).textPadding), { top: 100, right: 100, bottom: 100, left: 100 }, 'Linking never rewrites stored inset values after resizing');
  await unlink().click(); await until(async () => (await getLayer('padding_resized')).textPadding.linked === false, 'unlink resized layer');
  await inspector.getByLabel('Width', { exact: true }).fill('480'); await inspector.getByLabel('Width', { exact: true }).press('Enter');
  await inspector.getByLabel('Height', { exact: true }).fill('324'); await inspector.getByLabel('Height', { exact: true }).press('Enter');
  await until(async () => { const layer = await getLayer('padding_resized'); return layer.width === 25 && layer.height === 30; }, 'resized layer expands again');
  for (const side of ['top', 'right', 'bottom', 'left']) assert.equal(Number(await field(side).inputValue()), 100, 'Expanding restores the original insets after link/unlink');
  await select();
  if (await link().count()) await link().click();
  await edit('top', 96);
  await until(async () => JSON.stringify(paddingValues((await getLayer()).textPadding)) === JSON.stringify({ top: 96, right: 96, bottom: 96, left: 96 }), 'linked value updates all four sides');
  await inspector.getByRole('button', { name: 'Reset text padding', exact: true }).click();
  await until(async () => (await getLayer()).textPadding === undefined, 'Reset removes custom padding and restores legacy layout');
  assert.equal(Number(await field('left').inputValue()), 30);
  await edit('top', 96); await until(async () => (await getLayer()).textPadding?.left === 96, 'linked padding reapplied after reset');
  await unlink().click(); await edit('left', 320); await edit('right', 80);
  await until(async () => (await getLayer()).textPadding.left === 320 && (await getLayer()).textPadding.right === 80, 'independent left/right values save');
  const mixed = paddingValues((await getLayer()).textPadding);
  await link().click(); await until(async () => (await getLayer()).textPadding.linked === true, 'link preference saves');
  assert.deepEqual(paddingValues((await getLayer()).textPadding), mixed, 'Relinking unequal sides does not alter padding');
  await edit('bottom', 64);
  await until(async () => Object.values(paddingValues((await getLayer()).textPadding)).every(value => value === 64), 'next linked edit unifies all sides');
  await unlink().click(); await until(async () => (await getLayer()).textPadding.linked === false, 'unlink preference saves');
  checks.push('text-only applicability, legacy defaults, linked edits, independent sides and non-destructive relinking');

  // A link click is immediate operator intent, even while an earlier side
  // save is pending. The following value and rapid toggles must use that mode.
  let modeSaveStarted = false; const modeHeld = new Promise(resolve => { releaseHeldSave = resolve; });
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT' || modeSaveStarted) return route.continue();
    modeSaveStarted = true; await modeHeld; return route.continue();
  });
  await edit('top', 100); await until(() => modeSaveStarted, 'save before link intent is delayed');
  await link().click(); await edit('right', 120); await unlink().click(); await link().click();
  releaseHeldSave(); releaseHeldSave = null;
  await until(async () => {
    const padding = (await getLayer()).textPadding;
    return padding.linked === true && Object.values(paddingValues(padding)).every(value => value === 120);
  }, 'queued linked edit and two toggles preserve the intended mode');
  await page.unroute('**/api/studio');
  await unlink().click(); await until(async () => (await getLayer()).textPadding.linked === false, 'separate mode restored');
  checks.push('link intent and repeated toggles apply immediately while saves are delayed');

  // Queue several side edits behind one held request, then change scenes.
  // The updates must merge with each other and retain their original target.
  let saveStarted = false; const held = new Promise(resolve => { releaseHeldSave = resolve; });
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT' || saveStarted) return route.continue();
    saveStarted = true; await held; return route.continue();
  });
  await edit('top', 160); await until(() => saveStarted, 'top padding save is delayed');
  await edit('right', 80); await edit('bottom', 64); await edit('left', 320); await sceneCard(otherId).click();
  releaseHeldSave(); releaseHeldSave = null;
  const expected = { top: 160, right: 80, bottom: 64, left: 320, linked: false };
  await until(async () => (await get()).previewSceneId === otherId && JSON.stringify((await getLayer()).textPadding) === JSON.stringify(expected), 'all queued side edits reach the original layer');
  await page.unroute('**/api/studio');
  assert.equal((await getLayer('padding_other_text', otherId)).textPadding, undefined, 'Scene switching cannot apply padding to the other layer');
  await select(); assert.deepEqual(withoutPadding(await getLayer()), withoutPadding(initialLayer), 'Padding changes no geometry, fill, media, or typography');
  assert.deepEqual(await geometry(), originalGeometry, 'Padding leaves Preview background and layer bounds unchanged');
  for (const scope of [page.locator('.preview-panel'), sceneCard(sceneId)]) {
    const region = scope.locator(`.poster-layer[data-layer-id="${lyricsId}"] .poster-channel-text-region`);
    await until(async () => {
      const value = await region.evaluate(element => element.style.clipPath);
      const numbers = [...value.matchAll(/([\d.]+)%/g)].map(match => Number(match[1]));
      return numbers.length === 4 && numbers.every((number, index) => Math.abs(number - [160 / 1080 * 100, 80 / 1920 * 100, 64 / 1080 * 100, 320 / 1920 * 100][index]) < .01);
    }, 'offline Preview and thumbnail render exact text-only insets');
  }
  await unchangedLive();
  checks.push('queued side edits stay on their layer; Preview and thumbnails use the exact insets without moving the background');

  await row(lyricsId).getByRole('button', { name: 'Lock Lyrics', exact: true }).click();
  await until(() => field('top').isDisabled(), 'locked layer disables padding');
  assert.equal(await link().isDisabled(), true, 'Locked layers cannot relink padding');
  await row(lyricsId).getByRole('button', { name: 'Unlock Lyrics', exact: true }).click();
  await until(() => field('top').isEnabled(), 'unlock restores padding controls');
  for (const width of [1728, 1366]) {
    await page.setViewportSize({ width, height: width === 1728 ? 1117 : 768 }); await field('top').scrollIntoViewIfNeeded();
    const bounds = await inspector.evaluate(element => {
      const body = element.querySelector('.inspector-body'), fields = [...element.querySelectorAll('input[aria-label$="text padding"]')];
      const panel = element.getBoundingClientRect();
      return { width: body.clientWidth, scroll: body.scrollWidth, inside: fields.every(field => { const r = field.getBoundingClientRect(); return r.left >= panel.left && r.right <= panel.right; }) };
    });
    assert.ok(bounds.scroll <= bounds.width + 1 && bounds.inside, JSON.stringify(bounds));
    await page.screenshot({ path: path.join(dir, `text-padding-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1728, height: 1117 });
  const layerPanel = page.getByRole('region', { name: 'Layers', exact: true });
  await layerPanel.getByRole('button', { name: 'Copy layer', exact: true }).click();
  await until(() => layerPanel.getByRole('button', { name: 'Paste layer', exact: true }).isEnabled(), 'padding layer copied');
  await sceneCard(otherId).click(); await until(async () => (await get()).previewSceneId === otherId, 'select paste destination');
  await layerPanel.getByRole('button', { name: 'Paste layer', exact: true }).click();
  const pasted = await until(async () => (await get()).scenes.find(scene => scene.id === otherId).layers.find(layer => layer.sourceId === 'source_lyrics'), 'paste retains text padding');
  assert.deepEqual(pasted.textPadding, expected);
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio' }).waitFor(); await select();
  for (const side of ['top', 'right', 'bottom', 'left']) assert.equal(Number(await field(side).inputValue()), expected[side]);
  assert.deepEqual((await getLayer(pasted.id, otherId)).textPadding, expected);
  await unchangedLive();
  checks.push('locked controls, narrow inspector, copy/paste and reload preserve text padding');

  // Decode real Program frames from the disposable engine: moving only the
  // text must leave the blue image in place and wait for an explicit Take.
  const started = await request.post(`${base}/api/studio/engine/start`);
  assert.equal(started.status(), 200, await started.text()); engineRunning = true;
  assert.equal((await started.json()).state, 'running');
  const video = page.locator('.program-panel video').first();
  const frame = () => video.evaluate(video => {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 320, 180);
    const pixels = context.getImageData(0, 0, 320, 180).data; let cyan = 0, minX = 320, minY = 180;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      if (b > 145 && g > 135 && g - r > 30 && b - r > 50) { cyan++; minX = Math.min(minX, i / 4 % 320); minY = Math.min(minY, Math.floor(i / 4 / 320)); }
    }
    return { cyan, minX, minY, corner: Array.from(pixels.slice((175 * 320 + 315) * 4, (175 * 320 + 315) * 4 + 3)) };
  });
  const beforeTake = await until(async () => { const value = await frame(); return value?.cyan > 40 && value.minX < 20 ? value : null; }, 'Program retains its legacy inset before Take', 25000);
  await unchangedLive(); await command({ type: 'take', sceneId });
  const afterTake = await until(async () => { const value = await frame(); return value?.cyan > 40 && value.minX > 45 ? value : null; }, 'Program applies new left text inset after Take', 15000);
  assert.ok(afterTake.minY > beforeTake.minY + 10, 'Program also applies top padding');
  assert.ok(afterTake.corner.every((value, index) => Math.abs(value - beforeTake.corner[index]) <= 5), 'Program image background stays fixed');
  const live = await get(); assert.deepEqual(live.program.layers.find(layer => layer.id === lyricsId).textPadding, expected);
  assert.deepEqual(live.outputs, baseline.outputs, 'Take does not change pinned output padding');
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200); engineRunning = false;
  checks.push('real Program holds old text position until Take, then changes text insets while keeping the image background');
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  console.log(JSON.stringify({ checks, artifacts: dir }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(dir, 'text-padding-failed.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: error.message, stack: error.stack, checks, errors, artifacts: dir, logs }, null, 2)); process.exitCode = 1;
} finally {
  releaseHeldSave?.(); await page?.unrouteAll({ behavior: 'wait' }).catch(() => {});
  if (engineRunning && request) await request.post(`${base}/api/studio/engine/stop`).catch(() => {});
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited; }
  }
}
