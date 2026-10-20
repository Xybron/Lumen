// Run after npm run build. This station is disposable and never connects real
// devices or changes the operator's production document.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-studio-properties-'));
const port = Number(process.env.LUMEN_PROPERTIES_TEST_PORT ?? 3452), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page;
const checks = [], errors = [];
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
async function until(fn, label, timeout = 10000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station start', 30000);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 } });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__studioPropertyFrames = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        if (String(args[0]).endsWith('/studio/ws')) this.addEventListener('message', event => {
          const message = JSON.parse(event.data);
          window.__studioPropertyFrames.push({ type: message.t, revision: message.state?.revision, time: performance.now() });
        });
      }
    };
  });
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
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
  const sceneId = 'properties_fixture', secondSceneId = 'properties_other', textId = 'properties_text', shapeId = 'properties_shape';
  const layer = (id, name, patch = {}) => ({ id, name, kind: 'text', visible: true, locked: false,
    x: 10, y: 15, width: 60, height: 20, opacity: 1, fit: 'contain', text: 'Words before editing',
    color: '#ffffff', background: '#00000000', fontSize: 48, fontWeight: 500, align: 'center', radius: 0, ...patch });
  await save(document => {
    document.scenes.push({ id: sceneId, name: 'Property rehearsal', background: '#111317', layers: [
      layer(textId, 'Message title'), layer(shapeId, 'Accent rectangle', { kind: 'shape', y: 60, background: '#7dd3fc' }),
    ] });
    document.scenes.push({ id: secondSceneId, name: 'Another rehearsal', background: '#211317', layers: [] });
    document.previewSceneId = sceneId;
    document.sources.push({ id: 'properties_main_mic', name: 'Persistent microphone', kind: 'microphone', loop: false, audio: { muted: true, volume: .75, mode: 'always', delayMs: 0 } });
  });
  await command({ type: 'set-main-audio', sourceId: 'properties_main_mic' });
  await command({ type: 'take', sceneId });
  await command({ type: 'route', outputId: 'screen_main', sceneId });
  const committed = await get();
  const scene = async () => (await get()).scenes.find(item => item.id === sceneId);
  const currentLayer = async id => (await scene()).layers.find(item => item.id === id);
  const unchangedLive = async label => {
    const document = await get();
    assert.deepEqual(document.program, committed.program, `${label}: inspector edits cannot publish to Program`);
    assert.equal(document.programSceneId, committed.programSceneId, `${label}: Program routing stays unchanged`);
    assert.equal(document.mainAudioSourceId, committed.mainAudioSourceId, `${label}: persistent main audio selection stays unchanged`);
    assert.deepEqual(document.sources, committed.sources, `${label}: main source settings stay unchanged`);
    assert.deepEqual(document.outputs.map(({ name, ...output }) => output), committed.outputs.map(({ name, ...output }) => output), `${label}: output routes/audio stay unchanged`);
  };
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => { errors.push(`Unexpected native ${dialog.type()} dialog`); void dialog.dismiss(); });
  await page.goto(`${base}/studio`);
  await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  const inspector = page.getByRole('complementary', { name: 'Design inspector' });
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  const selectLayer = async id => {
    await page.locator(`.layer-row[data-layer-id="${id}"]`).click();
    await inspector.locator('[data-inspector-layer-name]').waitFor();
  };
  const clearLayer = async () => {
    // Click empty canvas edge to deselect the current layer without changing a scene.
    await page.getByLabel('Preview canvas', { exact: true }).click({ position: { x: 2, y: 2 } });
    await inspector.getByLabel('Scene name', { exact: true }).waitFor();
  };
  const edit = async (locator, value) => { await locator.fill(value); await locator.press('Tab'); };

  if (process.env.LUMEN_PROPERTIES_TEST_ENGINE !== '0') {
    const started = await request.post(`${base}/api/studio/engine/start`);
    assert.equal(started.status(), 200, await started.text());
    assert.equal((await started.json()).state, 'running');
    // Let the route's intentional initial WebSocket reconnect finish, then
    // isolate status-only renderer frames from document replacement frames.
    await page.waitForTimeout(1200);
    await page.evaluate(() => { window.__studioPropertyFrames = []; });
    const field = inspector.getByLabel('Scene name', { exact: true });
    await field.fill('Draft during renderer heartbeat');
    await page.waitForTimeout(1500);
    assert.equal(await field.inputValue(), 'Draft during renderer heartbeat', 'Renderer status frames cannot wipe a typed field');
    await field.fill('Property rehearsal');
    checks.push('typed drafts survive real isolated renderer heartbeat frames');
  }

  // Audio inputs use the same buffered properties but remain explicit commits:
  // no live gain changes while an operator is still dragging or typing.
  const audioBaseline = await get();
  const savedMainAudio = structuredClone(audioBaseline.sources.find(source => source.id === 'properties_main_mic').audio);
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  const delay = page.getByLabel('Persistent microphone delay', { exact: true });
  await delay.fill('175');
  await page.waitForTimeout(1200);
  assert.equal(await delay.inputValue(), '175', 'Renderer heartbeat retains an unfinished source-delay draft');
  assert.equal((await get()).sources.find(source => source.id === 'properties_main_mic').audio.delayMs, savedMainAudio.delayMs, 'Delay remains unchanged until an explicit field commit');
  await delay.press('Tab');
  await until(async () => (await get()).sources.find(source => source.id === 'properties_main_mic').audio.delayMs === 175, 'source delay commits on blur');
  await edit(delay, '2500');
  await until(async () => (await get()).sources.find(source => source.id === 'properties_main_mic').audio.delayMs === 2000, 'source delay clamps to its supported maximum');
  assert.equal(await delay.inputValue(), '2000');
  const dragRangeAcrossHeartbeat = async (locator, amount, getValue, label) => {
    await until(() => locator.isEnabled(), `${label} enabled after prior save`);
    await locator.scrollIntoViewIfNeeded();
    const bounds = await locator.boundingBox(), previous = await getValue();
    await page.mouse.move(bounds.x + bounds.width * .2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * amount, bounds.y + bounds.height / 2, { steps: 8 });
    const draft = await locator.inputValue();
    await page.waitForTimeout(1200);
    assert.equal(await locator.inputValue(), draft, `${label} retains its dragged thumb through renderer heartbeat`);
    assert.equal(await getValue(), previous, `${label} does not apply gain while the thumb is still held`);
    await page.mouse.up();
    await until(async () => Math.abs((await getValue()) - Number(draft)) < .001, `${label} commits the final thumb position on release`);
  };
  await dragRangeAcrossHeartbeat(page.getByLabel('Persistent microphone volume', { exact: true }), .42,
    async () => (await get()).sources.find(source => source.id === 'properties_main_mic').audio.volume, 'Source volume');
  await dragRangeAcrossHeartbeat(page.getByLabel('Master volume', { exact: true }), .63,
    async () => (await get()).masterVolume, 'Master volume');
  await save(document => {
    document.sources.find(source => source.id === 'properties_main_mic').audio = structuredClone(savedMainAudio);
    document.masterVolume = audioBaseline.masterVolume; document.masterMuted = audioBaseline.masterMuted;
  });
  await until(async () => Number(await page.getByLabel('Master volume', { exact: true }).inputValue()) === audioBaseline.masterVolume && Number(await delay.inputValue()) === savedMainAudio.delayMs, 'audio values restore from their acknowledged baseline');
  await page.locator('.source-audio-panel .tool-tabs button').first().click();
  await unchangedLive('Restored audio controls');
  assert.equal((await get()).masterVolume, audioBaseline.masterVolume, 'Master volume is explicitly restored after the isolated audio edit rehearsal');
  assert.equal((await get()).masterMuted, audioBaseline.masterMuted, 'Master mute stays unchanged throughout audio editing');
  checks.push('source delay and source/master slider drafts survive heartbeat; gain commits only on release; audio baseline is restored');

  // Normal property editing must work without errors or remounting the app.
  await edit(inspector.getByLabel('Scene name', { exact: true }), 'Sunday service');
  await until(async () => (await scene()).name === 'Sunday service', 'scene name edit persists');
  await edit(inspector.getByLabel(/^Background/), '#362842');
  await until(async () => (await scene()).background === '#362842', 'scene background edit persists');
  await selectLayer(textId);
  await edit(inspector.getByLabel('Layer name', { exact: true }), 'Sermon heading');
  await until(async () => (await currentLayer(textId)).name === 'Sermon heading', 'layer name edit persists');
  await edit(inspector.getByLabel('Text', { exact: true }), 'New words in Preview');
  await until(async () => (await currentLayer(textId)).text === 'New words in Preview', 'text edit persists');
  await edit(inspector.getByLabel('Text color', { exact: false }), '#ad70c7');
  await until(async () => (await currentLayer(textId)).color === '#ad70c7', 'text color edit persists');
  await edit(inspector.getByLabel(/^Fill/), '#334455');
  await until(async () => (await currentLayer(textId)).background === '#334455', 'fill edit persists');
  await edit(inspector.getByLabel('X', { exact: true }), '288');
  await until(async () => Math.abs((await currentLayer(textId)).x - 15) < .001, 'pixel geometry edit persists');
  await edit(inspector.getByLabel('Width', { exact: true }), '960');
  await until(async () => Math.abs((await currentLayer(textId)).width - 50) < .001, 'pixel width edit persists');
  await unchangedLive('Basic properties');
  checks.push('scene name/background, layer name/text/color/fill and pixel geometry persist without publishing');

  // Keep a DOM node marker: full reload/remount on a save would erase it.
  await page.locator('.studio-workspace').evaluate(node => { node.dataset.propertyRehearsal = 'stable'; });
  let releaseSave;
  const hold = new Promise(resolve => { releaseSave = resolve; });
  let held = false;
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT' || held) return route.continue();
    held = true;
    await hold;
    return route.continue();
  });
  await edit(inspector.getByLabel('Layer name', { exact: true }), 'Queued heading');
  await until(() => held, 'held save begins');
  await edit(inspector.getByLabel('Text', { exact: true }), 'Queued text survives');
  await edit(inspector.getByLabel(/^Fill/), '#405060');
  releaseSave();
  await until(async () => {
    const value = await currentLayer(textId);
    return value.name === 'Queued heading' && value.text === 'Queued text survives' && value.background === '#405060';
  }, 'rapid queued property edits survive a slow save');
  await page.unroute('**/api/studio');
  assert.equal(await page.locator('.studio-workspace').getAttribute('data-property-rehearsal'), 'stable', 'Edits cannot remount the workspace');
  await unchangedLive('Delayed queued properties');
  checks.push('rapid queued edits survive delayed network responses without workspace remount');

  let rejectedSave = false;
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT' || rejectedSave) return route.continue();
    rejectedSave = true;
    return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated property write rejection.' }) });
  });
  await edit(inspector.getByLabel('Layer name', { exact: true }), 'Rejected heading');
  await until(() => rejectedSave, 'simulated failed save is received');
  await page.getByText('Simulated property write rejection.', { exact: true }).waitFor();
  await until(async () => (await inspector.getByLabel('Layer name', { exact: true }).inputValue()) === 'Queued heading', 'failed property returns to last acknowledged value');
  assert.equal(await page.locator('.studio-workspace').getAttribute('data-property-rehearsal'), 'stable', 'Failed property saves cannot unmount or flash the entire workspace');
  await page.unroute('**/api/studio');
  await unchangedLive('Rejected property');
  checks.push('failed property saves restore the acknowledged field without remounting or flashing the workspace');

  // Delayed HTTP acknowledgements are older snapshots than a later WebSocket
  // update. Releasing one must not roll the shared document backwards.
  let releaseResponse;
  const responseHold = new Promise(resolve => { releaseResponse = resolve; });
  let fetchedResponse = false;
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT' || fetchedResponse) return route.continue();
    const response = await route.fetch();
    fetchedResponse = true;
    await responseHold;
    return route.fulfill({ response });
  });
  await edit(inspector.getByLabel('Layer name', { exact: true }), 'Response order heading');
  await until(() => fetchedResponse, 'save committed while its HTTP acknowledgement is delayed');
  await save(document => { document.scenes.find(item => item.id === secondSceneId).name = 'Newer station revision'; });
  const remoteScene = page.locator('.scene-card').filter({ hasText: 'Newer station revision' });
  await remoteScene.waitFor();
  releaseResponse();
  await page.waitForTimeout(250);
  assert.equal(await remoteScene.count(), 1, 'A stale save acknowledgement cannot replace a newer station revision');
  await page.unroute('**/api/studio');
  await unchangedLive('Out-of-order response');
  checks.push('delayed HTTP acknowledgements never roll back a newer WebSocket station revision');

  await clearLayer();
  // Saving an unrelated setting or replacing the scene document from another
  // operator must not wipe a field while the local operator is still typing.
  const sceneName = inspector.getByLabel('Scene name', { exact: true });
  await sceneName.fill('Uncommitted local wording');
  await save(document => { document.masterVolume = .71; });
  await page.waitForTimeout(250);
  assert.equal(await sceneName.inputValue(), 'Uncommitted local wording', 'Incoming document updates preserve the active field draft');
  await sceneName.press('Tab');
  await until(async () => (await scene()).name === 'Uncommitted local wording', 'draft survives incoming update and commits');
  await selectLayer(textId);
  const layerName = inspector.getByLabel('Layer name', { exact: true }), textField = inspector.getByLabel('Text', { exact: true });
  await layerName.fill('Draft layer name');
  await save(document => { document.masterVolume = .72; });
  await page.waitForTimeout(150);
  assert.equal(await layerName.inputValue(), 'Draft layer name', 'Incoming document updates preserve the active layer name draft');
  await layerName.press('Tab');
  await until(async () => (await currentLayer(textId)).name === 'Draft layer name', 'layer name draft commits after incoming update');
  await textField.fill('Draft text across station update');
  await save(document => { document.masterVolume = .73; });
  await page.waitForTimeout(150);
  assert.equal(await textField.inputValue(), 'Draft text across station update', 'Incoming document updates preserve the active layer text draft');
  await textField.press('Tab');
  await until(async () => (await currentLayer(textId)).text === 'Draft text across station update', 'layer text draft commits after incoming update');
  checks.push('incoming station updates preserve active scene, layer name and layer text drafts');

  const outputName = page.getByLabel('Output name screen_main', { exact: true });
  await outputName.fill('Sanctuary display');
  await save(document => { document.masterVolume = .74; });
  await page.waitForTimeout(150);
  assert.equal(await outputName.inputValue(), 'Sanctuary display', 'Incoming document updates preserve the active output name draft');
  await outputName.press('Tab');
  await until(async () => (await get()).outputs.find(output => output.id === 'screen_main').name === 'Sanctuary display', 'output name persists');
  await unchangedLive('Output name');
  checks.push('output name drafts survive incoming updates and edit without changing routes or audio');
  await clearLayer();
  const background = inspector.getByLabel(/^Background/);
  await background.evaluate(node => { node.value = '#453729'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => (await scene()).background === '#453729', 'color input applies without closing the native picker');
  await selectLayer(textId);
  await inspector.getByLabel('Text color', { exact: false }).evaluate(node => { node.value = '#c981a2'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => (await currentLayer(textId)).color === '#c981a2', 'text color input applies without closing the native picker');
  await inspector.getByLabel(/^Fill/).evaluate(node => { node.value = '#506070'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => (await currentLayer(textId)).background === '#506070', 'fill input applies without closing the native picker');
  await unchangedLive('Picker input');
  checks.push('scene, text and fill colors apply while the native picker is being adjusted');

  // High-frequency native color events are coalesced, and returning to the
  // original A must not accidentally leave the intermediate B saved.
  await clearLayer();
  const picker = inspector.getByLabel(/^Background/);
  let pickerRequests = 0, releasePicker;
  const pickerHold = new Promise(resolve => { releasePicker = resolve; });
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    pickerRequests++;
    if (pickerRequests === 1) await pickerHold;
    return route.continue();
  });
  await picker.evaluate(node => { node.value = '#111111'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => pickerRequests === 1, 'first picker save is in flight');
  await picker.evaluate(node => {
    for (const color of ['#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#453729']) {
      node.value = color; node.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  assert.equal(await picker.inputValue(), '#453729', 'The picker shows the final selected color before the first save finishes');
  releasePicker();
  await until(async () => pickerRequests >= 2 && (await scene()).background === '#453729', 'A to B to A picker burst retains the final A');
  await page.waitForTimeout(150);
  assert.ok(pickerRequests <= 2, `Picker changes should coalesce to the in-flight and latest saves, received ${pickerRequests}`);
  await page.unroute('**/api/studio');
  if (process.env.LUMEN_PROPERTIES_TEST_ENGINE !== '0') {
    const previewVideo = page.locator('.preview-panel video').first();
    await until(async () => previewVideo.evaluate(video => {
      if (video.readyState < 2 || !video.videoWidth) return false;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, 1, 1);
      // At 1x1 downsample text/shapes influence color; crop the top-left corner
      // instead to test the actual scene background in the rendered feed.
      context.drawImage(video, 0, 0, 8, 8, 0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return Math.abs(r - 69) < 10 && Math.abs(g - 55) < 10 && Math.abs(b - 41) < 10;
    }), 'changed color reaches the actual Preview video feed', 15000);
  }
  checks.push('native picker bursts save only the in-flight/latest values and return A→B→A reaches Preview');

  await selectLayer(textId);
  const opacity = inspector.getByLabel(/^Opacity/);
  let opacityRequests = 0, releaseOpacity;
  const opacityHold = new Promise(resolve => { releaseOpacity = resolve; });
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    opacityRequests++;
    if (opacityRequests === 1) await opacityHold;
    return route.continue();
  });
  await opacity.evaluate(node => { node.value = '.3'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(() => opacityRequests === 1, 'first opacity save is in flight');
  await opacity.evaluate(node => {
    for (const value of ['.4', '.5', '.6', '.7', '.8', '.9', '1']) {
      node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  assert.equal(await opacity.inputValue(), '1', 'The opacity slider retains its final pending value');
  releaseOpacity();
  await until(async () => opacityRequests >= 2 && (await currentLayer(textId)).opacity === 1, 'opacity burst retains final full opacity');
  await page.waitForTimeout(150);
  assert.ok(opacityRequests <= 2, `Opacity changes should coalesce to the in-flight and latest saves, received ${opacityRequests}`);
  await page.unroute('**/api/studio');
  checks.push('high-frequency opacity changes coalesce and retain the final pending slider value');
  const size = inspector.getByLabel('Size', { exact: true }), radius = inspector.getByLabel('Corner radius', { exact: true });
  await edit(size, '999');
  await until(async () => (await currentLayer(textId)).fontSize === 300, 'font size clamps to its supported maximum');
  assert.equal(await size.inputValue(), '300');
  await edit(radius, '-5');
  await until(async () => (await currentLayer(textId)).radius === 0, 'corner radius clamps to its supported minimum');
  assert.equal(await radius.inputValue(), '0');
  const acknowledgedName = (await currentLayer(textId)).name;
  await edit(inspector.getByLabel('Layer name', { exact: true }), '   ');
  assert.equal(await inspector.getByLabel('Layer name', { exact: true }).inputValue(), acknowledgedName, 'Whitespace-only layer names revert to the acknowledged name');
  await inspector.getByLabel('Layer name', { exact: true }).fill('Discarded draft');
  await inspector.getByLabel('Layer name', { exact: true }).press('Escape');
  await inspector.getByLabel('Layer name', { exact: true }).press('Tab');
  assert.equal((await currentLayer(textId)).name, acknowledgedName, 'Escape discards a name edit without saving it');
  await save(document => { document.scenes.find(item => item.id === sceneId).layers.find(item => item.id === textId).background = '#22334480'; });
  await until(() => inspector.locator('.color-field').filter({ hasText: 'Fill' }).locator('code').textContent().then(text => text === '#22334480'), 'partial alpha fixture arrives');
  await inspector.getByLabel(/^Fill/).evaluate(node => { node.value = '#bcdef0'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => (await currentLayer(textId)).background === '#bcdef080', 'changing hue retains partial transparency');
  await inspector.getByLabel('Transparent fill', { exact: true }).check();
  await until(async () => (await currentLayer(textId)).background === '#bcdef000', 'transparent fill can be enabled');
  await inspector.getByLabel(/^Fill/).evaluate(node => { node.value = '#506070'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => (await currentLayer(textId)).background === '#506070', 'choosing a visible fill color clears fully transparent alpha');
  await unchangedLive('Normalized properties');
  checks.push('numeric bounds, blank names and Escape are normalized; partial alpha is preserved and choosing a fill clears zero alpha');

  // A layer-selection change must reset field identity and never submit the
  // previous layer draft under the newly selected layer's ID.
  const shapeName = (await currentLayer(shapeId)).name;
  await inspector.getByLabel('Layer name', { exact: true }).fill('Unfinished previous-layer draft');
  await page.locator(`.layer-hitbox[data-layer-id="${shapeId}"]`).click({ position: { x: 10, y: 10 } });
  await until(() => inspector.getByLabel('Layer name', { exact: true }).inputValue().then(value => value === shapeName), 'selection changes reset field identity');
  assert.equal((await currentLayer(shapeId)).name, shapeName, 'Previous layer drafts cannot rename the newly selected layer');
  await selectLayer(textId);
  await until(() => inspector.locator('.inspector-footer').textContent().then(text => text.includes('Changes saved')), 'selection edits finish saving');
  const finalLayerName = (await currentLayer(textId)).name;
  checks.push('switching selected layers resets field identity and never renames the wrong layer');

  const beforeEditor = await get(), originalAnimation = (await currentLayer(textId)).animation;
  await page.getByRole('button', { name: 'Open animation editor', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Animation editor', exact: true });
  await editor.waitFor();
  await edit(editor.getByLabel('Editor animation duration', { exact: true }), '4000');
  await editor.getByRole('button', { name: 'Restart animation preview', exact: true }).click();
  const keyframeX = editor.getByLabel('Keyframe X', { exact: true });
  await keyframeX.fill('-320');
  const initialPlayhead = await editor.locator('.animation-editor-transport output').textContent();
  await page.waitForTimeout(650);
  assert.notEqual(await editor.locator('.animation-editor-transport output').textContent(), initialPlayhead, 'Animation playhead is advancing during the field draft test');
  assert.equal(await keyframeX.inputValue(), '-320', 'Advancing playhead renders preserve an unfinished keyframe draft');
  await keyframeX.press('Tab');
  assert.equal(await keyframeX.inputValue(), '-320', 'Keyframe draft commits to its selected local editor frame');
  await editor.getByRole('button', { name: 'Restart animation preview', exact: true }).click();
  const duration = editor.getByLabel('Editor animation duration', { exact: true });
  await duration.fill('6500');
  await page.waitForTimeout(650);
  assert.equal(await duration.inputValue(), '6500', 'Advancing playhead renders preserve unfinished timing drafts');
  await duration.press('Tab');
  assert.equal(await duration.inputValue(), '6500');
  await editor.getByRole('button', { name: 'Cancel animation changes', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal((await get()).revision, beforeEditor.revision, 'Local animation property rehearsals do not save or publish before Apply');
  assert.deepEqual((await currentLayer(textId)).animation, originalAnimation, 'Cancel keeps the saved layer animation unchanged');
  await unchangedLive('Animation properties');
  checks.push('animation keyframe and timing drafts survive moving playhead renders; Cancel remains isolated from saved scene and Program');
  await page.reload();
  await inspector.getByLabel('Scene name', { exact: true }).waitFor();
  assert.equal(await inspector.getByLabel('Scene name', { exact: true }).inputValue(), 'Uncommitted local wording');
  assert.equal(await inspector.getByLabel(/^Background/).inputValue(), '#453729');
  await selectLayer(textId);
  assert.equal(await inspector.getByLabel('Layer name', { exact: true }).inputValue(), finalLayerName);
  assert.equal(await inspector.getByLabel('Text', { exact: true }).inputValue(), 'Draft text across station update');
  assert.equal(await inspector.getByLabel(/^Fill/).inputValue(), '#506070');
  assert.equal(await inspector.getByLabel('Text color', { exact: false }).inputValue(), '#c981a2');
  assert.equal(await inspector.getByLabel('X', { exact: true }).inputValue(), '288');
  assert.equal(await inspector.getByLabel('Width', { exact: true }).inputValue(), '960');
  checks.push('all property values survive page reload');
  if (process.env.LUMEN_PROPERTIES_TEST_ENGINE !== '0') {
    await until(async () => page.locator('.program-panel video').first().evaluate(video => {
      if (video.readyState < 2 || !video.videoWidth) return false;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 8, 8, 0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return Math.abs(r - 17) < 10 && Math.abs(g - 19) < 10 && Math.abs(b - 23) < 10;
    }), 'Program video still renders its original committed background after all Preview property edits', 15000);
    checks.push('actual Program video retains the original committed scene while Preview edits change');
  }
  // The deliberately rejected request above is the only expected browser
  // resource error; page exceptions and every other console error still fail.
  assert.deepEqual(errors.filter(error => !(error.startsWith('Failed to load resource:') && error.includes('422'))), [], `Browser errors: ${errors.join('\n')}`);
  await page.screenshot({ path: path.join(dir, 'studio-properties.png'), fullPage: true });
  console.log(JSON.stringify({ checks, artifacts: dir }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(dir, 'studio-properties-failed.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: error.message, checks, errors, frames: page ? await page.evaluate(() => window.__studioPropertyFrames).catch(() => []) : [], artifacts: dir, logs }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}
