// Run after npm run build. Uses isolated data and fake camera/microphone devices;
// never edits the operator's deck or captures physical devices.
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
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-studio-smoke-'));
const port = Number(process.env.LUMEN_TEST_PORT ?? 3417), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Refuse an occupied port instead of accidentally testing a real station.
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
// Reproduce the reported stale Vite address without depending on port 5173.
const staleRendererUrl = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => resolve(`http://127.0.0.1:${address.port}`)); });
});
let logs = '', browser, page, request;
function launchServer() {
  const child = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: staleRendererUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  return child;
}
let server = launchServer();
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(2000) })).ok, 'server start');
  assert.equal((await fetch(`${base}/api/studio/engine/start`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/studio/engine/bootstrap`)).status, 401);
  const audioFixture = path.join(dir, 'test-tone.wav');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:a', 'pcm_s16le', audioFixture]);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audioFixture}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, permissions: ['camera', 'microphone'] });
  request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const channelKinds = ['presentation', 'scripture', 'lyrics'];
  const fixtureContent = { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: channelKinds.map(kind => ({ id: kind, name: kind === 'presentation' ? 'Announcements' : kind === 'lyrics' ? 'Worship lyrics' : 'Scripture', kind, playlistId: `p_${kind}`, defaultMode: 'manual' })),
    playlists: channelKinds.map(kind => ({ id: `p_${kind}`, name: kind, items: [] })) };
  const seedContent = await request.put(`${base}/api/content`, { data: fixtureContent });
  assert.equal(seedContent.status(), 200, await seedContent.text());
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const command = async command => { const state = await get(); const r = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } }); assert.equal(r.status(), 200, await r.text()); return r.json(); };
  page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/studio`); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Scripture — scripture', exact: true }).waitFor();
  const studioLiveButton = page.locator('.lumen-header').getByRole('button', { name: 'Open Live View', exact: true });
  const cutButton = page.getByRole('button', { name: 'Cut', exact: true });
  const fadeButton = page.getByRole('button', { name: 'Fade', exact: true });
  const fadeDuration = page.getByLabel('Fade duration', { exact: true });
  assert.equal(await fadeDuration.inputValue(), '300');
  assert.equal(await cutButton.getAttribute('aria-keyshortcuts'), 'Space');
  assert.equal(await fadeButton.getAttribute('aria-keyshortcuts'), 'Shift+Space');
  assert.equal(await page.getByRole('button', { name: 'Take to Program' }).count(), 0, 'The large Take button is replaced, not duplicated');
  for (const width of [1512, 1280, 1024, 900, 768, 390]) {
    await page.setViewportSize({ width, height: 982 });
    if (width === 390) await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
    await studioLiveButton.click({ trial: true });
    const bounds = await studioLiveButton.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `Studio live-view control fits at ${width}px`);
    assert.ok(await page.getByRole('button', { name: 'Start engine', exact: true }).isVisible());
    assert.ok(await page.getByRole('button', { name: 'Recordings', exact: true }).isVisible());
    await cutButton.scrollIntoViewIfNeeded();
    const cutBounds = await cutButton.boundingBox(), fadeBounds = await fadeButton.boundingBox();
    assert.ok(cutBounds.x >= 0 && cutBounds.x + cutBounds.width <= width && fadeBounds.x >= 0 && fadeBounds.x + fadeBounds.width <= width, `Transition buttons fit at ${width}px`);
    if (width === 1512 || width === 390) {
      const previewBounds = await page.locator('.preview-panel').boundingBox();
      const programBounds = await page.locator('.program-panel').boundingBox();
      if (width === 1512) {
        assert.ok(cutBounds.x > previewBounds.x + previewBounds.width && cutBounds.x + cutBounds.width < programBounds.x, 'Desktop transitions sit between Preview and Program');
      } else {
        assert.ok(cutBounds.y > previewBounds.y + previewBounds.height && cutBounds.y + cutBounds.height < programBounds.y, 'Narrow-screen transitions sit between the stacked monitors');
        assert.ok(Math.abs(cutBounds.y - fadeBounds.y) < 2, 'Narrow-screen transition controls form a compact horizontal strip');
      }
      await page.screenshot({ path: path.join(dir, `studio-transitions-${width}.png`), fullPage: true });
      if (width === 390) await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
    }
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.locator('.studio-workspace').evaluate(el => { el.scrollTop = 0; });
  const dockLayout = () => page.evaluate(() => {
    const app = document.querySelector('.studio-app'), dock = document.querySelector('.channel-nav');
    const footer = document.querySelector('.studio-statusbar').getBoundingClientRect();
    const workspace = document.querySelector('.studio-workspace').getBoundingClientRect();
    const rect = dock.getBoundingClientRect();
    return { padding: getComputedStyle(app).paddingBottom, position: getComputedStyle(dock).position,
      dockTop: rect.top, dockBottom: rect.bottom, footerTop: footer.top, footerBottom: footer.bottom,
      workspaceBottom: workspace.bottom, height: innerHeight };
  });
  const desktopDock = await dockLayout();
  assert.equal(desktopDock.padding, '0px', 'Studio must not reserve a bottom toolbar strip');
  assert.equal(desktopDock.position, 'fixed');
  assert.equal(desktopDock.footerBottom, desktopDock.height, 'Status bar stays at the viewport edge');
  assert.ok(desktopDock.dockTop < desktopDock.workspaceBottom && desktopDock.dockBottom < desktopDock.footerTop, 'Toolbar floats over the workspace, above the status bar');
  const settledFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layoutState = await get();
  const dock = page.getByRole('navigation', { name: 'Channel toolbar' });
  const grip = page.getByRole('button', { name: 'Move toolbar', exact: true });
  const dragDock = async (dx, dy, cancel = false) => {
    const handle = await grip.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + dx, handle.y + handle.height / 2 + dy, { steps: 8 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  const initialDock = await dock.boundingBox();
  await dragDock(-180, -160);
  const movedDock = await dock.boundingBox();
  assert.ok(Math.abs(movedDock.x - initialDock.x + 180) < 2 && Math.abs(movedDock.y - initialDock.y + 160) < 2, 'Grip drags the toolbar without moving studio content');
  await dragDock(60, -60, true);
  const cancelledDock = await dock.boundingBox();
  assert.deepEqual([cancelledDock.x, cancelledDock.y], [movedDock.x, movedDock.y], 'Escape restores the original position');
  await grip.press('ArrowRight');
  assert.equal((await dock.boundingBox()).x, movedDock.x + 10, 'Keyboard nudges the toolbar');
  await page.getByRole('button', { name: 'Collapse toolbar', exact: true }).click();
  assert.ok((await dock.boundingBox()).width < initialDock.width, 'Collapsed toolbar becomes a compact pill');
  assert.equal(await page.getByTitle('Add channel', { exact: true }).isVisible(), false);
  const compactPosition = await dock.boundingBox();
  const originalWorkspace = await page.locator('.studio-workspace').boundingBox();
  await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
  assert.equal(await page.getByRole('complementary', { name: 'Design inspector' }).isVisible(), false);
  assert.ok((await page.locator('.studio-workspace').boundingBox()).width > originalWorkspace.width + 200, 'Hidden inspector gives its column back to the workspace');
  await page.reload();
  await page.getByRole('button', { name: 'Expand toolbar', exact: true }).waitFor();
  assert.deepEqual(await dock.boundingBox(), compactPosition, 'Toolbar position and collapsed state survive reload');
  await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  await page.getByRole('complementary', { name: 'Design inspector' }).waitFor();
  const canvasSection = page.locator('.inspector-group').filter({ has: page.locator('summary', { hasText: 'Canvas' }) });
  await canvasSection.locator('summary').press('Space');
  assert.equal(await canvasSection.getAttribute('open'), null, 'Inspector sections collapse with the keyboard');
  await canvasSection.locator('summary').click();
  await page.getByRole('button', { name: 'Expand toolbar', exact: true }).click();
  await page.getByRole('button', { name: 'Reset toolbar position', exact: true }).click();
  await settledFrame();
  await page.screenshot({ path: path.join(dir, 'studio-design.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('.studio-workspace').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const bottomControls = await page.locator('.output-card-bottom').last().boundingBox();
  assert.ok(bottomControls.y + bottomControls.height + 12 < (await dock.boundingBox()).y, 'Bottom output controls can scroll completely clear of the default toolbar');
  await settledFrame();
  await page.screenshot({ path: path.join(dir, 'studio-scroll-clearance.png'), fullPage: true });
  await page.getByRole('button', { name: 'Collapse toolbar', exact: true }).click();
  await dragDock(1500, -30);
  await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Expand toolbar', exact: true }).click();
  await until(async () => { const b = await dock.boundingBox(); return b.x >= 11 && b.x + b.width <= 379 && b.y >= 11 && b.y + b.height <= 801; }, 'toolbar clamps after resize and expansion');
  assert.ok((await dock.boundingBox()).width >= Math.min(initialDock.width, 366) - 1, 'Expanded toolbar keeps its useful width near the viewport edge');
  assert.ok(await page.locator('.dock-items').evaluate(el => el.scrollWidth > el.clientWidth), 'Channel overflow scrolls inside the dock, leaving grip and collapse controls accessible');
  assert.ok(await page.getByRole('button', { name: 'Collapse toolbar', exact: true }).isVisible(), 'Collapse remains accessible when channels overflow');
  await grip.press('Home');
  const mobileDock = await dockLayout();
  assert.equal(mobileDock.padding, '0px', 'Mobile Studio must not reserve a toolbar strip');
  assert.equal(mobileDock.position, 'fixed');
  assert.ok(mobileDock.dockTop > 0 && mobileDock.dockBottom < mobileDock.height);
  await page.locator('.studio-app').evaluate(el => { el.scrollTop = 0; });
  await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  const mobileInspector = await page.getByRole('complementary', { name: 'Design inspector' }).boundingBox();
  assert.ok(mobileInspector.x >= 0 && mobileInspector.x + mobileInspector.width <= 390, 'Inspector is an in-bounds drawer on narrow screens');
  await settledFrame();
  await page.screenshot({ path: path.join(dir, 'studio-mobile-inspector.png'), fullPage: true });
  await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
  // Exercise real touch pointer events on the grip without scrolling the app.
  await page.getByRole('button', { name: 'Collapse toolbar', exact: true }).click();
  const touchStart = await grip.boundingBox(), touchDock = await dock.boundingBox();
  const cdp = await context.newCDPSession(page);
  const touchPoint = { x: touchStart.x + touchStart.width / 2, y: touchStart.y + touchStart.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchPoint.x + 25, y: touchPoint.y - 80 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok(Math.abs((await dock.boundingBox()).y - touchDock.y + 80) < 2, 'Touch can drag the compact toolbar');
  await cdp.detach();
  await grip.press('Home');
  await page.getByRole('button', { name: 'Expand toolbar', exact: true }).click();
  await page.locator('.studio-app').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const mobileBottom = await page.locator('.output-card-bottom').last().boundingBox();
  assert.ok(mobileBottom.y + mobileBottom.height + 12 < (await dock.boundingBox()).y, 'Mobile output controls also clear the toolbar at the end of scroll');
  // Layout changes are local operator preferences, never a Take or scene edit.
  assert.equal((await get()).revision, layoutState.revision);
  assert.deepEqual((await get()).program, layoutState.program);
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.locator('.studio-workspace').evaluate(el => { el.scrollTop = 0; });
  await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  const present = await context.newPage();
  await present.goto(base);
  await present.getByRole('navigation', { name: 'Channel toolbar' }).waitFor();
  assert.equal(await present.getByRole('button', { name: 'Move toolbar', exact: true }).count(), 1, 'Present has the same movable toolbar controls');
  assert.ok(await present.getByTitle('Add channel', { exact: true }).isVisible());
  await present.close();
  await page.getByRole('button', { name: 'Start engine', exact: true }).click();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).state === 'running', 'renderer running', 45000);
  const startup = (await (await request.get(`${base}/api/studio/diagnostics`)).json()).startup;
  assert.equal(startup.origin, base, 'Engine falls back to the available app when its configured frontend port is refused');
  assert.ok(startup.attempts.some(a => a.origin === staleRendererUrl && a.error), 'The unavailable frontend is captured in diagnostics');
  assert.equal(await page.locator('.engine-alert').count(), 0, 'Successful startup clears the error banner');
  await cutButton.click();
  await until(() => page.locator('.program-panel video').evaluate(v => v.readyState >= 2 && v.videoWidth > 0), 'Program video');
  await page.locator('.layer-row').filter({ hasText: 'Subtitle' }).click();
  await page.screenshot({ path: path.join(dir, 'studio-layer-inspector.png'), fullPage: true });
  await page.getByLabel('Text', { exact: true }).fill('A new draft subtitle');
  await page.getByLabel('Text', { exact: true }).press('Tab');
  await until(async () => (await get()).scenes[0].layers.find(l => l.id === 'subtitle').text === 'A new draft subtitle', 'inspector saves');
  assert.notEqual((await get()).program.layers.find(l => l.id === 'subtitle').text, 'A new draft subtitle');
  const selectedLayer = page.locator('.layer-hitbox.selected');
  const bounds = await selectedLayer.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 30, bounds.y + bounds.height / 2 + 10, { steps: 4 }); await page.mouse.up();
  await until(async () => (await get()).scenes[0].layers.find(l => l.id === 'subtitle').x > 8, 'dragged layer saves');
  await command({ type: 'route', outputId: 'screen_main', sceneId: 'scene_welcome' });
  const original = (await get()).outputs[0].scene;
  await page.getByRole('button', { name: /The message/ }).click();
  await until(async () => (await get()).previewSceneId === 'scene_message', 'select scene');
  await page.getByRole('button', { name: 'Add source layer', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Test camera');
  await page.getByRole('button', { name: 'Add to Studio', exact: true }).click();
  await until(async () => Object.values((await (await request.get(`${base}/api/studio/status`)).json()).sources).includes('ready'), 'fake camera input');
  await page.getByRole('button', { name: 'Add source layer', exact: true }).click();
  await page.getByRole('button', { name: 'Microphone', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Sermon microphone');
  await page.getByRole('button', { name: 'Add to Studio', exact: true }).click();
  const microphone = await until(async () => (await get()).sources.find(s => s.kind === 'microphone'), 'muted microphone saved');
  assert.equal(microphone.audio.muted, true, 'New microphone starts muted');
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await page.getByRole('button', { name: 'Set Sermon microphone as Main audio', exact: true }).click();
  await until(async () => (await get()).mainAudioSourceId === microphone.id && Object.values((await (await request.get(`${base}/api/studio/status`)).json()).levels).some(n => n > 0), 'real main audio meter');
  await page.locator(`[data-testid="audio-mixer-source"][data-source-id="${microphone.id}"]`).getByTestId('main-audio-badge').waitFor();
  await page.getByRole('button', { name: 'Mute Sermon microphone', exact: true }).click();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).levels[microphone.id] === 0, 'source mute');
  await page.getByRole('button', { name: 'Unmute Sermon microphone', exact: true }).click();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).levels.master > 0, 'master mix');
  await page.getByRole('button', { name: 'Toggle master mute' }).click();
  await until(async () => { const levels = (await (await request.get(`${base}/api/studio/status`)).json()).levels; return levels.master === 0 && levels[microphone.id] > 0; }, 'master mute leaves source signal intact');
  await page.getByRole('button', { name: 'Toggle master mute' }).click();
  await page.getByRole('button', { name: 'Add production source' }).click();
  await page.getByRole('button', { name: 'Audio file', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(audioFixture);
  await until(() => page.getByRole('button', { name: 'Add to Studio', exact: true }).isEnabled(), 'media upload');
  await page.getByLabel('Name', { exact: true }).fill('Music bed');
  await page.getByRole('button', { name: 'Add to Studio', exact: true }).click();
  const music = await until(async () => (await get()).sources.find(s => s.name === 'Music bed'), 'audio source saved');
  assert.equal(music.audio.muted, true, 'Uploaded music must not interrupt the main feed');
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await page.getByRole('button', { name: 'Unmute Music bed', exact: true }).click();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).levels[music.id] > 0, 'uploaded file audio');
  await page.getByRole('button', { name: /^Sources/ }).click();
  await page.getByRole('button', { name: 'Pause Music bed' }).click();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).levels[music.id] === 0, 'pause file audio');
  await page.getByRole('button', { name: 'Restart Music bed' }).click();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).levels[music.id] > 0, 'restart file audio');
  await page.getByRole('button', { name: 'Pause Music bed' }).click();
  await cutButton.click();
  await until(async () => (await get()).program?.id === 'scene_message', 'take live');
  assert.deepEqual((await get()).outputs[0].scene, original, 'Pinned output changed with Program');
  const liveOpened = context.waitForEvent('page'); await studioLiveButton.click();
  const programView = await liveOpened; await programView.waitForURL(`${base}/studio/output/program`);
  await until(() => programView.locator('video').evaluate(v => v.readyState >= 2 && v.videoWidth > 0), 'Studio live view renders actual Program even when the first output is pinned');
  assert.equal(await programView.getByText('Output not found', { exact: true }).count(), 0);
  await programView.screenshot({ path: path.join(dir, 'program-live-view.png') });
  await programView.close();
  const output = await context.newPage(); await output.goto(`${base}/studio/output/screen_main`);
  await until(() => output.locator('video').evaluate(v => v.readyState >= 2 && v.videoWidth > 0), 'independent output stream');
  const sample = () => output.locator('video').evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
  await command({ type: 'blank', outputId: 'screen_main', blanked: true });
  await until(async () => (await sample()).every(n => n < 5), 'blanked output pixels');
  assert.equal((await get()).outputs[1].blanked, false);
  await command({ type: 'blank', outputId: 'screen_main', blanked: false });
  await until(async () => (await sample()).some(n => n > 20), 'restored output pixels');
  await output.screenshot({ path: path.join(dir, 'pinned-output.png') });

  // Exercise transitions in the actual station renderer and WebRTC outputs,
  // not a CSS animation on the controller. Solid scenes make the decoded
  // pixels unambiguous even with video compression and asynchronous frames.
  const beforeTransitions = await get();
  const saveStudio = async mutate => {
    const next = await get(); mutate(next);
    const response = await request.put(`${base}/api/studio`, { data: next });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  // Hidden, distinct editable layers prove that Preview's sidebar/inspector
  // follows the outgoing scene, without contaminating the solid pixel samples.
  const transitionLayer = (id, name) => ({ ...structuredClone(beforeTransitions.scenes[0].layers[0]), id, name, text: name, visible: false });
  const redScene = { id: 'transition_red', name: 'Transition red', background: '#ff0000', layers: [transitionLayer('transition_red_layer', 'Red editable layer')] };
  const blueScene = { id: 'transition_blue', name: 'Transition blue', background: '#0000ff', layers: [transitionLayer('transition_blue_layer', 'Blue editable layer')] };
  const assertPreview = async (sceneId, label) => {
    const state = await get(), scene = state.scenes.find(scene => scene.id === sceneId);
    assert.ok(scene, `${label}: outgoing scene still exists as an editable draft`);
    await until(() => page.locator('.preview-panel .monitor-title').getByText(scene.name, { exact: true }).isVisible(), `${label}: Preview title follows outgoing Program`);
    await until(() => page.getByRole('button', { name: new RegExp(scene.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).getAttribute('aria-pressed').then(value => value === 'true'), `${label}: outgoing scene is selected`);
    await until(async () => JSON.stringify(await page.locator('.layer-row').evaluateAll(rows => rows.map(row => row.dataset.layerId))) === JSON.stringify(scene.layers.map(layer => layer.id).reverse()), `${label}: outgoing layers become editable`);
  };
  let expectedDrafts;
  let expectedPinned;
  const assertSwap = async (programId, previewId, label) => {
    const state = await until(async () => {
      const next = await get();
      return next.program?.id === programId && next.previewSceneId === previewId ? next : null;
    }, `${label}: Preview and Program exchange atomically`);
    assert.deepEqual(state.scenes, expectedDrafts, `${label}: a swap does not overwrite saved scene drafts`);
    assert.equal(state.mainAudioSourceId, beforeTransitions.mainAudioSourceId, `${label}: persistent Main audio remains selected`);
    assert.equal(state.masterMuted, beforeTransitions.masterMuted, `${label}: master mute is unchanged`);
    assert.equal(state.masterVolume, beforeTransitions.masterVolume, `${label}: master volume is unchanged`);
    assert.deepEqual(state.sources.map(source => ({ id: source.id, audio: source.audio })), beforeTransitions.sources.map(source => ({ id: source.id, audio: source.audio })), `${label}: source audio configuration survives the exchange`);
    if (expectedPinned) assert.deepEqual(state.outputs.find(output => output.id === 'screen_main'), expectedPinned, `${label}: independently pinned output is unchanged`);
    await assertPreview(previewId, label);
    return state;
  };
  await saveStudio(state => { state.scenes.push(redScene, blueScene); state.previewSceneId = redScene.id; });
  expectedDrafts = (await get()).scenes;
  await until(() => page.locator('.preview-panel .monitor-title').getByText(redScene.name, { exact: true }).isVisible(), 'red transition preview');
  await cutButton.click();
  await assertSwap(redScene.id, beforeTransitions.program.id, 'First Cut');
  assert.equal((await get()).programTransition.kind, 'cut');
  await command({ type: 'route', outputId: 'screen_main', sceneId: redScene.id });
  expectedPinned = (await get()).outputs.find(output => output.id === 'screen_main');
  const follower = await context.newPage(); await follower.goto(`${base}/studio/output/screen_broadcast`);
  await until(() => follower.locator('video').evaluate(v => v.readyState >= 2 && v.videoWidth > 0), 'Program-following video stream');
  const pixel = locator => locator.evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
  const programPixel = () => pixel(page.locator('.program-panel video'));
  const followerPixel = () => pixel(follower.locator('video'));
  const pinnedPixel = () => pixel(output.locator('video'));
  const isRed = ([r, g, b]) => r > 220 && g < 25 && b < 25;
  const isBlue = ([r, g, b]) => b > 220 && g < 25 && r < 25;
  const isBlend = ([r, g, b]) => r > 35 && b > 35 && g < 30;
  await until(async () => (await Promise.all([programPixel(), followerPixel(), pinnedPixel()])).every(isRed), 'Cut is red on Program, follower and the independently pinned screen');
  await saveStudio(state => { state.previewSceneId = blueScene.id; });
  await until(() => page.locator('.preview-panel .monitor-title').getByText(blueScene.name, { exact: true }).isVisible(), 'blue transition preview');
  await fadeDuration.fill('1000'); await fadeDuration.press('Tab');

  // Typing and modified/repeated shortcuts must never send an accidental
  // scene live. Scene/transition buttons are tested separately below: they
  // keep global Space semantics after normal pointer interaction.
  const untouchedTransition = (await get()).programTransition.id;
  const untouchedPreview = (await get()).previewSceneId;
  await fadeDuration.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Shift+Space');
  await page.evaluate(() => {
    document.activeElement?.blur();
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, ...modifiers }));
    }
  });
  await page.waitForTimeout(200);
  assert.equal((await get()).programTransition.id, untouchedTransition, 'Editing and modified/repeated keys leave Program unchanged');
  assert.equal((await get()).previewSceneId, untouchedPreview, 'Guarded keys never swap Preview either');

  await fadeButton.click();
  const fadeState = await assertSwap(blueScene.id, redScene.id, 'Click Fade');
  assert.equal(fadeState.programTransition.kind, 'fade');
  assert.equal(fadeState.programTransition.durationMs, 1000);
  const transitionPixels = [];
  await until(async () => {
    const pixels = await Promise.all([programPixel(), followerPixel(), pinnedPixel()]);
    transitionPixels.push(pixels);
    assert.ok(isRed(pixels[2]), `Pinned output must not fade with Program: ${pixels[2]}`);
    return isBlue(pixels[0]) && isBlue(pixels[1]);
  }, 'Fade finishes blue on Program and its follower', 5000);
  assert.ok(transitionPixels.some(([program]) => isBlend(program)), 'Program decodes intermediate red/blue fade frames');
  assert.ok(transitionPixels.some(([, follows]) => isBlend(follows)), 'Program-following output decodes intermediate fade frames');
  assert.ok(transitionPixels.every(([, , pinned]) => isRed(pinned)), 'Pinned output stays on its committed red scene throughout the fade');
  const finishedTransition = (await get()).programTransition.id;
  await saveStudio(state => {
    state.scenes.find(scene => scene.id === redScene.id).name = 'Transition red draft';
    state.scenes.find(scene => scene.id === blueScene.id).layers[0].text = 'Blue unpublished draft edit';
  });
  expectedDrafts = (await get()).scenes;
  assert.equal((await get()).program.layers[0].text, 'Blue editable layer', 'Editing the live scene draft leaves its committed Program snapshot intact');
  assert.equal((await get()).programTransition.id, finishedTransition, 'A draft save retains the committed transition identity');
  for (let frame = 0; frame < 3; frame++) {
    await page.waitForTimeout(120);
    assert.ok(isBlue(await programPixel()) && isBlue(await followerPixel()), 'Draft edits never replay a completed fade');
  }

  // Repeated transitions need no scene reselection: each outgoing Program is
  // immediately the next editable Preview, while all live screens agree.
  await assertPreview(redScene.id, 'Return scene after first Fade');
  await cutButton.click();
  await assertSwap(redScene.id, blueScene.id, 'Click Cut back');
  await page.locator('.layer-row[data-layer-id="transition_blue_layer"]').click();
  assert.equal(await page.getByLabel('Text', { exact: true }).inputValue(), 'Blue unpublished draft edit', 'Swapped Preview retains unpublished draft edits in the inspector instead of replacing them with the old live snapshot');
  await until(async () => (await Promise.all([programPixel(), followerPixel(), pinnedPixel()])).every(isRed), 'Click Cut returns both live outputs to red');
  await fadeButton.click();
  await assertSwap(blueScene.id, redScene.id, 'Click Fade forward again');
  await until(async () => isBlue(await programPixel()) && isBlue(await followerPixel()) && isRed(await pinnedPixel()), 'Repeated Fade reaches blue without changing the pinned screen');
  await page.screenshot({ path: path.join(dir, 'studio-preview-program-swap.png'), fullPage: true });

  // A scene click and a transition click naturally leave those controls
  // focused. Space/Shift+Space must retain their advertised global meaning,
  // without a second native Space click. Enter keeps normal button semantics.
  const keyboardTakes = [];
  const captureTake = request => {
    if (request.url() === `${base}/api/studio/command` && request.method() === 'POST' && request.postDataJSON()?.command?.type === 'take') keyboardTakes.push(request.postDataJSON().command);
  };
  page.on('request', captureTake);
  await assertPreview(redScene.id, 'Keyboard return scene ready without reselection');
  await fadeDuration.fill('300');
  await page.waitForTimeout(1100); // A status/clock render must retain the uncommitted edit.
  assert.equal(await fadeDuration.inputValue(), '300');
  await fadeDuration.press('Tab');
  assert.equal(await page.evaluate(() => localStorage.getItem('lumen.studio.fade-duration')), '300');
  await until(() => fadeButton.isEnabled(), 'fade controls ready after preview selection');
  await page.getByRole('button', { name: /Transition red draft/ }).press('Shift+Space');
  const keyboardFade = await assertSwap(redScene.id, blueScene.id, 'Shift+Space on a focused scene');
  assert.equal(keyboardFade.programTransition.kind, 'fade');
  assert.equal(keyboardFade.programTransition.durationMs, 300);
  await until(async () => (await Promise.all([programPixel(), followerPixel(), pinnedPixel()])).every(isRed), 'Keyboard fade completes on both live outputs');
  assert.equal(keyboardTakes.length, 1, 'Scene-focused Shift+Space sends exactly one transition');
  await fadeButton.press('Space');
  const keyboardCut = await assertSwap(blueScene.id, redScene.id, 'Space on a focused Fade button');
  assert.equal(keyboardCut.programTransition.kind, 'cut');
  await until(async () => isBlue(await programPixel()) && isBlue(await followerPixel()) && isRed(await pinnedPixel()), 'Keyboard cut reaches both live outputs without reselection');
  await page.waitForTimeout(150);
  assert.equal(keyboardTakes.length, 2, 'Transition-focused Space sends exactly one Cut without a native click');
  await fadeButton.press('Enter');
  const nativeFade = await assertSwap(redScene.id, blueScene.id, 'Enter activates the focused Fade button normally');
  assert.equal(nativeFade.programTransition.kind, 'fade');
  await until(async () => (await Promise.all([programPixel(), followerPixel(), pinnedPixel()])).every(isRed), 'Native Enter fade completes on both live outputs');
  assert.equal(keyboardTakes.length, 3, 'Native Enter sends one Fade');
  assert.ok(keyboardTakes.every(take => take.swapPreview === true), 'Studio keyboard and native transition controls request Preview/Program exchange');
  page.off('request', captureTake);
  await follower.close();
  await command({ type: 'take', sceneId: beforeTransitions.program.id });
  await command({ type: 'route', outputId: 'screen_main', sceneId: original.id });
  await saveStudio(state => {
    state.scenes = state.scenes.filter(scene => ![redScene.id, blueScene.id].includes(scene.id));
    state.previewSceneId = beforeTransitions.previewSceneId;
  });
  await until(async () => (await get()).program?.id === beforeTransitions.program.id, 'original Program restored after transition fixtures');
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await page.screenshot({ path: path.join(dir, 'studio-live.png'), fullPage: true });
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  const active = await until(async () => { const s = await (await request.get(`${base}/api/studio/status`)).json(); return s.recording?.bytes > 10000 ? s.recording : null; }, 'recorded chunks', 30000);
  // Closing the controller releases its fake cameras, but file-based scenes and
  // recording remain owned by the station renderer.
  await command({ type: 'take', sceneId: 'scene_close', transition: 'fade', durationMs: 500 });
  page.on('dialog', dialog => dialog.accept());
  await page.close({ runBeforeUnload: true });
  await until(async () => { const s = await (await request.get(`${base}/api/studio/status`)).json(); return s.state === 'running' && s.recording?.bytes > active.bytes; }, 'recording continues without controller');
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 409, 'Engine stopped while recording');
  assert.equal((await request.post(`${base}/api/studio/recordings/${active.id}/stop`)).status(), 200);
  const finished = await until(async () => (await (await request.get(`${base}/api/studio/recordings`)).json()).find(r => r.id === active.id && r.status === 'complete'), 'finalized recording');
  const download = await request.get(`${base}/api/studio/recordings/${active.id}/download`);
  assert.equal(download.status(), 200); assert.ok((await download.body()).byteLength > 10000);
  const media = path.join(dir, 'recordings', active.id, 'recording.webm');
  const decoded = spawn(ffmpeg, ['-hide_banner', '-i', media, '-t', '1', '-f', 'null', '-']);
  let inspection = ''; decoded.stderr.on('data', b => inspection += b);
  assert.equal(await new Promise(resolve => decoded.on('close', resolve)), 0, inspection);
  assert.match(inspection, /Video: vp8/); assert.match(inspection, /Audio: opus/); assert.match(inspection, /1920x1080/);
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', media, '-t', '1', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
  let peak = 0; for (let i = 0; i + 4 <= pcm.length; i += 4) peak = Math.max(peak, Math.abs(pcm.readFloatLE(i)));
  assert.ok(peak > 0.01, `Recorded audio is silent (peak ${peak})`);
  await command({ type: 'blank', outputId: 'screen_main', blanked: true });
  assert.equal((await get()).outputs[1].blanked, false);
  // A real unprivileged account must not control the renderer or edit scenes.
  await request.post(`${base}/api/users`, { data: { username: 'viewer', password: 'test-pass', displayName: 'Viewer' } });
  const viewer = await browser.newContext();
  await viewer.request.post(`${base}/api/auth/login`, { data: { username: 'viewer', password: 'test-pass' } });
  assert.equal((await viewer.request.post(`${base}/api/studio/engine/start`)).status(), 403);
  assert.equal((await viewer.request.put(`${base}/api/studio`, { data: await get() })).status(), 403);
  await viewer.close();
  // Retain an incomplete but real WebM stream, restart the station, and recover
  // it through the same endpoint offered by the Recordings library.
  const interruptedResponse = await request.post(`${base}/api/studio/recordings`, { data: { name: 'Recovery rehearsal' } });
  assert.equal(interruptedResponse.status(), 201);
  const interrupted = await interruptedResponse.json();
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).recording?.bytes > 10000, 'recovery chunks');
  const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped;
  server = launchServer();
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(2000) })).ok, 'station restart');
  assert.equal((await get()).program.id, 'scene_close', 'Program was not retained on disk');
  assert.equal((await (await request.get(`${base}/api/studio/recordings`)).json()).find(r => r.id === interrupted.id).status, 'interrupted');
  assert.equal((await request.post(`${base}/api/studio/recordings/${interrupted.id}/recover`)).status(), 202);
  await until(async () => (await (await request.get(`${base}/api/studio/recordings`)).json()).find(r => r.id === interrupted.id)?.status === 'complete', 'interrupted recording recovery');
  const recovered = path.join(dir, 'recordings', interrupted.id, 'recording.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-i', recovered, '-t', '1', '-f', 'null', '-']);
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, recording: finished, checks: ['responsive central Cut/Fade controls and duration', 'mouse/touch/keyboard toolbar positioning and reset', 'toolbar collapse, persistence, resize bounds and overflow', 'collapsible inspector and sections without production changes', 'desktop/mobile bottom scroll clearance', 'Present toolbar isolation', 'auth and role enforcement', 'draft isolation and drag editing', 'camera input', 'source/master audio muting', 'uploaded audio pause/restart', 'decoded Program and follower fade pixels with pinned-output isolation', 'repeated click/keyboard Preview-Program swaps without reselection', 'swapped Preview title, selected scene and editable layers', 'swaps preserve drafts, persistent Main audio and pinned outputs', 'Cut/Fade keyboard shortcuts and editing safety', 'draft saves do not replay transitions', 'independent outputs and blank pixels', 'background renderer', 'recording survives controller close', '1080p video + non-silent Opus audio decode', 'safe engine stop', 'state persistence and interrupted recording recovery'] }, null, 2));
} catch (e) {
  await page?.screenshot({ path: path.join(dir, 'studio-failure.png'), fullPage: true }).catch(() => {});
  console.error('Last status:', await (await fetch(`${base}/api/studio/status`)).json().catch(() => ({})));
  console.error('Diagnostics:', request ? JSON.stringify(await (await request.get(`${base}/api/studio/diagnostics`)).json(), null, 2) : 'Unavailable');
  console.error(e); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]);
}
