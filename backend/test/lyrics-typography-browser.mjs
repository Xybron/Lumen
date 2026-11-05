// Run after npm run build. All media, station data and renderer processes here
// are disposable; this test never opens the operator's station or devices.
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
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-lyrics-typography-'));
const port = Number(process.env.LUMEN_LYRICS_TYPOGRAPHY_TEST_PORT ?? 3464), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
const mediaDir = path.join(dir, 'media', 'backgrounds');
await fs.mkdir(mediaDir, { recursive: true });
const filename = '1793880952659-Aesthetic_Wedding_Table_Centerpieces_for_a_Cozy_Vibe_pin_id_' + '1098385796613366329_'.repeat(8) + 'background.mp4';
assert.ok(filename.length > 220 && filename.length < 255);
const displayName = filename.replace(/^\d{13}-/, ''), mediaPath = `media/backgrounds/${filename}`;
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x112233:s=320x180:r=15', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(mediaDir, filename)]);
await fs.mkdir(path.join(dir, 'media', 'thumbnails'), { recursive: true });
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path.join(mediaDir, filename), '-frames:v', '1', path.join(dir, 'media', 'thumbnails', filename.replace(/\.mp4$/, '.jpg'))]);

let logs = '', browser, page, server, engineRunning = false;
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
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
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
  const contentResponse = await request.put(`${base}/api/content`, { data: content });
  assert.equal(contentResponse.status(), 200, await contentResponse.text());
  const songResponse = await request.post(`${base}/api/worship/songs`, { data: { id: 'typography_song', title: 'Together in this place',
    sections: [{ id: 'verse', label: 'Verse 1', text: 'Together in this place\nLet every voice sing out with joy' }] } });
  assert.equal(songResponse.status(), 201, await songResponse.text());
  const worship = await (await request.get(`${base}/api/worship/channels/lyrics`)).json();
  const cue = await request.post(`${base}/api/worship/channels/lyrics/command`, { data: { revision: worship.revision,
    command: { type: 'take', selection: { kind: 'lyrics', songId: 'typography_song', sectionId: 'verse' } } } });
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
  const sceneId = 'typography_scene', otherSceneId = 'typography_other', layerId = 'typography_lyrics', plainId = 'typography_text';
  const layer = (id, name, patch = {}) => ({ id, name, kind: 'source', sourceId: 'typography_source', visible: true, locked: false,
    x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'contain', text: '', color: '#ffffff', background: '#00000000',
    fontSize: 72, fontWeight: 500, align: 'center', radius: 0, ...patch });
  await save(document => {
    document.sources.push({ id: 'typography_source', name: 'Lyrics', kind: 'channel', channelId: 'lyrics', loop: false, audio: { muted: true, volume: 1, mode: 'follow', delayMs: 0 } });
    document.scenes.push({ id: sceneId, name: 'Lyrics typography fixture', background: '#111317', layers: [layer(layerId, 'Styled lyrics', {
      mediaBackground: { kind: 'video', url: mediaPath, fit: 'cover', dim: 0, loop: true },
    })] });
    document.scenes.push({ id: otherSceneId, name: 'Plain text fixture', background: '#111317', layers: [layer(plainId, 'Ordinary text', { kind: 'text', sourceId: undefined, text: 'A place to belong', y: 35, height: 30 })] });
    document.previewSceneId = sceneId;
  });
  await command({ type: 'take', sceneId });
  await command({ type: 'route', outputId: 'screen_main', sceneId });
  const baseline = await get();
  const getLayer = async (scene = sceneId, id = layerId) => (await get()).scenes.find(item => item.id === scene).layers.find(item => item.id === id);
  const unchangedLive = async () => {
    const state = await get();
    assert.deepEqual(state.program, baseline.program, 'Typography stays in Preview until an explicit Take');
    assert.deepEqual(state.outputs, baseline.outputs, 'Pinned output typography remains committed');
    assert.deepEqual(state.sources, baseline.sources, 'Shared Lyrics source is unchanged');
  };
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`Unexpected native ${dialog.type()} dialog`); void dialog.dismiss(); });
  await page.goto(`${base}/studio`);
  await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  const inspector = page.getByRole('complementary', { name: 'Design inspector' });
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  const selectLayer = async (scene = sceneId, id = layerId) => {
    await page.locator(`.scene-card[data-scene-id="${scene}"]`).click();
    await page.locator(`.layer-row[data-layer-id="${id}"]`).click();
    await inspector.getByLabel('Font family', { exact: true }).waitFor();
  };
  const field = name => inspector.getByLabel(name, { exact: name !== 'Weight' });
  const edit = async (name, value) => { const control = field(name); await control.fill(String(value)); await control.press('Tab'); };
  const color = async (name, value) => field(name).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  await selectLayer();
  const trigger = inspector.getByRole('button', { name: 'Edit lyrics background', exact: true });
  for (const viewport of [{ width: 1728, height: 1117 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport); await trigger.scrollIntoViewIfNeeded();
    const dimensions = await inspector.evaluate(element => {
      const body = element.querySelector('.inspector-body'), fields = element.querySelector('.inspector-fields'), trigger = element.querySelector('.lyrics-background-trigger');
      return { panel: element.getBoundingClientRect().width, body: body.clientWidth, content: body.scrollWidth, fields: fields.getBoundingClientRect().width,
        trigger: trigger.getBoundingClientRect().width, scrollLeft: body.scrollLeft, text: trigger.textContent,
        title: [...trigger.querySelectorAll('[title]'), trigger].map(item => item.getAttribute('title') ?? '').join(' ') };
    });
    assert.ok(dimensions.content <= dimensions.body + 1, JSON.stringify(dimensions));
    assert.ok(dimensions.fields <= dimensions.body && dimensions.trigger <= dimensions.body, 'Long media names cannot enlarge the inspector');
    assert.equal(dimensions.scrollLeft, 0, 'Inspector never scrolls horizontally to reach controls');
    assert.ok(dimensions.text.includes(displayName));
    assert.ok(dimensions.title.includes(displayName), 'Full filename remains available as a tooltip');
    await trigger.click();
    const popover = page.locator('.lyrics-background-popover');
    await popover.waitFor();
    const popup = await popover.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth,
      x: element.getBoundingClientRect().x, right: element.getBoundingClientRect().right }));
    assert.ok(popup.scroll <= popup.width + 1 && popup.x >= 0 && popup.right <= viewport.width, 'Long filename stays inside media popover');
    await page.screenshot({ path: path.join(dir, `lyrics-filename-${viewport.width}.png`), fullPage: true });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1728, height: 1117 });
  checks.push('long video filename remains truncated with full tooltip; inspector and popover fit desktop and laptop');

  await field('Font family').selectOption('courier');
  await edit('Size', 80); await field('Weight').selectOption('700');
  await inspector.getByRole('button', { name: 'Italic', exact: true }).click();
  await inspector.getByRole('button', { name: 'Underline', exact: true }).click();
  await edit('Letter spacing', 3); await edit('Line height', 1.6);
  await field('Text case').selectOption('uppercase');
  await field('Vertical text alignment').selectOption('bottom');
  await inspector.getByRole('button', { name: 'Align text left', exact: true }).click();
  await color('Text color', '#7dd3fc');
  await inspector.locator('.typography-effects > summary').click();
  await field('Text outline').check(); await edit('Outline width', 2); await color('Outline color', '#18283a');
  await field('Text shadow').check(); await edit('Shadow blur', 8); await edit('Horizontal shadow offset', 3); await edit('Vertical shadow offset', 5);
  await color('Shadow color', '#000000');
  await until(async () => {
    const item = await getLayer();
    return item.fontFamily === 'courier' && item.fontSize === 80 && item.fontWeight === 700 && item.italic && item.underline
      && item.letterSpacing === 3 && item.lineHeight === 1.6 && item.textTransform === 'uppercase' && item.verticalAlign === 'bottom' && item.align === 'left'
      && item.color === '#7dd3fc' && item.textStroke?.width === 2 && item.textStroke.color === '#18283a'
      && item.textShadow?.blur === 8 && item.textShadow.offsetX === 3 && item.textShadow.offsetY === 5;
  }, 'all typography settings persist');
  let releaseSave, saveStarted = false;
  const heldSave = new Promise(resolve => { releaseSave = resolve; });
  await page.route('**/api/studio', async route => {
    if (route.request().method() !== 'PUT' || saveStarted) return route.continue();
    saveStarted = true; await heldSave; return route.continue();
  });
  await field('Weight').selectOption('800');
  await until(() => saveStarted, 'unrelated typography save is held');
  for (const name of ['Italic', 'Underline']) {
    const toggle = inspector.getByRole('button', { name, exact: true });
    await toggle.click(); await toggle.click();
  }
  releaseSave();
  await until(async () => (await inspector.locator('.inspector-footer').innerText()).includes('Changes saved'), 'queued typography edits finish');
  await until(async () => { const item = await getLayer(); return item.fontWeight === 800 && item.italic === true && item.underline === true; }, 'two quick toggles preserve the original setting while saving');
  await page.unroute('**/api/studio');
  await field('Weight').selectOption('700');
  await until(async () => (await getLayer()).fontWeight === 700, 'font weight restored after delayed-save check');
  checks.push('quick italic and underline toggles remain correct while another save is delayed');
  await unchangedLive();
  const savedLayer = structuredClone(await getLayer());
  for (const scope of [page.locator(`.scene-card[data-scene-id="${sceneId}"]`), page.locator('.preview-panel')]) {
    const posterText = scope.locator('.poster-channel-text').first();
    await until(async () => {
      const styles = await posterText.evaluate(element => ({ family: getComputedStyle(element).fontFamily, italic: getComputedStyle(element).fontStyle,
        spacing: parseFloat(getComputedStyle(element).letterSpacing), size: parseFloat(getComputedStyle(element).fontSize), line: parseFloat(getComputedStyle(element).lineHeight), text: element.innerText }));
      return /courier/i.test(styles.family) && styles.italic === 'italic' && styles.spacing > 0 && styles.line / styles.size > 1.5 && styles.text.includes('TOGETHER IN THIS PLACE');
    }, 'offline Preview and scene thumbnail use matching font, spacing, line height and transformed text');
  }
  await field('Font family').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, 'lyrics-typography-controls.png'), fullPage: true });
  checks.push('font, weight, italic, underline, spacing, case, alignment, outline and shadow save and update scene poster');

  // Typography on a shared channel belongs to the layer, and ordinary text
  // uses the same editor without inheriting the Lyrics layer's choices.
  await selectLayer(otherSceneId, plainId);
  assert.equal(await field('Font family').inputValue(), 'system');
  await field('Font family').selectOption('georgia');
  await edit('Letter spacing', -1);
  await until(async () => (await getLayer(otherSceneId, plainId)).fontFamily === 'georgia' && (await getLayer(otherSceneId, plainId)).letterSpacing === -1, 'plain text styling saves');
  assert.deepEqual(await getLayer(), savedLayer, 'Styling another layer cannot alter Lyrics typography');
  await selectLayer();
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio' }).waitFor(); await selectLayer();
  assert.equal(await field('Font family').inputValue(), 'courier');
  assert.equal(await field('Line height').inputValue(), '1.6');
  assert.equal(await inspector.getByRole('button', { name: 'Italic', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await getLayer(), savedLayer);
  await unchangedLive();
  checks.push('plain text and Lyrics styles remain independent and reload correctly');

  // Inspect real decoded Program frames from this disposable renderer. The
  // constant dark video makes it possible to distinguish white legacy text
  // from cyan styled text and check the new bottom alignment on output.
  const started = await request.post(`${base}/api/studio/engine/start`);
  assert.equal(started.status(), 200, await started.text()); engineRunning = true;
  assert.equal((await started.json()).state, 'running');
  const programVideo = page.locator('.program-panel video').first();
  const sample = () => programVideo.evaluate(video => {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let white = 0, cyan = 0, cyanY = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      if (r > 160 && g > 160 && b > 160 && Math.max(r, g, b) - Math.min(r, g, b) < 30) white++;
      if (b > 145 && g > 135 && g - r > 30 && b - r > 50) { cyan++; cyanY += Math.floor(i / 4 / 320); }
    }
    return { white, cyan, cyanY: cyan ? cyanY / cyan : 0 };
  });
  await until(async () => { const frame = await sample(); return frame?.white > 80 && frame.cyan < 20; }, 'Program still displays committed white text before Take', 20000);
  await command({ type: 'take', sceneId });
  const live = await get();
  assert.deepEqual(live.program.layers.find(item => item.id === layerId), savedLayer);
  assert.deepEqual(live.outputs, baseline.outputs, 'Taking styled Lyrics does not change pinned output snapshots');
  await until(async () => { const frame = await sample(); return frame?.cyan > 80 && frame.cyanY > 115; }, 'real Program renders styled cyan text at the bottom after Take', 15000);
  await page.screenshot({ path: path.join(dir, 'lyrics-typography-live-program.png'), fullPage: true });
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200); engineRunning = false;
  checks.push('real Program keeps old typography until Take, then displays styled text with bottom alignment');

  await page.close(); page = null; await stopServer(); server = launchServer(); await waitForStation(); await login();
  assert.deepEqual(await getLayer(), savedLayer, 'Typography survives a full station restart');
  assert.deepEqual((await get()).program.layers.find(item => item.id === layerId), savedLayer);
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  checks.push('draft and committed typography survive a station restart');
  console.log(JSON.stringify({ checks, artifacts: dir }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(dir, 'lyrics-typography-failed.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: error.message, stack: error.stack, checks, errors, artifacts: dir, logs }, null, 2));
  process.exitCode = 1;
} finally {
  if (engineRunning && browser) await browser.contexts()[0]?.request.post(`${base}/api/studio/engine/stop`).catch(() => {});
  await browser?.close(); await stopServer();
}
