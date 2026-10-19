// Run after npm run build. Every fixture belongs to a temporary station. No
// physical inputs, cloud services, or operator production files are touched.
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
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-studio-animation-'));
const port = Number(process.env.LUMEN_ANIMATION_TEST_PORT ?? 3419), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page, request;
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
const errors = [], checks = [];
async function until(fn, label, timeout = 15000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const layer = (id, patch = {}) => ({ id, name: 'Animated card', kind: 'shape', visible: true, locked: false,
  x: 50, y: 40, width: 20, height: 20, opacity: 1, fit: 'contain', text: '',
  color: '#ffffff', background: '#ffffff', fontSize: 48, fontWeight: 500, align: 'center', radius: 0, ...patch });
const frame = (offset, patch = {}) => ({ offset, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0, ...patch });
const animation = { enabled: true, preset: 'custom', durationMs: 1500, delayMs: 200, easing: 'linear',
  keyframes: [frame(0, { x: -600, opacity: 0 }), frame(.5, { x: -250, opacity: .5 }), frame(1)] };
const animatedId = 'animation_scene', layerId = 'animation_card', secondLayerId = 'animation_rehearsal_marker', blackId = 'animation_black', blueId = 'animation_blue';

// Decoded white-pixel luminance/centroid proves both opacity and translation.
// Merely checking a controller CSS class could miss a static live recording.
const sample = locator => locator.evaluate(video => {
  const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 108;
  const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 192, 108);
  const bytes = ctx.getImageData(0, 0, 192, 108).data;
  let peak = 0, energy = 0, weightedX = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const white = Math.min(bytes[i], bytes[i + 1], bytes[i + 2]);
    peak = Math.max(peak, white); energy += white; weightedX += white * ((i / 4) % 192 + .5);
  }
  return { peak, energy: energy / (192 * 108), x: energy ? weightedX / energy / 192 : null, corner: [...bytes.slice(0, 3)] };
});
const finalPose = value => value.peak > 230 && Math.abs(value.x - .6) < .012;
const intermediatePose = value => value.peak > 35 && value.peak < 215 && value.x < .585;
const isBlue = value => value.corner[2] > 220 && value.corner[0] < 25 && value.corner[1] < 25;

try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station start', 30000);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 } });
  request = context.request;
  const login = await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } });
  assert.equal(login.status(), 200, await login.text());
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const save = async mutate => {
    const state = await get(); mutate(state);
    const response = await request.put(`${base}/api/studio`, { data: state });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const command = async command => {
    const state = await get(), response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const currentLayer = async () => (await get()).scenes.find(scene => scene.id === animatedId).layers[0];
  await save(state => {
    state.scenes.push({ id: blackId, name: 'Quiet stage', background: '#000000', layers: [] },
      { id: blueId, name: 'Pinned blue', background: '#0000ff', layers: [] },
      { id: animatedId, name: 'Motion rehearsal', background: '#000000', layers: [layer(layerId),
        layer(secondLayerId, { name: 'Rehearsal marker', x: 5, y: 5, width: 10, height: 10, background: '#000000', animation: { ...animation, preset: 'fade', keyframes: [frame(0, { opacity: 0 }), frame(1)] } }),
      ] });
    state.previewSceneId = animatedId;
  });
  await command({ type: 'take', sceneId: blackId });
  await command({ type: 'route', outputId: 'screen_main', sceneId: blueId });
  const onAir = await get();
  const unchangedAir = async label => {
    const state = await get();
    assert.deepEqual(state.program, onAir.program, `${label} must not change committed Program`);
    assert.deepEqual(state.programTransition, onAir.programTransition, `${label} must not trigger a Take`);
    assert.deepEqual(state.outputs, onAir.outputs, `${label} must not change committed output snapshots`);
  };
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.locator(`.layer-row[data-layer-id="${layerId}"]`).click();
  const preset = page.getByLabel('Animation preset', { exact: true });
  await preset.selectOption('slide-up');
  await until(async () => (await currentLayer()).animation?.preset === 'slide-up', 'animation preset saves in draft');
  await page.getByLabel('Animation duration', { exact: true }).fill('900');
  await page.getByLabel('Animation duration', { exact: true }).press('Tab');
  await page.getByLabel('Animation delay', { exact: true }).fill('120');
  await page.getByLabel('Animation delay', { exact: true }).press('Tab');
  await page.getByLabel('Animation easing', { exact: true }).selectOption('ease-out');
  await until(async () => { const value = (await currentLayer()).animation; return value?.durationMs === 900 && value.delayMs === 120 && value.easing === 'ease-out'; }, 'preset timing and easing save');
  await unchangedAir('Preset edits');
  checks.push('preset, duration, delay and easing edit only the draft');

  // Cancel and Play/Scrub are local, including when an actual station renderer
  // is running. Only Apply commits the custom keyframe document.
  await page.getByRole('button', { name: 'Start engine', exact: true }).click();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).state === 'running', 'station renderer', 45000);
  const programVideo = page.locator('.program-panel video');
  await until(() => programVideo.evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'Program video');
  await page.getByRole('button', { name: 'Open animation editor', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Animation editor', exact: true });
  await editor.waitFor();
  const beforeCancel = await get();
  await editor.getByLabel('Editor animation duration', { exact: true }).fill('3210');
  await editor.getByLabel('Editor animation duration', { exact: true }).press('Tab');
  await editor.getByLabel('Animation playhead', { exact: true }).evaluate(input => {
    input.value = String((Number(input.min) + Number(input.max)) / 2);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await editor.getByRole('button', { name: 'Play animation preview', exact: true }).click();
  const editorDuration = editor.getByLabel('Editor animation duration', { exact: true });
  await editorDuration.fill('5432');
  const durationPlayhead = Number.parseInt(await editor.locator('output').textContent(), 10);
  await page.waitForTimeout(600);
  assert.equal(await editorDuration.inputValue(), '5432', 'An unfinished duration survives continuous playhead rerenders');
  assert.ok(Number.parseInt(await editor.locator('output').textContent(), 10) > durationPlayhead + 300, 'The animation clock continues while a numeric draft is being typed');
  assert.match(await editor.locator('output').textContent(), /3330\s*ms/, 'An unfinished duration does not change the local animation yet');
  await editorDuration.press('Enter');
  assert.equal(await editorDuration.inputValue(), '5432', 'Enter commits the duration without a focus change');
  assert.match(await editor.locator('output').textContent(), /5552\s*ms/, 'The committed duration updates the local animation');
  await editor.getByRole('button', { name: 'Play animation preview', exact: true }).click();
  const editorX = editor.getByLabel('Keyframe X', { exact: true });
  await editorX.fill('-777');
  const keyframePlayhead = Number.parseInt(await editor.locator('output').textContent(), 10);
  await page.waitForTimeout(600);
  assert.equal(await editorX.inputValue(), '-777', 'An unfinished keyframe value survives continuous playhead rerenders');
  assert.ok(Number.parseInt(await editor.locator('output').textContent(), 10) > keyframePlayhead + 300, 'The animation clock continues while a keyframe draft is being typed');
  await editorX.press('Enter');
  assert.equal(await editorX.inputValue(), '-777', 'Enter commits the original keyframe draft');
  const editedPose = await editor.locator(`.poster-layer[data-layer-id="${layerId}"]`).evaluate(element => Number.parseFloat(element.style.left));
  assert.ok(Math.abs(editedPose - (50 - 777 / 19.2)) < .001, 'The committed keyframe changes the local preview pose');
  await editorX.fill('99999'); await editorX.press('Enter');
  assert.equal(await editorX.inputValue(), '3840', 'Buffered keyframe inputs retain their existing numeric limits');
  await editorDuration.fill('10'); await editorDuration.press('Enter');
  assert.equal(await editorDuration.inputValue(), '100', 'Buffered timing inputs retain their existing duration minimum');
  assert.equal((await get()).revision, beforeCancel.revision, 'Modal playback and scrubbing must not save any document revision');
  await unchangedAir('Editor playback');
  await editor.getByRole('button', { name: 'Cancel animation changes', exact: true }).click();
  assert.deepEqual((await currentLayer()).animation, beforeCancel.scenes.find(scene => scene.id === animatedId).layers[0].animation, 'Cancel discards editor changes');
  checks.push('duration and keyframe drafts survive active playback, commit with Enter, preserve limits, and remain local until Apply');
  await page.getByRole('button', { name: 'Open animation editor', exact: true }).click();
  await editor.getByLabel('Editor animation preset', { exact: true }).selectOption('custom');
  await editor.getByLabel('Editor animation duration', { exact: true }).fill('1500');
  await editor.getByLabel('Editor animation duration', { exact: true }).press('Tab');
  await editor.getByLabel('Editor animation delay', { exact: true }).fill('200');
  await editor.getByLabel('Editor animation delay', { exact: true }).press('Tab');
  await editor.getByLabel('Editor animation easing', { exact: true }).selectOption('linear');
  await editor.getByRole('button', { name: 'Keyframe 1', exact: true }).click();
  await editor.getByLabel('Keyframe X', { exact: true }).fill('-600');
  await editor.getByLabel('Keyframe X', { exact: true }).press('Tab');
  await editor.getByLabel('Keyframe Y', { exact: true }).fill('0');
  await editor.getByLabel('Keyframe Y', { exact: true }).press('Tab');
  await editor.getByLabel('Keyframe opacity', { exact: true }).fill('0');
  await editor.getByLabel('Keyframe opacity', { exact: true }).press('Tab');
  await editor.getByRole('button', { name: 'Add keyframe', exact: true }).click();
  await editor.getByLabel('Keyframe time', { exact: true }).fill('50');
  await editor.getByLabel('Keyframe time', { exact: true }).press('Tab');
  await editor.getByLabel('Keyframe X', { exact: true }).fill('-250');
  await editor.getByLabel('Keyframe X', { exact: true }).press('Tab');
  await editor.getByLabel('Keyframe opacity', { exact: true }).fill('50');
  await editor.getByLabel('Keyframe opacity', { exact: true }).press('Tab');
  await editor.getByRole('button', { name: 'Keyframe 3', exact: true }).click();
  assert.ok(await editor.getByLabel('Keyframe X', { exact: true }).isDisabled(), 'Final keyframe preserves the precise design position');
  await page.screenshot({ path: path.join(dir, 'animation-editor-desktop.png'), fullPage: true });
  await editor.getByRole('button', { name: 'Apply animation', exact: true }).click();
  await until(async () => { const value = (await currentLayer()).animation; return value?.preset === 'custom' && value.durationMs === 1500 && value.delayMs === 200 && value.keyframes.length === 3; }, 'custom editor Apply saves');
  assert.deepEqual((await currentLayer()).animation, animation, 'Custom motion values persist exactly');
  await unchangedAir('Custom animation Apply');
  await preset.selectOption('none');
  await until(async () => (await currentLayer()).animation?.enabled === false, 'None disables custom animation');
  assert.deepEqual((await currentLayer()).animation, { ...animation, enabled: false }, 'None preserves the saved custom keyframes and timing');
  await preset.selectOption('custom');
  await until(async () => (await currentLayer()).animation?.enabled === true, 'Custom re-enables the saved animation');
  assert.deepEqual((await currentLayer()).animation, animation, 'Re-enabling Custom restores the unchanged saved motion');
  assert.equal(await editor.count(), 0, 'Restoring a saved custom animation does not unexpectedly open the editor');
  checks.push('local editor Play/Scrub, cancel isolation, custom intermediate keyframe, exact Apply and fixed final pose');

  const previewRevision = (await get()).revision;
  await page.getByRole('button', { name: 'Preview layer animation', exact: true }).click();
  await page.waitForTimeout(220);
  const localPoster = page.locator('.preview-panel [data-animation-preview]');
  assert.ok(await localPoster.isVisible(), 'Local rehearsal overlays the running-engine Preview without publishing it');
  const localPose = await localPoster.locator(`[data-layer-id="${layerId}"]`).evaluate(element => ({ left: parseFloat(element.style.left), opacity: Number(getComputedStyle(element).opacity) }));
  assert.ok(localPose.left < 50 && localPose.opacity < 1, 'Local Preview shows the entry translation and opacity, not only its final layout');
  assert.equal(await localPoster.locator(`[data-layer-id="${secondLayerId}"]`).evaluate(element => Number(getComputedStyle(element).opacity)), 1, 'Layer rehearsal leaves other elements in their design pose');
  assert.equal((await get()).revision, previewRevision, 'Inspector Preview does not create a production save');
  await unchangedAir('Local animation preview with engine running');
  await page.screenshot({ path: path.join(dir, 'animation-studio-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Stop animation preview', exact: true }).press('Space');
  await until(async () => await localPoster.count() === 0, 'Space on Return to layout stops rehearsal');
  assert.equal((await get()).revision, previewRevision, 'Space on Return to layout must not trigger a global Cut');
  await unchangedAir('Space on Return to layout');
  await page.getByRole('button', { name: 'Preview scene animations', exact: true }).click();
  await page.waitForTimeout(220);
  assert.ok(await localPoster.isVisible(), 'Whole-scene preview uses the isolated rehearsal surface');
  const scenePoses = await localPoster.locator('.poster-layer').evaluateAll(elements => elements.map(element => Number(getComputedStyle(element).opacity)));
  assert.ok(scenePoses.length === 2 && scenePoses.every(value => value < 1), 'Whole-scene rehearsal runs all enabled elements and their own delays');
  await page.getByRole('button', { name: 'Stop animation preview', exact: true }).click();
  await until(async () => await localPoster.count() === 0, 'return to layout after whole-scene rehearsal');
  assert.equal((await get()).revision, previewRevision, 'Scene rehearsal and stopping are not document edits');
  await unchangedAir('Whole-scene rehearsal');
  checks.push('saved Custom survives None/re-enable; layer and whole-scene rehearsals and keyboard Return never Take or save');
  const follower = await context.newPage(); await follower.goto(`${base}/studio/output/screen_broadcast`);
  const pinned = await context.newPage(); await pinned.goto(`${base}/studio/output/screen_main`);
  const followerVideo = follower.locator('video'), pinnedVideo = pinned.locator('video');
  await until(() => followerVideo.evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'following output stream');
  await until(() => pinnedVideo.evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'pinned output stream');
  await until(async () => isBlue(await sample(pinnedVideo)), 'pinned blue fixture');
  const recordingResponse = await request.post(`${base}/api/studio/recordings`, { data: { name: 'Element animation pixels' } });
  assert.equal(recordingResponse.status(), 201, await recordingResponse.text());
  const recording = await recordingResponse.json();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).recording?.bytes > 1000, 'recording baseline chunks', 15000);
  const samples = [];
  const take = await command({ type: 'take', sceneId: animatedId });
  const previewVideo = page.locator('.preview-panel video');
  await until(() => previewVideo.evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'static design Preview stream');
  const begun = Date.now();
  while (Date.now() - begun < 2200) {
    samples.push(await Promise.all([sample(programVideo), sample(followerVideo), sample(pinnedVideo), sample(previewVideo)]));
    await page.waitForTimeout(55);
  }
  for (const index of [0, 1]) {
    assert.ok(samples.some(values => values[index].peak < 25), `Bus ${index} includes the hidden delayed entry`);
    assert.ok(samples.some(values => intermediatePose(values[index])), `Bus ${index} decodes intermediate opacity and translated position`);
    assert.ok(finalPose(samples.at(-1)[index]), `Bus ${index} reaches the exact final design pose`);
  }
  assert.ok(samples.every(values => isBlue(values[2])), 'A pinned output does not participate in Program element motion');
  assert.ok(samples.every(values => finalPose(values[3])), 'Preview continues to show the unchanged design pose throughout live entry');
  await page.screenshot({ path: path.join(dir, 'animation-live-final.png'), fullPage: true });
  checks.push('actual delayed/custom opacity and translation pixels in Program and follower, independent pin and static Preview');

  // Recording must encode the very same element motion, not a still final
  // composition. Decode small frames for a bounded, pixel-level assertion.
  assert.equal((await request.post(`${base}/api/studio/recordings/${recording.id}/stop`)).status(), 200);
  await until(async () => (await (await request.get(`${base}/api/studio/recordings`)).json()).find(item => item.id === recording.id)?.status === 'complete', 'recording finalized', 30000);
  const media = path.join(dir, 'recordings', recording.id, 'recording.webm');
  const decoded = execFileSync(ffmpeg, ['-v', 'error', '-i', media, '-an', '-vf', 'fps=10,scale=192:108', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 20 * 1024 * 1024 });
  const recorded = [];
  for (let start = 0; start + 192 * 108 * 3 <= decoded.length; start += 192 * 108 * 3) {
    let peak = 0, energy = 0, weightedX = 0;
    for (let pixel = 0; pixel < 192 * 108; pixel++) {
      const offset = start + pixel * 3, white = Math.min(decoded[offset], decoded[offset + 1], decoded[offset + 2]);
      peak = Math.max(peak, white); energy += white; weightedX += white * (pixel % 192 + .5);
    }
    recorded.push({ peak, x: energy ? weightedX / energy / 192 : null });
  }
  assert.ok(recorded.some(value => value.peak < 25) && recorded.some(intermediatePose) && recorded.some(finalPose), 'Saved WebM contains hidden, moving intermediate and final animation frames');
  checks.push('FFmpeg-decoded recording includes element motion, not only the controller preview');

  const repeatSamples = [];
  const repeat = await command({ type: 'take', sceneId: animatedId });
  assert.notEqual(repeat.programTransition.id, take.programTransition.id, 'A deliberate repeated Take receives a new animation run');
  const repeatStart = Date.now();
  while (Date.now() - repeatStart < 1900) { repeatSamples.push(await sample(programVideo)); await page.waitForTimeout(60); }
  assert.ok(repeatSamples.some(value => value.peak < 25) && repeatSamples.some(intermediatePose) && finalPose(repeatSamples.at(-1)), 'Taking the same scene again deliberately replays its entry');
  const stableToken = (await get()).programTransition.id;
  await save(state => { state.scenes.find(scene => scene.id === animatedId).name = 'Motion rehearsal draft'; });
  await command({ type: 'blank', outputId: 'screen_main', blanked: true });
  await command({ type: 'blank', outputId: 'screen_main', blanked: false });
  for (let index = 0; index < 4; index++) {
    assert.ok(finalPose(await sample(programVideo)), 'Inspector/draft and unrelated output saves cannot restart Program entry');
    await page.waitForTimeout(110);
  }
  assert.equal((await get()).programTransition.id, stableToken);

  const routed = await command({ type: 'route', outputId: 'screen_main', sceneId: animatedId });
  assert.ok(routed.outputs[0].sceneRunId, 'Explicit pinning receives an independent animation run identity');
  const pinnedSamples = [], pinStart = Date.now();
  while (Date.now() - pinStart < 2100) {
    const [output, program] = await Promise.all([sample(pinnedVideo), sample(programVideo)]);
    pinnedSamples.push(output); assert.ok(finalPose(program), 'Pinning a scene cannot restart Program animation');
    await page.waitForTimeout(60);
  }
  assert.ok(pinnedSamples.some(value => value.peak < 25) && pinnedSamples.some(intermediatePose) && finalPose(pinnedSamples.at(-1)), 'Explicit pinning animates its own committed snapshot');
  await command({ type: 'blank', outputId: 'screen_main', blanked: true });
  await until(async () => (await sample(pinnedVideo)).peak < 25, 'pin blank');
  await command({ type: 'blank', outputId: 'screen_main', blanked: false });
  await until(async () => finalPose(await sample(pinnedVideo)), 'pin restored final pose');
  for (let index = 0; index < 4; index++) { assert.ok(finalPose(await sample(pinnedVideo)), 'Unblank does not replay the pinned entry'); await page.waitForTimeout(90); }
  checks.push('explicit repeated Takes and independent pin runs; draft edits and blank/unblank never replay');

  await command({ type: 'take', sceneId: blackId });
  await until(async () => (await sample(programVideo)).peak < 25, 'black before scene Fade');
  await command({ type: 'take', sceneId: animatedId, transition: 'fade', durationMs: 500 });
  const fadeSamples = [], fadeStart = Date.now();
  while (Date.now() - fadeStart < 2100) { fadeSamples.push(await sample(programVideo)); await page.waitForTimeout(60); }
  assert.ok(fadeSamples.some(intermediatePose) && finalPose(fadeSamples.at(-1)), 'Scene Fade and element entry share the actual compositor without suppressing motion');
  assert.ok(finalPose(await sample(pinnedVideo)), 'Program Fade does not disturb a finished independent pin');
  checks.push('Cut and Fade both run element entry while independent output snapshots remain unchanged');

  // Opacity applies once to a whole element, including its background and
  // media/text. Applying it separately to a red fill and a white image would
  // incorrectly leave red behind the semi-transparent white draw.
  const whitePng = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=128x128', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
  const uploaded = await request.post(`${base}/api/media/backgrounds`, { multipart: { file: { name: 'animation-white.png', mimeType: 'image/png', buffer: whitePng } } });
  assert.equal(uploaded.status(), 200, await uploaded.text());
  const whiteMedia = await uploaded.json(), whiteSourceId = 'animation_white_image';
  const halfAnimation = { enabled: true, preset: 'custom', durationMs: 1500, delayMs: 0, easing: 'linear',
    keyframes: [frame(0, { opacity: 0 }), frame(.3, { opacity: .5 }), frame(.7, { opacity: .5 }), frame(1)] };
  await save(state => {
    state.sources.push({ id: whiteSourceId, name: 'Opacity white fixture', kind: 'image', url: whiteMedia.path, loop: false, audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } });
    const covered = { kind: 'source', sourceId: whiteSourceId, background: '#ff0000', x: 0, y: 0, width: 100, height: 100, fit: 'cover' };
    state.scenes.push({ id: 'opacity_static', name: 'Grouped static opacity', background: '#000000', layers: [layer('opacity_static_layer', { ...covered, opacity: .5 })] },
      { id: 'opacity_animated', name: 'Grouped animated opacity', background: '#000000', layers: [layer('opacity_animated_layer', { ...covered, animation: halfAnimation })] });
  });
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).sources[whiteSourceId] === 'ready', 'white image fixture loaded');
  await command({ type: 'take', sceneId: 'opacity_static' });
  const staticOpacity = await until(async () => { const value = await sample(programVideo); return value.corner[1] > 90 && value.corner[1] < 170 ? value : null; }, 'static half-opacity frame');
  assert.ok(Math.abs(staticOpacity.corner[0] - staticOpacity.corner[1]) < 12 && Math.abs(staticOpacity.corner[1] - staticOpacity.corner[2]) < 12, `Static opacity composites the white element once, not red twice: ${staticOpacity.corner}`);
  await command({ type: 'take', sceneId: 'opacity_animated' });
  const opacitySamples = [], opacityStart = Date.now();
  while (Date.now() - opacityStart < 1800) { opacitySamples.push(await sample(programVideo)); await page.waitForTimeout(55); }
  const halfFrames = opacitySamples.filter(value => value.corner[1] > 90 && value.corner[1] < 170);
  assert.ok(halfFrames.length >= 2, 'Animated opacity has measurable intermediate frames');
  assert.ok(halfFrames.every(value => Math.abs(value.corner[0] - value.corner[1]) < 12 && Math.abs(value.corner[1] - value.corner[2]) < 12), `Animated opacity composites media and fill as one layer: ${JSON.stringify(halfFrames)}`);
  assert.ok(finalPose(await sample(pinnedVideo)), 'Opacity fixture Takes never change the independent pin');
  await command({ type: 'take', sceneId: animatedId });
  await until(async () => finalPose(await sample(programVideo)), 'main motion fixture restored');
  checks.push('static and animated grouped opacity match a single white element over black, without red-fill bleed');

  const previousStreams = await Promise.all([programVideo.evaluate(video => video.srcObject?.id), pinnedVideo.evaluate(video => video.srcObject?.id)]);
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).state === 'offline', 'engine stopped');
  assert.equal((await request.post(`${base}/api/studio/engine/start`)).status(), 200);
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).state === 'running', 'engine restarted', 45000);
  await until(async () => {
    const next = await Promise.all([programVideo.evaluate(video => video.readyState >= 2 ? video.srcObject?.id : null), pinnedVideo.evaluate(video => video.readyState >= 2 ? video.srcObject?.id : null)]);
    return next.every((id, index) => id && id !== previousStreams[index]);
  }, 'fresh WebRTC streams after renderer restart', 20000);
  await until(async () => finalPose(await sample(programVideo)) && finalPose(await sample(pinnedVideo)), 'persisted outputs reconnect in final pose', 20000);
  for (let index = 0; index < 8; index++) {
    assert.ok(finalPose(await sample(programVideo)) && finalPose(await sample(pinnedVideo)), 'Restarted renderer must not replay persisted Program or pin entry');
    await page.waitForTimeout(110);
  }
  checks.push('engine restart resumes final Program and pinned poses without historical entry replay');
  await page.getByRole('button', { name: 'Open animation editor', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => { const bounds = await editor.boundingBox(); return bounds.x >= 0 && bounds.x + bounds.width <= 390; }, 'Animation editor fits a narrow screen');
  await editor.getByRole('button', { name: 'Apply animation', exact: true }).click({ trial: true });
  await page.screenshot({ path: path.join(dir, 'animation-editor-mobile.png'), fullPage: true });
  await editor.getByRole('button', { name: 'Cancel animation changes', exact: true }).click();
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  await fs.writeFile(path.join(dir, 'pixel-samples.json'), JSON.stringify({ samples, recorded, repeatSamples, pinnedSamples, fadeSamples, staticOpacity, opacitySamples }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'animation-failure.png'), fullPage: true }).catch(() => {});
  if (page) console.error('Dialog layout:', await page.locator('.layer-animation-editor').evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { x: rect.x, width: rect.width, height: rect.height, viewport: innerWidth, cssWidth: style.width, minWidth: style.minWidth, maxWidth: style.maxWidth, padding: style.padding, boxSizing: style.boxSizing, transform: style.transform, translate: style.translate };
  }).catch(() => null));
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]);
}
