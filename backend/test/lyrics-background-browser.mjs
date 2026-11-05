// Run after npm run build. Synthetic media and a disposable station only;
// this test never opens the operator's data or captures a physical device.
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
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-lyrics-background-'));
const port = Number(process.env.LUMEN_LYRICS_BACKGROUND_TEST_PORT ?? 3463);
const base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// An occupied port must fail rather than accidentally reaching a real station.
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
const mediaDir = path.join(dir, 'media', 'backgrounds');
await fs.mkdir(mediaDir, { recursive: true });
const imageName = 'lyrics-fixture-image.png', videoName = 'lyrics-fixture-video.mp4', brokenVideoName = 'lyrics-fixture-broken.mp4';
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x285578:s=320x180', '-frames:v', '1', path.join(mediaDir, imageName)]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(mediaDir, videoName)]);
await fs.mkdir(path.join(dir, 'media', 'thumbnails'), { recursive: true });
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path.join(mediaDir, videoName), '-frames:v', '1', path.join(dir, 'media', 'thumbnails', 'lyrics-fixture-video.jpg')]);
await fs.writeFile(path.join(mediaDir, brokenVideoName), 'Synthetic unsupported media for the playback-error regression.');

let logs = '', browser, page, server;
const checks = [], errors = [];
function launchServer() {
  const child = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  return child;
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited; }
}
async function until(fn, label, timeout = 10000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const waitForStation = () => until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station starts', 30000);
try {
  server = launchServer(); await waitForStation();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 } });
  const request = context.request;
  const login = async () => assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  await login();
  const content = { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [{ id: 'lyrics', name: 'Worship lyrics', kind: 'lyrics', playlistId: 'p_lyrics', defaultMode: 'manual' }],
    playlists: [{ id: 'p_lyrics', name: 'Worship lyrics', items: [] }] };
  const seeded = await request.put(`${base}/api/content`, { data: content });
  assert.equal(seeded.status(), 200, await seeded.text());
  const song = await request.post(`${base}/api/worship/songs`, { data: { id: 'lyrics_background_song', title: 'A song for this moment',
    sections: [{ id: 'verse_one', label: 'Verse 1', text: 'Together in this place\nLet every voice sing out with joy' }] } });
  assert.equal(song.status(), 201, await song.text());
  const worship = await (await request.get(`${base}/api/worship/channels/lyrics`)).json();
  const cue = await request.post(`${base}/api/worship/channels/lyrics/command`, { data: { revision: worship.revision,
    command: { type: 'take', selection: { kind: 'lyrics', songId: 'lyrics_background_song', sectionId: 'verse_one' } } } });
  assert.equal(cue.status(), 200, await cue.text());
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const save = async mutate => {
    const document = await get(); mutate(document);
    const response = await request.put(`${base}/api/studio`, { data: document });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const command = async command => {
    const document = await get();
    const response = await request.post(`${base}/api/studio/command`, { data: { revision: document.revision, command } });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const firstScene = 'lyrics_background_full', secondScene = 'lyrics_background_lower';
  const firstLayer = 'lyrics_background_full_layer', secondLayer = 'lyrics_background_lower_layer';
  const layer = (id, name, patch = {}) => ({ id, name, kind: 'source', sourceId: 'lyrics_background_source', visible: true, locked: false,
    x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'contain', text: '', color: '#ffffff', background: '#00000000',
    fontSize: 72, fontWeight: 500, align: 'center', radius: 0, ...patch });
  await save(document => {
    document.sources.push({ id: 'lyrics_background_source', name: 'Lyrics', kind: 'channel', channelId: 'lyrics', loop: false, audio: { muted: true, volume: 1, mode: 'follow', delayMs: 0 } });
    document.scenes.push({ id: firstScene, name: 'Lyrics full fixture', background: '#111317', layers: [layer(firstLayer, 'Full lyrics')] });
    document.scenes.push({ id: secondScene, name: 'Lyrics lower fixture', background: '#111317', layers: [layer(secondLayer, 'Lower lyrics', { y: 75, height: 25 })] });
    document.previewSceneId = firstScene;
  });
  await command({ type: 'take', sceneId: firstScene });
  await command({ type: 'route', outputId: 'screen_main', sceneId: firstScene });
  const baseline = await get();
  const getLayer = async (sceneId = firstScene, layerId = firstLayer) => (await get()).scenes.find(scene => scene.id === sceneId).layers.find(layer => layer.id === layerId);
  const unchangedLive = async () => {
    const state = await get();
    assert.deepEqual(state.program, baseline.program, 'Editing a Lyrics background cannot change Program before a take');
    assert.deepEqual(state.outputs, baseline.outputs, 'Pinned output snapshots stay unchanged while editing');
    assert.deepEqual(state.sources, baseline.sources, 'Per-layer backgrounds cannot modify the shared Lyrics source');
  };
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`Unexpected native ${dialog.type()} dialog`); void dialog.dismiss(); });
  await page.goto(`${base}/studio`);
  await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  const inspector = page.getByRole('complementary', { name: 'Design inspector' });
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  const selectLayer = async (sceneId = firstScene, layerId = firstLayer) => {
    await page.locator(`.scene-card[data-scene-id="${sceneId}"]`).click();
    await page.locator(`.layer-row[data-layer-id="${layerId}"]`).click();
    await inspector.getByRole('button', { name: 'Edit lyrics background', exact: true }).waitFor();
  };
  const open = async () => inspector.getByRole('button', { name: 'Edit lyrics background', exact: true }).click();
  const type = name => page.getByRole('button', { name, exact: true });
  await selectLayer(); await open();
  await type('Image').click();
  await page.getByRole('button', { name: `Use background ${imageName}`, exact: true }).click();
  await until(async () => (await getLayer()).mediaBackground?.url === `media/backgrounds/${imageName}`, 'selected image persists');
  assert.equal((await getLayer()).mediaBackground.kind, 'image');
  await page.getByLabel('Background fit', { exact: true }).selectOption('contain');
  const dim = page.getByLabel('Dim background', { exact: true });
  await dim.press('End'); await dim.press('ArrowLeft');
  await until(async () => {
    const background = (await getLayer()).mediaBackground;
    return background.fit === 'contain' && Math.abs(background.dim - .99) < .001;
  }, 'image fit and dim persist');
  for (const scope of [page.locator('.preview-panel'), page.locator(`.scene-card[data-scene-id="${firstScene}"]`)]) {
    const poster = scope.locator(`.poster-layer[data-layer-id="${firstLayer}"]`);
    await until(() => poster.locator('.layer-media-background').evaluate(image => image.complete && image.naturalWidth > 0), 'image background is decoded in static Preview and scene thumbnail');
    assert.equal(await poster.locator('.layer-media-background').evaluate(image => getComputedStyle(image).objectFit), 'contain');
    assert.equal(await poster.locator('.layer-media-dim').evaluate(dim => getComputedStyle(dim).opacity), '0.99');
    assert.equal(await poster.locator('video').count(), 0, 'Static scene posters do not start video decoders');
  }
  assert.equal((await getLayer(secondScene, secondLayer)).mediaBackground, undefined, 'Another scene sharing the Lyrics channel remains independent');
  await unchangedLive();
  checks.push('image selection, fit, and dim persist per layer while Program and shared channel stay unchanged');

  await type('Video').click();
  await page.getByRole('button', { name: `Use background ${videoName}`, exact: true }).click();
  await until(async () => (await getLayer()).mediaBackground?.url === `media/backgrounds/${videoName}`, 'selected video persists');
  const loop = page.getByLabel('Loop background video', { exact: true });
  await loop.uncheck();
  await until(async () => (await getLayer()).mediaBackground.loop === false, 'video loop can be disabled');
  await loop.check();
  await until(async () => (await getLayer()).mediaBackground.loop === true, 'video loop can be enabled');
  let releaseSave, saveStarted = false;
  const heldSave = new Promise(resolve => { releaseSave = resolve; });
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT' || saveStarted) return route.continue();
    saveStarted = true; await heldSave; return route.continue();
  });
  await page.getByLabel('Background fit', { exact: true }).selectOption('cover');
  await until(() => saveStarted, 'held background save begins');
  await dim.press('Home'); await dim.press('ArrowRight');
  await loop.uncheck();
  releaseSave();
  await until(async () => {
    const background = (await getLayer()).mediaBackground;
    return background.fit === 'cover' && Math.abs(background.dim - .01) < .001 && background.loop === false;
  }, 'rapid fit, dim, and loop edits all survive a delayed save');
  await page.unroute('**/api/studio');
  checks.push('rapid fit, dim, and loop edits merge safely while the first save is delayed');
  const previewVideos = page.locator('video').filter({ visible: true });
  for (const video of await previewVideos.all()) assert.equal(await video.evaluate(element => element.muted), true, 'Background previews never output the clip audio');
  await unchangedLive();
  checks.push('video background selection and loop controls persist; visible video previews stay muted');
  await page.screenshot({ path: path.join(dir, 'lyrics-background-video-popover.png'), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  const popover = page.locator('.lyrics-background-popover');
  await until(async () => {
    const bounds = await popover.boundingBox();
    return bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1366 && bounds.y + bounds.height <= 768;
  }, 'background popover remains within a laptop viewport');
  for (const control of [page.getByLabel('Background fit', { exact: true }), dim, loop]) {
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1366 && bounds.y + bounds.height <= 768, 'Every background setting remains reachable on a laptop');
  }
  await page.screenshot({ path: path.join(dir, 'lyrics-background-laptop-popover.png'), fullPage: true });
  await page.setViewportSize({ width: 1728, height: 1117 });
  checks.push('popover fits a 1366×768 laptop and all settings remain accessible');

  await page.keyboard.press('Escape');
  const savedVideo = structuredClone((await getLayer()).mediaBackground);
  await page.reload();
  await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await selectLayer(); await open();
  assert.deepEqual((await getLayer()).mediaBackground, savedVideo, 'Background survives page reload');
  assert.equal(await page.getByLabel('Loop background video', { exact: true }).isChecked(), false);
  await page.keyboard.press('Escape');
  await command({ type: 'take', sceneId: firstScene });
  assert.deepEqual((await get()).program.layers.find(layer => layer.id === firstLayer).mediaBackground, savedVideo, 'Take copies the selected background into Program');
  checks.push('saved background reloads correctly and reaches Program only after a take');

  // This is the disposable station's separate renderer, never the operator's
  // engine. Check actual decoded output frames, not just the saved document.
  const started = await request.post(`${base}/api/studio/engine/start`);
  assert.equal(started.status(), 200, await started.text());
  assert.equal((await started.json()).state, 'running');
  const programVideo = page.locator('.program-panel video').first();
  const sampleProgram = () => programVideo.evaluate(video => {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colorful = 0, signature = 5381;
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 75) colorful++;
      signature = ((signature * 33) ^ pixels[i] ^ (pixels[i + 1] << 8) ^ (pixels[i + 2] << 16)) >>> 0;
    }
    return { colorful, signature };
  });
  const firstFrame = await until(async () => { const frame = await sampleProgram(); return frame?.colorful > 100 ? frame : null; }, 'Program decodes the colorful synthetic video background', 20000);
  await page.waitForTimeout(350);
  await until(async () => { const frame = await sampleProgram(); return frame?.colorful > 100 && frame.signature !== firstFrame.signature; }, 'Program background advances through real video frames', 6000);
  await page.screenshot({ path: path.join(dir, 'lyrics-background-live-program.png'), fullPage: true });
  await selectLayer(); await open();
  await type('Video').click();
  await page.getByRole('button', { name: `Use background ${brokenVideoName}`, exact: true }).click();
  await until(async () => (await getLayer()).mediaBackground?.url === `media/backgrounds/${brokenVideoName}`, 'unsupported draft background is selected');
  await until(async () => {
    const status = await (await request.get(`${base}/api/studio/status`)).json();
    return status.backgroundErrors?.[`media/backgrounds/${brokenVideoName}`] && status.sources.lyrics_background_source === 'ready';
  }, 'playback error is reported separately from the ready Lyrics channel', 15000);
  await page.getByRole('alert').filter({ hasText: 'Background video cannot be played' }).waitFor();
  assert.deepEqual((await get()).program.layers.find(layer => layer.id === firstLayer).mediaBackground, savedVideo, 'An invalid draft background cannot replace the working Program background');
  await page.getByRole('button', { name: 'Choose media', exact: true }).click();
  await page.getByRole('button', { name: `Use background ${videoName}`, exact: true }).click();
  await until(async () => (await getLayer()).mediaBackground?.url === savedVideo.url, 'working video restored after invalid-file check');
  await until(async () => !(await (await request.get(`${base}/api/studio/status`)).json()).backgroundErrors?.[`media/backgrounds/${brokenVideoName}`], 'unused background warning clears');
  await page.keyboard.press('Escape');
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);
  checks.push('isolated renderer decodes the selected MP4 and Program displays advancing video frames');
  checks.push('unsupported media gives a clear background warning while Lyrics and Program remain intact');

  await selectLayer(); await open();
  await type('None').click();
  await until(async () => !(await getLayer()).mediaBackground && (await getLayer()).background === '#00000000', 'None clears image/video and color');
  await type('Color').click();
  await until(async () => !(await getLayer()).mediaBackground && (await getLayer()).background !== '#00000000', 'Color uses layer fill');
  await type('Image').click();
  await page.getByRole('button', { name: `Use background ${imageName}`, exact: true }).click();
  await until(async () => (await getLayer()).mediaBackground?.kind === 'image', 'image restored for remove test');
  await page.getByRole('button', { name: 'Remove background', exact: true }).click();
  await until(async () => !(await getLayer()).mediaBackground, 'Remove background clears the per-layer media');
  checks.push('None, Color, and Remove background clear stale media settings');

  // A late upload response must never attach to a different scene/layer.
  await type('Image').click();
  let releaseUpload, uploadStarted = false;
  const heldUpload = new Promise(resolve => { releaseUpload = resolve; });
  await page.route('**/api/media/backgrounds*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    uploadStarted = true; await heldUpload;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: `media/backgrounds/${imageName}`, thumbnail: null }) }).catch(() => {});
  });
  const beforeUpload = structuredClone(await getLayer());
  await page.getByLabel('Upload lyrics background', { exact: true }).setInputFiles(path.join(mediaDir, imageName));
  await until(() => uploadStarted, 'upload request begins');
  await selectLayer(secondScene, secondLayer);
  releaseUpload(); await page.unroute('**/api/media/backgrounds*');
  await page.waitForTimeout(300);
  assert.deepEqual(await getLayer(), beforeUpload, 'Closing the original editor cancels an unfinished upload selection');
  assert.equal((await getLayer(secondScene, secondLayer)).mediaBackground, undefined, 'Late upload never modifies the newly selected scene');
  assert.equal(await page.getByLabel('Upload lyrics background', { exact: true }).isVisible(), false, 'Changing scene closes the popover');
  checks.push('switching scene safely closes the popover and cancels a pending media selection');

  // Restart only this disposable backend to prove on-disk persistence.
  await selectLayer(); await open(); await type('Video').click();
  await page.getByRole('button', { name: `Use background ${videoName}`, exact: true }).click();
  await until(async () => (await getLayer()).mediaBackground?.kind === 'video', 'video is saved before station restart');
  const beforeRestart = structuredClone((await getLayer()).mediaBackground);
  await page.close(); page = null;
  await stopServer(); server = launchServer(); await waitForStation(); await login();
  assert.deepEqual((await getLayer()).mediaBackground, beforeRestart, 'The station reloads the background from disk after restart');
  assert.equal((await getLayer(secondScene, secondLayer)).mediaBackground, undefined, 'The other Lyrics scene stays independent after restart');
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  checks.push('background media and settings survive a station restart');
  console.log(JSON.stringify({ checks, artifacts: dir }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(dir, 'lyrics-background-failed.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: error.message, stack: error.stack, checks, errors, artifacts: dir, logs }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close(); await stopServer();
}
