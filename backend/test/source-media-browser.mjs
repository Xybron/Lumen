// Run after npm run build. Every upload, source and production document belongs
// to an isolated temporary station. No camera, microphone or operator data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-source-media-'));
const port = Number(process.env.LUMEN_SOURCE_MEDIA_TEST_PORT ?? 3425), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let browser, server, page, logs = '';
const checks = [], errors = [];
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const picture = color => sharp({ create: { width: 640, height: 360, channels: 4, background: color } }).png().toBuffer();
const liveState = state => ({ program: state.program, programTransition: state.programTransition,
  channelInsert: state.channelInsert, outputs: state.outputs, masterVolume: state.masterVolume, masterMuted: state.masterMuted });
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

try {
  const blueImage = await picture('#2359b1'), greenImage = await picture('#258c52');
  const uploadImage = path.join(dir, 'service-green.png'), videoFile = path.join(dir, 'welcome-motion.mp4'), audioFile = path.join(dir, 'service-tone.wav');
  await fs.writeFile(uploadImage, greenImage);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', videoFile]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', '2', '-c:a', 'pcm_s16le', audioFile]);
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'temporary station ready', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const upload = async (kind, name, mimeType, buffer) => {
    const response = await request.post(`${base}/api/media/${kind}`, { multipart: { file: { name, mimeType, buffer } } });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const blue = await upload('backgrounds', 'library-blue.png', 'image/png', blueImage);
  const broken = await upload('backgrounds', 'damaged-artwork.png', 'image/png', Buffer.from('Not a decodable image.'));
  const motion = await upload('backgrounds', 'welcome-motion.mp4', 'video/mp4', await fs.readFile(videoFile));
  const tone = await upload('music', 'service-tone.wav', 'audio/wav', await fs.readFile(audioFile));
  const media = await (await request.get(`${base}/api/media/backgrounds`)).json();
  const listedBlue = media.find(file => file.path === blue.path), listedMotion = media.find(file => file.path === motion.path);
  assert.ok(listedBlue.thumbnail && listedMotion.thumbnail, 'Existing image and video library files carry usable thumbnails');
  assert.equal(listedBlue.bytes, blueImage.length); assert.ok(Number.isFinite(Date.parse(listedBlue.modifiedAt)));
  assert.equal((await request.get(`${base}/${listedBlue.thumbnail}`)).status(), 200);
  assert.equal((await request.get(`${base}/${listedMotion.thumbnail}`)).status(), 200);
  checks.push('Existing library entries provide real image/video thumbnails, byte sizes and modification metadata');
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const initial = await get();
  const take = await request.post(`${base}/api/studio/command`, { data: { revision: initial.revision, command: { type: 'take', sceneId: initial.previewSceneId } } });
  assert.equal(take.status(), 200, await take.text());
  const committed = liveState(await get());
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    window.__sourceMediaBlobs = new Set();
    URL.createObjectURL = object => { const url = create(object); window.__sourceMediaBlobs.add(url); return url; };
    URL.revokeObjectURL = url => { window.__sourceMediaBlobs.delete(url); revoke(url); };
  });
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  const dialog = page.getByRole('dialog', { name: 'Add a source', exact: true });
  const preview = () => dialog.getByTestId('source-media-preview');
  const assets = () => dialog.getByTestId('source-media-grid').getByRole('button', { name: /^Select / });
  const asset = name => dialog.getByRole('button', { name: new RegExp(`^Select .*${escaped(name)}$`) });
  const kind = label => dialog.getByRole('group', { name: 'Source type', exact: true }).getByRole('button', { name: new RegExp(`^${escaped(label)}(?:$|\\s)`) });
  const search = () => dialog.getByLabel('Search media', { exact: true });
  const uploadInput = () => dialog.locator('input[type="file"]');
  const add = () => dialog.getByRole('button', { name: 'Add to Studio', exact: true });
  const open = async label => {
    await page.getByRole('button', { name: 'Add production source', exact: true }).click();
    await dialog.waitFor(); await kind(label).click();
  };
  const verifyOriginalImage = async (suffix, color) => {
    await until(async () => preview().locator('img').evaluate((image, expected) => image.complete && image.naturalWidth === 640 && image.src.endsWith(expected), suffix), `full-resolution ${suffix} preview`);
    const pixel = await preview().locator('img').evaluate(image => {
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data];
    });
    assert.ok(color(pixel), `Original image pixels, not an icon: ${pixel}`);
  };
  const save = async (name, expectedKind, expectedUrl) => {
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    const prior = await get(); await add().click(); await dialog.waitFor({ state: 'hidden' });
    const state = await until(async () => { const state = await get(); return state.sources.find(source => source.name === name) && state; }, `saved ${name}`);
    assert.equal(state.sources.length, prior.sources.length + 1, 'One click adds exactly one source');
    const source = state.sources.find(source => source.name === name);
    assert.equal(source.kind, expectedKind); assert.equal(source.url, expectedUrl);
    assert.deepEqual(liveState(state), committed, 'Adding a source never publishes or changes committed Program, outputs or audio');
    if (expectedKind === 'audio') assert.equal(state.scenes.flatMap(scene => scene.layers).some(layer => layer.sourceId === source.id), false);
    else assert.equal(state.scenes.find(scene => scene.id === state.previewSceneId).layers.filter(layer => layer.sourceId === source.id).length, 1);
    return source;
  };

  await open('Image'); await asset('library-blue.png').waitFor();
  await until(async () => asset('library-blue.png').locator('img').evaluate(image => image.complete && image.naturalWidth > 0), 'library tile thumbnail decoded');
  await search().fill('a search that has no match'); assert.equal(await assets().count(), 0);
  assert.equal(await add().isEnabled(), false);
  await search().fill('library-blue'); assert.equal(await assets().count(), 1);
  await asset('library-blue.png').focus(); await page.keyboard.press('Enter');
  assert.equal(await asset('library-blue.png').getAttribute('aria-pressed'), 'true', 'Keyboard selection exposes selected state');
  await verifyOriginalImage(blue.path, pixel => pixel[2] > pixel[0] * 2);
  const beforeSearchEnter = await get();
  await search().press('Enter');
  assert.equal(await dialog.isVisible(), true, 'Enter in the library search never implicitly submits the selected source');
  assert.deepEqual(await get(), beforeSearchEnter, 'Searching must not save a source or change Preview');
  await page.screenshot({ path: path.join(dir, 'source-image-library.png'), fullPage: true });
  await save('Blue service artwork', 'image', blue.path);
  checks.push('Searchable visual library supports keyboard selection and a decoded full-resolution image preview; adding only changes Preview');

  await open('Image');
  let releaseUpload, uploadIntercepted;
  const uploadHeld = new Promise(resolve => { uploadIntercepted = resolve; });
  const mayUpload = new Promise(resolve => { releaseUpload = resolve; });
  const holdUpload = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    uploadIntercepted(); await mayUpload;
    await route.continue().catch(() => {});
  };
  await page.route('**/api/media/backgrounds', holdUpload);
  await uploadInput().setInputFiles(uploadImage); await uploadHeld;
  await until(async () => preview().locator('img').evaluate(image => image.src.startsWith('blob:') && image.complete && image.naturalWidth === 640), 'instant local preview before upload response');
  assert.equal(await add().isEnabled(), false, 'A local preview cannot be saved before the real station upload succeeds');
  await page.screenshot({ path: path.join(dir, 'source-image-uploading.png'), fullPage: true });
  releaseUpload();
  const uploadedGreen = await until(async () => (await (await request.get(`${base}/api/media/backgrounds`)).json()).find(file => file.name.endsWith('service-green.png')), 'uploaded image in station library');
  await until(async () => await add().isEnabled(), 'uploaded image ready to add');
  await page.unroute('**/api/media/backgrounds', holdUpload);
  await verifyOriginalImage(uploadedGreen.path, pixel => pixel[1] > pixel[0] * 2);
  assert.equal(await page.evaluate(() => window.__sourceMediaBlobs.size), 0, 'The replaced local preview URL is released after upload');
  await save('Green service artwork', 'image', uploadedGreen.path);
  checks.push('Uploading shows an immediate local image preview, stays unsaveable until server success, then selects the real uploaded asset');

  await open('Video'); await asset('welcome-motion.mp4').click();
  const video = preview().locator('video');
  await until(async () => video.evaluate(element => element.readyState >= 2 && element.videoWidth === 640 && element.duration > 1.9), 'real video preview and metadata');
  assert.deepEqual(await video.evaluate(element => ({ muted: element.muted, controls: element.controls, autoplay: element.autoplay, paused: element.paused })), { muted: true, controls: true, autoplay: false, paused: true });
  await video.evaluate(element => element.play());
  await until(async () => video.evaluate(element => element.currentTime > .1), 'local video preview can play');
  await video.evaluate(element => element.pause());
  await page.screenshot({ path: path.join(dir, 'source-video-preview.png'), fullPage: true });
  await save('Welcome motion', 'video', motion.path);

  await open('Audio file'); await asset('service-tone.wav').click();
  const audio = preview().locator('audio');
  await until(async () => audio.evaluate(element => element.readyState >= 1 && element.duration > 1.9), 'real audio metadata and controls');
  assert.deepEqual(await audio.evaluate(element => ({ controls: element.controls, autoplay: element.autoplay, paused: element.paused })), { controls: true, autoplay: false, paused: true });
  const [audioBounds, audioViewport] = await Promise.all([audio.boundingBox(), preview().locator('.preview-viewport').boundingBox()]);
  assert.ok(audioBounds.x >= audioViewport.x && audioBounds.x + audioBounds.width <= audioViewport.x + audioViewport.width + 1 &&
    audioBounds.y >= audioViewport.y && audioBounds.y + audioBounds.height <= audioViewport.y + audioViewport.height + 1,
  `Native audio controls must be fully inside the unclipped preview: ${JSON.stringify({ audioBounds, audioViewport })}`);
  await audio.click({ trial: true });
  await page.screenshot({ path: path.join(dir, 'source-audio-preview.png'), fullPage: true });
  await save('Service soundtrack', 'audio', tone.path);
  checks.push('Video has real muted, manually controlled playback; audio has a real non-autoplay player; typed sources keep the chosen URLs');

  await open('Image'); await asset('damaged-artwork.png').click();
  await until(async () => /unavailable|unsupported|couldn.t|cannot|can.t|failed|could not/i.test(await preview().innerText()), 'readable broken-preview fallback');
  await asset('library-blue.png').click(); await verifyOriginalImage(blue.path, pixel => pixel[2] > pixel[0] * 2);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(liveState(await get()), committed);
  checks.push('Broken media presents an understandable fallback and selecting another asset recovers without changing Program');

  const rejectLibrary = async route => route.request().method() === 'GET'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Library unavailable' }) })
    : route.continue();
  await page.route('**/api/media/backgrounds', rejectLibrary); await open('Image');
  await until(async () => (await dialog.getByRole('alert').allTextContents()).some(text => /library could not be loaded/i.test(text)), 'library errors are not disguised as an empty collection');
  await page.unroute('**/api/media/backgrounds', rejectLibrary);
  await dialog.getByRole('alert').getByRole('button', { name: 'Try again', exact: true }).click();
  await asset('library-blue.png').waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  checks.push('Library connection failures show a retryable error rather than a misleading empty library');

  await open('Image');
  const rejectUpload = async route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Upload interrupted. Try again.' }) })
    : route.continue();
  await page.route('**/api/media/backgrounds', rejectUpload);
  await uploadInput().setInputFiles(uploadImage);
  await until(async () => (await dialog.getByRole('alert').allTextContents()).some(text => /Upload failed/i.test(text)), 'accessible upload failure');
  assert.equal(await add().isEnabled(), false, 'An unsuccessful local upload cannot be saved as a source');
  await page.unroute('**/api/media/backgrounds', rejectUpload);
  await uploadInput().setInputFiles(uploadImage);
  await until(async () => await add().isEnabled(), 'retrying the same file succeeds after a failed upload');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__sourceMediaBlobs.size), 0, 'Cancelling releases local preview URLs');
  checks.push('A failed upload has an accessible error, cannot add a local-only source, and allows retrying the same file');

  // Reproduce a slow upload, then leave that source type. A late response may
  // add a library file, but must never select an image as a Video source.
  await open('Image');
  let releaseStale, sawStale;
  const staleHeld = new Promise(resolve => { sawStale = resolve; });
  const staleMayContinue = new Promise(resolve => { releaseStale = resolve; });
  const holdStale = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    sawStale(); await staleMayContinue; await route.continue().catch(() => {});
  };
  await page.route('**/api/media/backgrounds', holdStale);
  await uploadInput().setInputFiles({ name: 'late-image.png', mimeType: 'image/png', buffer: greenImage }); await staleHeld;
  const aborted = page.waitForEvent('requestfailed', { predicate: request => request.method() === 'POST' && request.url() === `${base}/api/media/backgrounds` });
  if (await kind('Video').isEnabled()) await kind('Video').click();
  else { await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); await open('Video'); }
  await aborted;
  releaseStale(); await page.unroute('**/api/media/backgrounds', holdStale);
  await asset('welcome-motion.mp4').waitFor();
  assert.equal(await add().isEnabled(), false, 'A response from the old image upload cannot select a Video asset');
  assert.equal(await preview().locator('img').count(), 0);
  await asset('welcome-motion.mp4').click();
  await until(async () => preview().locator('video').evaluate(element => element.src.endsWith('welcome-motion.mp4') && element.videoWidth === 640), 'new source type keeps its own selection');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__sourceMediaBlobs.size), 0, 'Abandoned upload previews are released on a type switch');
  checks.push('Changing type or reopening during an upload rejects stale selection and prevents image URLs being saved as Video sources');

  let releaseList, listIntercepted, listFinished;
  const listHeld = new Promise(resolve => { listIntercepted = resolve; });
  const listMayContinue = new Promise(resolve => { releaseList = resolve; });
  const listDone = new Promise(resolve => { listFinished = resolve; });
  const holdList = async route => {
    if (route.request().method() !== 'GET') return route.continue();
    listIntercepted(); await listMayContinue;
    try { const response = await route.fetch(); await route.fulfill({ response }); } catch { /* A cancelled old library read is also safe. */ }
    finally { listFinished(); }
  };
  await page.route('**/api/media/backgrounds', holdList);
  await open('Image'); await listHeld; await kind('Audio file').click();
  await asset('service-tone.wav').click();
  releaseList(); await listDone; await page.unroute('**/api/media/backgrounds', holdList);
  await until(async () => preview().locator('audio').evaluate(element => element.src.endsWith('service-tone.wav') && element.duration > 1.9), 'late visual-library response cannot replace audio selection');
  assert.equal(await asset('service-tone.wav').getAttribute('aria-pressed'), 'true');
  assert.equal(await asset('library-blue.png').count(), 0, 'An old image library response cannot overwrite the current audio library');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  checks.push('Delayed library reads cannot overwrite a newer type, its gallery or its selected audio preview');

  await open('Image'); await asset('library-blue.png').click();
  for (const width of [1512, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 740 : 982 });
    await dialog.waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `Dialog fits ${width}px viewport: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.y >= -1 && bounds.y + bounds.height <= (width < 500 ? 740 : 982) + 1, `Dialog height fits ${width}px viewport`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No page-level horizontal overflow at ${width}px`);
    if (width < 500) {
      await asset('library-blue.png').click();
      await until(async () => {
        const [selectedBounds, bodyBounds, sidebarBounds] = await Promise.all([preview().boundingBox(), dialog.locator('.source-body').boundingBox(), dialog.locator('.source-sidebar').boundingBox()]);
        return selectedBounds && bodyBounds && sidebarBounds && selectedBounds.y >= Math.max(bodyBounds.y, sidebarBounds.y + sidebarBounds.height) - 1 && selectedBounds.y + selectedBounds.height <= bodyBounds.y + bodyBounds.height + 1;
      }, `Choosing an asset reveals its entire preview at ${width}px without manually scrolling`);
    }
    await add().scrollIntoViewIfNeeded(); await add().click({ trial: true });
    const addBounds = await add().boundingBox();
    assert.ok(addBounds.x >= 0 && addBounds.x + addBounds.width <= width + 1, `Action remains reachable at ${width}px`);
    await page.screenshot({ path: path.join(dir, `source-responsive-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  await search().focus();
  for (let step = 0; step < 20; step++) {
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Keyboard focus remains in the open dialog');
  }
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(liveState(await get()), committed); assert.deepEqual(errors, []);
  checks.push('Desktop, tablet, 390px and 320px layouts fit with reachable actions; mobile selection reveals its preview; dialog traps focus and Escape cancels without publishing');
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'source-media-failure.png'), fullPage: true }).catch(() => {});
  if (page) console.error(await page.locator('.source-dialog').evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { viewport: [innerWidth, innerHeight], bounds: rect.toJSON(), width: style.width, maxWidth: style.maxWidth,
      minWidth: style.minWidth, transform: style.transform, translate: style.translate, transition: style.transition, className: element.className };
  }).catch(() => 'Source dialog not open'));
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited;
  }
}
