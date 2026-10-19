// Run after npm run build. Every edit belongs to an isolated temporary station;
// this suite never opens physical inputs or modifies an operator's production.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-studio-editing-'));
const port = Number(process.env.LUMEN_EDITING_TEST_PORT ?? 3418), base = `http://127.0.0.1:${port}`;
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
server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
const errors = [], checks = [];
async function until(fn, label, timeout = 15000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
function closeTo(actual, expected, label, tolerance = .001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, received ${actual}`);
}
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
  const layer = (id, name, patch) => ({ id, name, kind: 'shape', visible: true, locked: false,
    x: 10, y: 15, width: 25, height: 20, opacity: 1, fit: 'contain', text: '',
    color: '#ffffff', background: '#7dd3fc', fontSize: 48, fontWeight: 500, align: 'center', radius: 8, ...patch });
  const sceneId = 'editing_fixture', alphaId = 'edit_alpha', betaId = 'edit_beta', gammaId = 'edit_gamma';
  await save(state => {
    state.scenes.push({ id: sceneId, name: 'Editing rehearsal', background: '#111317', layers: [
      layer(alphaId, 'Welcome card', { background: '#7dd3fc' }),
      layer(betaId, 'Speaker title', { kind: 'text', text: 'A message of hope', x: 60, y: 15, width: 30, background: '#00000000' }),
      layer(gammaId, 'Accent block', { x: 35, y: 65, width: 25, background: '#b7cfad' }),
    ] });
    state.previewSceneId = sceneId;
  });
  await command({ type: 'take', sceneId });
  await command({ type: 'route', outputId: 'screen_main', sceneId });
  const committed = await get(), committedProgram = committed.program, committedOutputs = committed.outputs;
  const draft = async () => (await get()).scenes.find(scene => scene.id === sceneId);
  const currentLayer = async id => (await draft()).layers.find(layer => layer.id === id);
  const unchangedOutputs = async label => {
    const state = await get();
    assert.deepEqual(state.program, committedProgram, `${label} must not publish Preview changes`);
    assert.deepEqual(state.outputs, committedOutputs, `${label} must not change pinned or following output routes`);
  };
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => {
    errors.push(`Unexpected native ${dialog.type()} dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  await page.goto(`${base}/studio`);
  await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await page.getByRole('button', { name: 'Hide scenes', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const frame = page.getByLabel('Preview canvas', { exact: true });
  const row = id => page.locator(`.layer-row[data-layer-id="${id}"]`);
  const selectLayer = async id => { await row(id).click(); await until(() => row(id).evaluate(el => el.classList.contains('selected')), `select ${id}`); };
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layoutRevision = (await get()).revision;

  // Fullscreen is the browser's actual fullscreen surface, not a CSS-sized panel.
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await until(() => page.evaluate(() => document.fullscreenElement === document.documentElement), 'enter document fullscreen');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await until(() => page.evaluate(() => document.fullscreenElement === null), 'leave document fullscreen');
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).press('Space');
  await until(() => page.evaluate(() => document.fullscreenElement === document.documentElement), 'Space activates the focused fullscreen button');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).press('Space');
  await until(() => page.evaluate(() => document.fullscreenElement === null), 'Space exits through the focused fullscreen button');
  assert.equal((await get()).revision, layoutRevision, 'Space on fullscreen controls must never Cut the prepared scene');
  await page.locator('.studio-workspace').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('f');
  await until(() => page.evaluate(() => !!document.fullscreenElement), 'F enters fullscreen');
  await page.keyboard.press('f');
  await until(() => page.evaluate(() => document.fullscreenElement === null), 'F leaves fullscreen');
  await page.getByLabel('Fade duration', { exact: true }).focus();
  await page.keyboard.press('f');
  assert.equal(await page.evaluate(() => document.fullscreenElement), null, 'Typing F in a field must not enter fullscreen');
  await page.keyboard.press('Escape');
  await page.locator('.studio-workspace').click({ position: { x: 8, y: 8 } });
  await page.evaluate(() => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, ...modifiers }));
    }
  });
  assert.equal(await page.evaluate(() => document.fullscreenElement), null, 'Modified or repeated F keys must not toggle fullscreen');
  checks.push('real document fullscreen, F toggle and editing/modifier safety');

  // Both collapsible columns return their grid space, persist across reloads,
  // and remain independently accessible on narrow screens.
  const expandedWidth = (await page.locator('.studio-workspace').boundingBox()).width;
  await page.getByRole('button', { name: 'Hide scenes', exact: true }).click();
  assert.equal(await page.getByRole('complementary', { name: 'Scenes', exact: true }).isVisible(), false);
  assert.ok((await page.locator('.studio-workspace').boundingBox()).width > expandedWidth + 150, 'Collapsed Scenes column returns its width');
  await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
  const wideWidth = (await page.locator('.studio-workspace').boundingBox()).width;
  assert.ok(wideWidth > expandedWidth + 400, 'Collapsing both panels returns both grid columns');
  await page.reload();
  await page.getByRole('button', { name: 'Show scenes', exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Show inspector', exact: true }).isVisible());
  closeTo((await page.locator('.studio-workspace').boundingBox()).width, wideWidth, 'Collapsed workspace width survives reload', 1);
  await page.getByRole('button', { name: 'Show scenes', exact: true }).click();
  await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  assert.equal((await get()).revision, layoutRevision, 'Layout preferences never mutate the production document');
  await unchangedOutputs('Fullscreen and panel layout');
  checks.push('Scenes collapse, independent inspector grid space and reload persistence');

  // Top of the visual list is the frontmost (last) compositor layer.
  const beforeOrder = (await draft()).layers.map(layer => layer.id);
  assert.deepEqual(await page.locator('.layer-row').evaluateAll(rows => rows.map(row => row.dataset.layerId)), [...beforeOrder].reverse());
  await row(gammaId).scrollIntoViewIfNeeded();
  const targetBounds = await row(alphaId).boundingBox();
  await row(gammaId).dragTo(row(alphaId), { targetPosition: { x: Math.min(40, targetBounds.width / 2), y: targetBounds.height - 3 } });
  await until(async () => (await draft()).layers[0].id === gammaId, 'dragging front layer to back saves stacking order');
  assert.deepEqual(await page.locator('.layer-row').evaluateAll(rows => rows.map(row => row.dataset.layerId)), (await draft()).layers.map(layer => layer.id).reverse());
  await row(betaId).locator('.layer-name').dblclick();
  const inlineName = page.locator('.layers-panel').getByLabel('Layer name', { exact: true });
  await inlineName.fill('Sermon title'); await inlineName.press('Enter');
  await until(async () => (await currentLayer(betaId)).name === 'Sermon title', 'inline rename persists');
  await row(betaId).locator('.layer-name').dblclick();
  await inlineName.fill('Discard this name'); await inlineName.press('Escape');
  assert.equal((await currentLayer(betaId)).name, 'Sermon title', 'Escape cancels inline rename');
  await selectLayer(betaId);
  await page.getByRole('button', { name: 'Duplicate layer', exact: true }).first().click();
  const duplicate = await until(async () => (await draft()).layers.find(layer => ![alphaId, betaId, gammaId].includes(layer.id)), 'duplicate layer');
  assert.notEqual(duplicate.id, betaId); assert.equal(duplicate.text, (await currentLayer(betaId)).text);
  await page.getByRole('button', { name: 'Delete layer', exact: true }).first().click();
  await until(async () => (await draft()).layers.length === 3, 'delete duplicate');
  await selectLayer(alphaId);
  await row(alphaId).getByRole('button', { name: 'Hide Welcome card', exact: true }).click();
  await until(async () => !(await currentLayer(alphaId)).visible, 'hide layer');
  await row(alphaId).getByRole('button', { name: 'Show Welcome card', exact: true }).click();
  await until(async () => (await currentLayer(alphaId)).visible, 'show layer');
  await row(alphaId).getByRole('button', { name: 'Lock Welcome card', exact: true }).click();
  await until(async () => (await currentLayer(alphaId)).locked, 'lock layer');
  const lockedState = await currentLayer(alphaId), lockedRevision = (await get()).revision;
  await frame.focus(); await page.keyboard.press('ArrowRight');
  const lockedBox = await page.locator('.layer-hitbox.selected').boundingBox();
  await page.mouse.move(lockedBox.x + lockedBox.width / 2, lockedBox.y + lockedBox.height / 2);
  await page.mouse.down(); await page.mouse.move(lockedBox.x + lockedBox.width / 2 + 30, lockedBox.y + lockedBox.height / 2 + 20, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(180);
  assert.deepEqual(await currentLayer(alphaId), lockedState, 'Locked elements cannot move with keys or a pointer');
  assert.equal((await get()).revision, lockedRevision, 'Locked no-op interactions must not save a revision');
  await row(alphaId).getByRole('button', { name: 'Unlock Welcome card', exact: true }).click();
  await until(async () => !(await currentLayer(alphaId)).locked, 'unlock layer');
  await unchangedOutputs('Layer list editing');
  checks.push('top-down drag stacking, inline rename/cancel, duplicate/delete, visibility and lock protections');

  // Pixel fields remain exact despite the compositor's percentage coordinates.
  await selectLayer(alphaId);
  const units = page.getByLabel('Layout units', { exact: true });
  assert.equal(await units.inputValue(), 'px');
  const xField = page.getByLabel('X', { exact: true }), widthField = page.getByLabel('Width', { exact: true });
  await xField.fill('192'); await xField.press('Tab');
  await until(async () => Math.abs((await currentLayer(alphaId)).x - 10) < .001, 'pixel X editing');
  await widthField.fill('480'); await widthField.press('Tab');
  await until(async () => Math.abs((await currentLayer(alphaId)).width - 25) < .001, 'pixel Width editing');
  const beforeNudge = await currentLayer(alphaId);
  await frame.focus(); await page.keyboard.press('ArrowRight');
  await until(async () => (await currentLayer(alphaId)).x > beforeNudge.x, 'one pixel nudge');
  closeTo((await currentLayer(alphaId)).x, beforeNudge.x + 100 / 1920, 'ArrowRight moves one output pixel');
  await page.keyboard.press('Shift+ArrowDown');
  await until(async () => (await currentLayer(alphaId)).y > beforeNudge.y, 'ten pixel nudge');
  closeTo((await currentLayer(alphaId)).y, beforeNudge.y + 1000 / 1080, 'Shift+ArrowDown moves ten output pixels');
  const beforeFieldKey = await currentLayer(alphaId);
  await xField.focus(); await page.keyboard.press('ArrowRight');
  assert.deepEqual(await currentLayer(alphaId), beforeFieldKey, 'Editing numeric fields does not trigger canvas shortcuts');
  await unchangedOutputs('Precise positioning and nudging');
  checks.push('1920×1080 pixel inspector fields and one/ten-pixel canvas nudges');

  // Canvas interactions are local until pointer-up. Escape and pointercancel
  // discard the gesture, including any visible alignment snapping guides.
  await selectLayer(alphaId);
  await until(() => page.locator('.layer-hitbox.selected .resize-handle').count().then(count => count === 8), 'eight resize handles');
  const beforeCancel = await currentLayer(alphaId), cancelRevision = (await get()).revision;
  const box = await page.locator('.layer-hitbox.selected').boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 26, start.y + 18, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForTimeout(180);
  assert.deepEqual(await currentLayer(alphaId), beforeCancel, 'Escape restores the starting geometry');
  assert.equal((await get()).revision, cancelRevision, 'Cancelled drag must not write a revision');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 18, start.y + 12, { steps: 3 });
  await page.locator('.layer-hitbox.selected').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
  await page.mouse.up(); await page.waitForTimeout(180);
  assert.deepEqual(await currentLayer(alphaId), beforeCancel, 'Pointer cancellation also restores the starting geometry');
  assert.equal((await get()).revision, cancelRevision, 'Pointer cancellation must not write a revision');
  const resize = page.getByRole('button', { name: 'Resize layer', exact: true });
  const resizeBox = await resize.boundingBox();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2); await page.mouse.down();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 22, resizeBox.y + resizeBox.height / 2 + 14, { steps: 5 }); await page.mouse.up();
  await until(async () => (await currentLayer(alphaId)).width > beforeCancel.width, 'corner resize persists');
  const resized = await currentLayer(alphaId); assert.ok(resized.height > beforeCancel.height, 'Corner handle adjusts both dimensions');
  // Put the card near the canvas center so its center snaps at a predictable
  // point, independent of window size or inspector width.
  await save(state => {
    const card = state.scenes.find(scene => scene.id === sceneId).layers.find(layer => layer.id === alphaId);
    Object.assign(card, { x: 10, y: 15, width: 25, height: 20 });
  });
  await until(async () => Math.abs(Number(await xField.inputValue()) - 192) < .1, 'snapping fixture arrives');
  const snapFrame = await frame.boundingBox(), snapBox = await page.locator('.layer-hitbox.selected').boundingBox();
  const snapStart = { x: snapBox.x + snapBox.width / 2, y: snapBox.y + snapBox.height / 2 };
  await page.mouse.move(snapStart.x, snapStart.y); await page.mouse.down();
  await page.mouse.move(snapStart.x + snapFrame.width * .274, snapStart.y + snapFrame.height * .247, { steps: 8 });
  await until(() => page.locator('.snap-guide').count().then(count => count > 0), 'alignment guides appear');
  await page.screenshot({ path: path.join(dir, 'studio-editing-snapping.png'), fullPage: true });
  await page.mouse.up();
  await until(async () => Math.abs((await currentLayer(alphaId)).x - 37.5) < .02 && Math.abs((await currentLayer(alphaId)).y - 40) < .02, 'center snapping persists exact coordinates');
  await unchangedOutputs('Canvas drag, cancellation, resize and snapping');
  checks.push('eight resize handles, Escape cancellation without saves, live snapping guides and exact center placement');

  // The same compact contextual properties are available from canvas and list.
  const menu = page.locator('[data-studio-layer-menu]');
  const openCanvasMenu = async () => {
    await page.locator('.layer-hitbox.selected').click({ button: 'right', position: { x: 12, y: 12 } });
    await menu.waitFor();
  };
  const menuItem = name => page.getByRole('menuitem', { name, exact: true });
  const submenu = async (group, item) => { await menuItem(group).hover(); await menuItem(item).click(); };
  await openCanvasMenu();
  const menuSurface = await menu.evaluate(el => {
    const css = getComputedStyle(el);
    return { color: css.backgroundColor, radius: Number.parseFloat(css.borderRadius), padding: Number.parseFloat(css.paddingTop) };
  });
  const menuColor = menuSurface.color.match(/rgba?\(([^)]+)\)/)?.[1].split(',').map(Number);
  assert.ok(menuColor && (menuColor.length === 3 || menuColor[3] >= .95), `Context properties need an opaque surface, not canvas text overlay: ${menuSurface.color}`);
  assert.ok(menuSurface.radius >= 8 && menuSurface.padding >= 4, 'Portalled properties menu retains its styled surface and spacing');
  await page.screenshot({ path: path.join(dir, 'studio-editing-context-menu.png'), fullPage: true });
  await submenu('Align to canvas', 'Align left');
  await until(async () => (await currentLayer(alphaId)).x === 0, 'contextual left alignment');
  await openCanvasMenu(); await submenu('Placement presets', 'Lower third');
  const lowerThird = await until(async () => { const layer = await currentLayer(alphaId); return layer.y > 60 && layer.width > 50 ? layer : null; }, 'lower-third placement preset');
  assert.ok(lowerThird.y + lowerThird.height <= 100, 'Lower third remains inside the output frame');
  await row(alphaId).click({ button: 'right' }); await menu.waitFor();
  await submenu('Arrange', 'Bring to front');
  await until(async () => (await draft()).layers.at(-1).id === alphaId, 'contextual arrange to front');
  // Open close to the viewport edge: the menu must clamp, not be clipped.
  await row(alphaId).evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 3, clientY: innerHeight - 3 })));
  await menu.waitFor(); await settled();
  const menuBounds = await menu.boundingBox(), viewport = page.viewportSize();
  assert.ok(menuBounds.x >= 0 && menuBounds.y >= 0 && menuBounds.x + menuBounds.width <= viewport.width && menuBounds.y + menuBounds.height <= viewport.height, 'Properties menu clamps inside the viewport');
  await page.keyboard.press('Escape');
  await openCanvasMenu(); await submenu('Placement presets', 'Fill canvas');
  await until(async () => (await currentLayer(alphaId)).width === 100 && (await currentLayer(alphaId)).height === 100, 'full-canvas placement preset');
  const fullFrame = await frame.boundingBox();
  for (const handle of await page.locator('.layer-hitbox.selected .resize-handle').all()) {
    const bounds = await handle.boundingBox();
    assert.ok(bounds.x >= fullFrame.x - 1 && bounds.y >= fullFrame.y - 1 && bounds.x + bounds.width <= fullFrame.x + fullFrame.width + 1 && bounds.y + bounds.height <= fullFrame.y + fullFrame.height + 1, 'Full-canvas resize handles remain entirely usable inside the clipped stage');
  }
  const nameBounds = await page.locator('.layer-hitbox.selected .selection-name').boundingBox();
  assert.ok(nameBounds.y >= fullFrame.y && nameBounds.y + nameBounds.height <= fullFrame.y + fullFrame.height, 'Top-edge selection label remains visible inside the stage');
  await openCanvasMenu(); await submenu('Placement presets', 'Lower third');
  await until(async () => (await currentLayer(alphaId)).y === lowerThird.y, 'lower-third layout restored');
  await unchangedOutputs('Contextual align, arrange and placement presets');
  checks.push('opaque canvas/list context properties, alignment, stacking, presets, edge resize handles and viewport clamping');

  const finalDraft = await draft();
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  assert.deepEqual(await draft(), finalDraft, 'Layer edits persist after reloading the operator');
  await selectLayer(alphaId);
  await page.locator('.studio-workspace').evaluate(el => { el.scrollTop = 0; });
  await settled();
  await page.screenshot({ path: path.join(dir, 'studio-editing-desktop.png'), fullPage: true });
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const collapseInspector = page.getByRole('button', { name: 'Collapse inspector', exact: true });
    if (await collapseInspector.isVisible()) await collapseInspector.click();
    const hideScenes = page.getByRole('button', { name: 'Hide scenes', exact: true });
    if (await hideScenes.isVisible()) await hideScenes.click();
    await page.getByRole('button', { name: 'Show scenes', exact: true }).click();
    const sidebar = await page.getByRole('complementary', { name: 'Scenes', exact: true }).boundingBox();
    assert.ok(sidebar.x >= 0 && sidebar.x + sidebar.width <= width, `Scenes sidebar stays in bounds at ${width}px`);
    await page.getByRole('button', { name: 'Hide scenes', exact: true }).click();
    assert.ok(await page.getByRole('button', { name: 'Show scenes', exact: true }).isVisible());
    const liveButton = page.locator('.lumen-header').getByRole('button', { name: 'Open Live View', exact: true });
    await liveButton.click({ trial: true });
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click({ trial: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Studio does not overflow horizontally at ${width}px`);
    if (width === 390) { await settled(); await page.screenshot({ path: path.join(dir, 'studio-editing-mobile.png'), fullPage: true }); }
  }
  await unchangedOutputs('Reload and responsive Studio layout');
  assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('\n')}`);
  checks.push('persistent draft geometry, responsive sidebar and accessible mobile fullscreen/live-view controls', 'Program and independent outputs unchanged throughout all edits');
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'studio-editing-failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exit = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 6000))]);
  }
}
