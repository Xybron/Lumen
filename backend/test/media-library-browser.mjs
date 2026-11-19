// End-to-end checks use a temporary station, never the operator's media or data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-media-library-'));
const port = Number(process.env.LUMEN_MEDIA_LIBRARY_TEST_PORT ?? 3447), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let server, browser, page, logs = '';
const errors = [], checks = [];
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const liveState = state => ({ program: state.program, programTransition: state.programTransition, outputs: state.outputs, channelInsert: state.channelInsert, masterVolume: state.masterVolume, masterMuted: state.masterMuted });
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station ready', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  context.setDefaultTimeout(15000);
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const picture = await sharp({ create: { width: 640, height: 360, channels: 4, background: '#20668c' } }).png().toBuffer();
  const images = {};
  for (const label of ['slide', 'source', 'layer', 'unused', 'race', 'routing', 'picker-removed']) {
    const response = await request.post(`${base}/api/media/backgrounds`, { multipart: { file: { name: `${label}.png`, mimeType: 'image/png', buffer: picture } } });
    assert.equal(response.status(), 200, await response.text()); const saved = await response.json();
    images[label] = { ...saved, id: `library:${saved.path.split('/').pop()}` };
  }
  const clipResponse = await request.post(`${base}/api/clips/assets`, { multipart: { durationMs: '0', width: '640', height: '360', file: { name: 'private-artwork.png', mimeType: 'image/png', buffer: picture } } });
  assert.equal(clipResponse.status(), 201, await clipResponse.text());
  const content = { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [{ id: 'media_presentation', name: 'Media test presentation', kind: 'presentation', playlistId: 'media_playlist', defaultMode: 'manual' }],
    playlists: [{ id: 'media_playlist', name: 'Media test presentation', items: [{ id: 'media_slide', type: 'image', title: 'Welcome artwork', durationMs: 30000, background: { kind: 'image', src: images.slide.path, fit: 'contain', overlayOpacity: 0 } }] }],
    sources: [{ id: 'channel_media', kind: 'channel', ref: 'media_presentation' }, { id: 'routing_media', kind: 'media', label: 'Routing artwork', ref: images.routing.path }],
    destinations: [], routes: [], program: { programSourceId: 'channel_media', previewSourceId: null } };
  const saveContent = async value => { const response = await request.put(`${base}/api/content`, { data: value }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const getContent = async () => (await request.get(`${base}/api/content`)).json();
  const getStudio = async () => (await request.get(`${base}/api/studio`)).json();
  const catalogue = async () => (await (await request.get(`${base}/api/media-library`)).json()).assets;
  const findAsset = async id => (await catalogue()).find(asset => asset.id === id);
  await saveContent(content);
  let studio = await getStudio();
  studio.sources.push({ id: 'media_source', name: 'Source artwork', kind: 'image', url: images.source.path, loop: true, audio: { volume: 1, muted: true, mode: 'always', delayMs: 0 } });
  const scene = studio.scenes[0];
  scene.layers[0].mediaBackground = { kind: 'image', url: images.layer.path, fit: 'cover', dim: .2, loop: true };
  const savedStudio = await request.put(`${base}/api/studio`, { data: studio }); assert.equal(savedStudio.status(), 200, await savedStudio.text());
  const initialLive = liveState(await getStudio()), initialRouting = (await getContent()).program;
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const rootBrowser = () => page.getByTestId('media-library');
  const inspector = () => page.getByTestId('media-inspector');
  const tile = (id, scope = page) => scope.locator(`[data-asset-id=${JSON.stringify(id)}]`);
  const selectAsset = async id => { await tile(id).locator('.media-asset-button').click(); await until(async () => (await inspector().locator('h2').innerText()).length, 'inspector ready'); };
  const openMedia = async () => { await page.goto(`${base}/media`); await page.getByRole('heading', { name: 'Media library', exact: true }).waitFor(); await rootBrowser().locator('[data-asset-id]').first().waitFor(); };
  const refresh = async () => { const response = page.waitForResponse(r => r.url() === `${base}/api/media-library` && r.request().method() === 'GET'); await rootBrowser().getByRole('button', { name: 'Refresh media library', exact: true }).click(); await response; };
  await openMedia();
  const all = await catalogue(); assert.ok(all.every(asset => asset.usageStatus === 'known'));
  assert.equal(await page.locator('[data-asset-id]').count(), all.length);
  await selectAsset(images.slide.id); assert.ok(await inspector().getByRole('button', { name: 'Delete', exact: true }).isDisabled());
  assert.match(await inspector().innerText(), /Media test presentation/);
  const legacyDelete = await request.delete(`${base}/api/media/backgrounds/${encodeURIComponent(images.slide.path.split('/').pop())}`);
  assert.equal(legacyDelete.status(), 409, 'Legacy deletion cannot bypass presentation usage');
  await page.getByTestId('media-filter-unused').click();
  assert.equal(await page.locator('[data-asset-id]').count(), all.filter(asset => !asset.usage.length).length);
  assert.equal(await tile(images.slide.id).count(), 0);
  await page.getByTestId('media-filter-used').click();
  assert.equal(await page.locator('[data-asset-id]').count(), all.filter(asset => asset.usage.length).length);
  checks.push('Authoritative usage drives filters and protects legacy deletion');
  await page.getByTestId('media-filter-all').click();
  await selectAsset(images.unused.id); await inspector().getByRole('button', { name: 'Rename', exact: true }).click();
  const renaming = page.getByRole('dialog', { name: 'Rename image', exact: true });
  await renaming.getByLabel('Display name', { exact: true }).fill('Welcome alternate'); await renaming.getByRole('button', { name: 'Save name', exact: true }).click();
  await renaming.waitFor({ state: 'hidden' }); await until(async () => (await findAsset(images.unused.id)).displayName === 'Welcome alternate', 'renamed metadata');
  const legacyList = await (await request.get(`${base}/api/media/backgrounds`)).json();
  assert.equal(legacyList.find(file => file.path === images.unused.path).displayName, 'Welcome alternate');
  await page.getByLabel('Search media', { exact: true }).fill('Welcome alternate'); assert.equal(await page.locator('[data-asset-id]').count(), 1);
  await page.getByRole('button', { name: 'Switch to list view', exact: true }).click(); assert.equal(await page.locator('.media-asset-list').count(), 1);
  await page.getByLabel('Search media', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Switch to grid view', exact: true }).click();
  const uploadFile = path.join(dir, 'shared-new.png'); await fs.writeFile(uploadFile, picture);
  await page.getByLabel('Upload media to Media', { exact: true }).setInputFiles(uploadFile);
  const uploaded = await until(async () => (await catalogue()).find(asset => asset.name.endsWith('-shared-new.png')), 'UI upload');
  await until(async () => await tile(uploaded.id).count(), 'uploaded tile');
  await until(async () => (await inspector().innerText()).includes('640 × 360'), 'original image dimensions');
  checks.push('Upload, display-name rename, legacy picker names, search and list view');

  await selectAsset(images.source.id);
  await inspector().getByRole('link', { name: /^Open Studio source:/ }).click();
  const sourceDialog = page.getByRole('dialog', { name: /Source properties|Edit source/ });
  await sourceDialog.waitFor();
  await sourceDialog.getByRole('button', { name: 'Choose from Media', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an image', exact: true }); await picker.waitFor();
  await tile(images['picker-removed'].id, picker).locator('.media-asset-button').click();
  const removedChoice = await request.post(`${base}/api/media-library/delete`, { data: { ids: [images['picker-removed'].id] } });
  assert.equal(removedChoice.status(), 200, await removedChoice.text());
  await picker.getByRole('button', { name: 'Refresh media library', exact: true }).click();
  await until(async () => await picker.getByRole('button', { name: 'Use image', exact: true }).isDisabled(), 'removed picker selection is cleared');
  await picker.getByLabel('Search images', { exact: true }).fill('shared-new');
  await picker.locator('.media-asset-button').click(); await picker.getByRole('button', { name: 'Use image', exact: true }).click();
  await picker.waitFor({ state: 'hidden' });
  await sourceDialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await sourceDialog.waitFor({ state: 'hidden' });
  await until(async () => (await getStudio()).sources.find(source => source.id === 'media_source').url === uploaded.url.slice(1), 'source replaced');
  assert.deepEqual(liveState(await getStudio()), initialLive, 'Picker/edit navigation does not publish Studio');
  await page.getByRole('link', { name: 'Back to Media', exact: true }).click();
  await until(async () => await inspector().getByRole('button', { name: 'Delete', exact: true }).isEnabled(), 'former source file now unused');
  checks.push('Usage link opens source properties, shared picker replaces image without publishing');

  await selectAsset(images.slide.id); await inspector().getByRole('link', { name: /^Open Presentation:/ }).click();
  const slideDialog = page.getByRole('dialog', { name: 'Edit slide', exact: true }); await slideDialog.waitFor();
  await slideDialog.getByRole('button', { name: 'Choose from Media', exact: true }).click(); await picker.waitFor();
  await picker.getByLabel('Search images', { exact: true }).fill('shared-new'); await picker.locator('.media-asset-button').click();
  await picker.getByRole('button', { name: 'Use image', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
  await slideDialog.getByRole('button', { name: 'Save', exact: true }).click(); await slideDialog.waitFor({ state: 'hidden' });
  await until(async () => (await getContent()).playlists.find(p => p.id === 'media_playlist').items[0].background.src === uploaded.url.slice(1), 'slide replaced');
  assert.deepEqual((await getContent()).program, initialRouting, 'Usage navigation never changes routing selection');
  await page.getByRole('link', { name: 'Back to Media', exact: true }).click();
  await until(async () => await inspector().getByRole('button', { name: 'Delete', exact: true }).isEnabled(), 'former slide image unused');
  checks.push('Presentation link and image picker save exact slide and refresh usage on return');

  await selectAsset(images.layer.id); await inspector().getByRole('link', { name: /^Open Scene background:/ }).click();
  await page.getByRole('button', { name: 'Edit lyrics background', exact: true }).click();
  const background = page.getByRole('dialog', { name: 'Edit lyrics background', exact: true }); await background.waitFor();
  await background.getByRole('button', { name: 'Choose from Media', exact: true }).click(); await picker.waitFor();
  await picker.getByLabel('Search images', { exact: true }).fill('shared-new'); await picker.locator('.media-asset-button').click();
  await picker.getByRole('button', { name: 'Use image', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
  await until(async () => (await getStudio()).scenes.find(value => value.id === scene.id).layers[0].mediaBackground.url === uploaded.url.slice(1), 'layer background replaced');
  assert.deepEqual(liveState(await getStudio()), initialLive, 'Layer picker never Takes the edited background');
  if (await background.isVisible()) await background.getByRole('button', { name: 'Close background settings', exact: true }).click();
  await page.getByRole('link', { name: 'Back to Media', exact: true }).click();
  await until(async () => await inspector().getByRole('button', { name: 'Delete', exact: true }).isEnabled(), 'former layer image unused');
  checks.push('Layer background usage opens the exact inspector and reuses the shared picker');

  await selectAsset(images.routing.id); await inspector().getByRole('link', { name: /^Open Source routing:/ }).click();
  const routingDialog = page.getByRole('dialog', { name: 'Routing artwork', exact: true }); await routingDialog.waitFor();
  await routingDialog.getByRole('button', { name: 'Remove source', exact: true }).click();
  const confirmRouting = page.getByRole('dialog', { name: 'Remove media source?', exact: true }); await confirmRouting.getByRole('button', { name: 'Remove source', exact: true }).click();
  await until(async () => !(await getContent()).sources.some(source => source.id === 'routing_media'), 'routing source removed');
  await page.getByRole('button', { name: 'Back to Media', exact: true }).click(); await page.getByRole('heading', { name: 'Media library', exact: true }).waitFor();
  checks.push('Legacy routing reference opens its editor and can be explicitly removed');

  await selectAsset(images.race.id); await inspector().getByRole('button', { name: 'Delete', exact: true }).click();
  const confirmDelete = page.getByRole('dialog', { name: 'Delete image?', exact: true }); await confirmDelete.waitFor();
  const raced = await getContent(); raced.playlists[0].items.push({ id: 'late_reference', type: 'image', title: 'Newly used image', durationMs: 30000, background: { kind: 'image', src: images.race.path } }); await saveContent(raced);
  await confirmDelete.getByRole('button', { name: 'Delete image', exact: true }).click();
  await until(async () => await inspector().getByRole('button', { name: 'Delete', exact: true }).isDisabled(), 'late reference protects deletion');
  assert.ok(await findAsset(images.race.id), 'Original remains after newly added usage');
  checks.push('Deletion rechecks usage after confirmation and preserves newly referenced images');

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await tile(images.unused.id).getByRole('checkbox').check(); await tile(uploaded.id).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Delete unused (1)', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete image?', exact: true }).getByRole('button', { name: 'Delete image', exact: true }).click();
  await until(async () => !(await findAsset(images.unused.id)), 'unused bulk file removed');
  assert.ok((await findAsset(uploaded.id)).usage.length >= 2, 'Used bulk asset preserved');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByLabel('Media location', { exact: true }).selectOption('clip');
  await until(async () => await page.locator('[data-asset-id]').count() === 1, 'private clip filter');
  assert.match(await inspector().innerText(), /Private asset/);
  checks.push('Bulk cleanup protects used selections; private Clip images remain in their own catalog');
  await page.getByLabel('Media location', { exact: true }).selectOption('all'); await refresh();
  await page.screenshot({ path: path.join(dir, 'media-library-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout does not overflow horizontally');
  await page.screenshot({ path: path.join(dir, 'media-library-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(logs.slice(-5000)); console.error(`Media test artifacts: ${dir}`); throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
