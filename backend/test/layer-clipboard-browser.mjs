// Run after npm run build. Uses only an isolated temporary station and synthetic
// media. Synthetic key events avoid reading or changing the OS clipboard.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-layer-clipboard-'));
const port = Number(process.env.LUMEN_LAYER_CLIPBOARD_TEST_PORT ?? 3465), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
await fs.mkdir(path.join(dir, 'media', 'backgrounds'), { recursive: true });
await fs.writeFile(path.join(dir, 'media', 'backgrounds', 'clipboard.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOkAAAAASUVORK5CYII=', 'base64'));
let logs = '', browser, page, releaseHeldSave;
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
const checks = [], errors = [];
async function until(fn, label, timeout = 10000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const withoutId = ({ id, ...layer }) => layer;
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station starts', 30000);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 } });
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const content = { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [{ id: 'lyrics', name: 'Worship lyrics', kind: 'lyrics', playlistId: 'p_lyrics', defaultMode: 'manual' }],
    playlists: [{ id: 'p_lyrics', name: 'Worship lyrics', items: [] }] };
  const contentResponse = await request.put(`${base}/api/content`, { data: content });
  assert.equal(contentResponse.status(), 200, await contentResponse.text());
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
  const originalId = 'clipboard_original', targetId = 'clipboard_target', thirdId = 'clipboard_third';
  const richId = 'clipboard_rich', plainId = 'clipboard_plain', sourceId = 'clipboard_source';
  const basic = { visible: true, locked: false, x: 10, y: 30, width: 80, height: 20, opacity: 1,
    fit: 'contain', text: 'A place to belong', color: '#ffffff', background: '#00000000', fontSize: 72, fontWeight: 500, align: 'center', radius: 0 };
  await save(document => {
    document.sources.push({ id: sourceId, name: 'Lyrics', kind: 'channel', channelId: 'lyrics', loop: false,
      audio: { muted: true, volume: 1, mode: 'follow', delayMs: 0 } });
    document.scenes.push({ id: originalId, name: 'Copy from this scene', background: '#111317', layers: [
      { ...basic, id: richId, name: 'Styled lyrics', kind: 'source', sourceId, visible: false, locked: true,
        x: 12.5, y: 65, width: 75, height: 25, opacity: .85, channelStyle: 'overlay',
        fontSize: 80, fontWeight: 700, fontFamily: 'georgia', italic: true, underline: true,
        lineHeight: 1.6, letterSpacing: 3, verticalAlign: 'bottom', textTransform: 'uppercase',
        textStroke: { color: '#18283a', width: 2 }, textShadow: { color: '#000000b3', blur: 8, offsetX: 3, offsetY: 5 },
        mediaBackground: { kind: 'image', url: 'media/backgrounds/clipboard.png', fit: 'cover', dim: .3, loop: false },
        animation: { enabled: true, preset: 'custom', durationMs: 800, delayMs: 75, easing: 'ease-in-out', keyframes: [
          { offset: 0, x: 24, y: 18, scale: .9, opacity: 0, rotation: -2 },
          { offset: 1, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
        ] } },
      { ...basic, id: plainId, name: 'Ordinary text', kind: 'text' },
    ] });
    document.scenes.push({ id: targetId, name: 'Paste into this scene', background: '#111317', layers: [] });
    document.scenes.push({ id: thirdId, name: 'Another empty scene', background: '#111317', layers: [] });
    document.previewSceneId = originalId;
  });
  await command({ type: 'take', sceneId: originalId });
  await command({ type: 'route', outputId: 'screen_main', sceneId: originalId });
  const baseline = await get(), initialRich = baseline.scenes.find(scene => scene.id === originalId).layers.find(layer => layer.id === richId);
  const scene = async id => (await get()).scenes.find(scene => scene.id === id);
  const layer = async (sceneId, id) => (await scene(sceneId)).layers.find(layer => layer.id === id);
  const unchangedOutputs = async () => {
    const document = await get();
    assert.deepEqual(document.program, baseline.program, 'Copy/paste never publishes draft changes');
    assert.deepEqual(document.outputs, baseline.outputs, 'Pinned output snapshots stay unchanged');
    assert.deepEqual(document.sources, baseline.sources, 'Pastes reuse the source without cloning it');
    assert.deepEqual(await fs.readdir(path.join(dir, 'media', 'backgrounds')), ['clipboard.png'], 'Pastes never duplicate media');
  };
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`Unexpected native ${dialog.type()} dialog`); void dialog.dismiss(); });
  await page.goto(`${base}/studio`);
  await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await page.getByRole('button', { name: 'Show compact scene list', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Layers', exact: true });
  const copy = panel.getByRole('button', { name: 'Copy layer', exact: true });
  const paste = panel.getByRole('button', { name: 'Paste layer', exact: true });
  const row = id => page.locator(`.layer-row[data-layer-id="${id}"]`);
  const sceneCard = id => page.locator(`.scene-card[data-scene-id="${id}"]`);
  const selectScene = async id => {
    await sceneCard(id).click();
    await until(async () => (await get()).previewSceneId === id && await sceneCard(id).getAttribute('aria-pressed') === 'true', `select scene ${id}`);
  };
  const selectLayer = async id => { await row(id).click(); await until(() => row(id).getAttribute('aria-selected').then(value => value === 'true'), `select layer ${id}`); };
  const key = (locator, letter, modifiers = { ctrlKey: true }) => locator.evaluate((element, { letter, modifiers }) => {
    const event = new KeyboardEvent('keydown', { key: letter, code: `Key${letter.toUpperCase()}`, bubbles: true, cancelable: true, ...modifiers });
    element.dispatchEvent(event); return event.defaultPrevented;
  }, { letter, modifiers });
  const nativeClipboard = (locator, type) => locator.evaluate((element, type) => {
    const event = new ClipboardEvent(type, { bubbles: true, cancelable: true });
    element.dispatchEvent(event); return event.defaultPrevented;
  }, type);
  const holdNextSave = async () => {
    await page.unroute('**/api/studio');
    let started = false;
    const held = new Promise(resolve => { releaseHeldSave = resolve; });
    await page.route('**/api/studio', async route => {
      if (route.request().method() !== 'PUT' || started) return route.continue();
      started = true; await held; return route.continue();
    });
    return { started: () => started, release: () => { releaseHeldSave(); releaseHeldSave = null; } };
  };

  assert.equal(await paste.isDisabled(), true, 'Paste starts unavailable with no app clipboard');
  await selectLayer(richId);
  await row(richId).click({ button: 'right', position: { x: 12, y: 12 } });
  const menu = page.locator('[data-studio-layer-menu]');
  await menu.getByRole('menuitem', { name: /^Copy layer/ }).click();
  await until(() => paste.getAttribute('title').then(value => value.includes('Styled lyrics')), 'context menu copies a locked hidden layer');
  await save(document => {
    const original = document.scenes.find(scene => scene.id === originalId).layers.find(layer => layer.id === richId);
    original.name = 'Changed after copying'; original.fontFamily = 'arial'; original.mediaBackground.dim = .8; original.animation.keyframes[0].x = 99;
  });
  await until(() => row(richId).innerText().then(text => text.includes('Changed after copying')), 'external draft edit reaches the workspace');
  await selectScene(targetId);
  assert.equal(await copy.isDisabled(), true, 'An empty scene has no layer to copy');
  assert.equal(await paste.isEnabled(), true, 'Empty scenes can accept a copied layer');
  await paste.click();
  const first = await until(async () => (await scene(targetId)).layers[0], 'paste into empty scene');
  assert.notEqual(first.id, richId);
  assert.deepEqual(withoutId(first), withoutId(initialRich), 'Paste uses the complete Copy-time snapshot, including hidden/locked state and nested settings');
  await selectLayer(first.id);
  assert.equal(await key(row(first.id), 'v', { metaKey: true }), true, 'Mac paste shortcut is handled on a layer row');
  await until(async () => (await scene(targetId)).layers.length === 2, 'repeated paste creates another layer');
  const second = (await scene(targetId)).layers[1];
  assert.notEqual(second.id, first.id);
  assert.deepEqual(withoutId(second), withoutId(initialRich));
  await save(document => {
    const pasted = document.scenes.find(scene => scene.id === targetId).layers.find(layer => layer.id === first.id);
    pasted.name = 'Independent copy'; pasted.textShadow.offsetY = 12; pasted.animation.keyframes[0].x = -30; pasted.mediaBackground.dim = .1;
  });
  await until(() => row(first.id).innerText().then(text => text.includes('Independent copy')), 'independent paste edit reaches the workspace');
  assert.deepEqual(await layer(targetId, second.id), second, 'Editing one paste does not mutate another nested snapshot');
  assert.equal((await layer(originalId, richId)).animation.keyframes[0].x, 99, 'Pasted settings do not modify the original');
  await unchangedOutputs();
  checks.push('context Copy and empty-scene Paste preserve all properties, reuse sources/media and create independently editable IDs');

  // Copy waits for the preceding rename. Paste keeps that pending Copy entry,
  // even when a second Copy and a scene selection are queued before it runs.
  await selectScene(originalId); await selectLayer(richId);
  const heldCopy = await holdNextSave();
  await row(richId).locator('.layer-name').dblclick();
  const rename = panel.getByLabel('Layer name', { exact: true });
  await rename.fill('Renamed before copying'); await rename.press('Enter');
  await until(heldCopy.started, 'rename save is delayed');
  await copy.click(); await paste.click();
  await selectLayer(plainId); await copy.click();
  await sceneCard(targetId).click();
  await heldCopy.release();
  await until(async () => (await scene(originalId)).layers.length === 3 && (await get()).previewSceneId === targetId, 'pending Copy/Paste and scene switch drain');
  const pendingPaste = (await scene(originalId)).layers.find(item => ![richId, plainId].includes(item.id));
  assert.deepEqual(withoutId(pendingPaste), withoutId(await layer(originalId, richId)), 'Pending Copy includes the preceding rename and Paste is not replaced by the later Copy');
  await until(() => paste.getAttribute('title').then(value => value.includes('Ordinary text')), 'later Copy becomes the new clipboard');
  const heldPaste = await holdNextSave();
  await paste.click(); await until(heldPaste.started, 'paste save is delayed');
  await sceneCard(thirdId).click(); await heldPaste.release();
  await until(async () => (await get()).previewSceneId === thirdId, 'rapid switch finishes after paste');
  assert.equal((await scene(thirdId)).layers.length, 0, 'A pending Paste never leaks into the newly selected scene');
  const pastedText = (await scene(targetId)).layers.find(item => item.kind === 'text');
  assert.ok(pastedText, 'Paste remains in the scene chosen when invoked');
  assert.deepEqual(withoutId(pastedText), withoutId(await layer(originalId, plainId)));
  await unchangedOutputs();
  checks.push('pending saves, Copy A → Paste → Copy B and rapid scene switching preserve the intended snapshot and destination');

  // The destination can be chosen while an earlier save is pending. Paste
  // follows that choice immediately, before Preview selection is acknowledged.
  await selectScene(originalId); await selectLayer(plainId);
  const destinationHold = await holdNextSave();
  await row(plainId).locator('.layer-name').dblclick();
  await panel.getByLabel('Layer name', { exact: true }).fill('Queued destination text');
  await panel.getByLabel('Layer name', { exact: true }).press('Enter');
  await until(destinationHold.started, 'save before destination selection is delayed');
  await copy.click(); await sceneCard(thirdId).click();
  assert.equal(await key(sceneCard(thirdId), 'v'), true, 'Paste is available immediately after selecting the destination');
  destinationHold.release();
  await until(async () => (await scene(thirdId)).layers.length === 1, 'queued destination receives paste');
  assert.equal((await scene(thirdId)).layers[0].name, 'Queued destination text');
  assert.equal((await scene(originalId)).layers.length, 3, 'Pending selection does not paste into the outgoing scene');
  await selectScene(originalId); await selectLayer(plainId);
  const addSceneHold = await holdNextSave(), scenesBeforeAdd = (await get()).scenes.map(scene => scene.id);
  await row(plainId).locator('.layer-name').dblclick();
  await panel.getByLabel('Layer name', { exact: true }).fill('Queued new scene text');
  await panel.getByLabel('Layer name', { exact: true }).press('Enter');
  await until(addSceneHold.started, 'save before Add scene is delayed');
  await copy.click();
  await page.getByRole('button', { name: 'New scene', exact: true }).click();
  await paste.click(); addSceneHold.release();
  const addedScene = await until(async () => (await get()).scenes.find(scene => !scenesBeforeAdd.includes(scene.id) && scene.layers.length === 1), 'queued new scene receives paste');
  assert.equal(addedScene.layers[0].name, 'Queued new scene text');
  await unchangedOutputs();
  checks.push('immediate Paste follows a queued destination selection or a newly added scene');

  await selectScene(originalId); await selectLayer(plainId);
  assert.equal(await key(row(plainId), 'c'), true, 'Windows copy shortcut is handled');
  await until(() => paste.getAttribute('title').then(value => value.includes('Queued new scene text')), 'keyboard Copy completes');
  const beforeNativePaste = (await scene(originalId)).layers.length;
  assert.equal(await nativeClipboard(row(plainId), 'copy'), true, 'Desktop Edit menu Copy is handled on a layer');
  assert.equal(await nativeClipboard(row(plainId), 'paste'), true, 'Desktop Edit menu Paste is handled on a layer');
  await until(async () => (await scene(originalId)).layers.length === beforeNativePaste + 1, 'native Edit menu Paste creates one layer');
  await selectLayer(plainId);
  const beforeGuards = await get();
  await row(plainId).locator('.layer-name').dblclick();
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    for (const letter of ['c', 'v']) assert.equal(await key(panel.getByLabel('Layer name', { exact: true }), letter, modifiers), false, 'Input copy/paste stays native');
  }
  for (const type of ['copy', 'paste']) assert.equal(await nativeClipboard(panel.getByLabel('Layer name', { exact: true }), type), false, 'Desktop Edit menu remains native inside an input');
  await panel.getByLabel('Layer name', { exact: true }).press('Escape');
  await page.getByRole('button', { name: 'Scene shortcuts', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await key(page.locator('.studio-app'), 'v'), false, 'An open modal prevents layer Paste');
  assert.equal(await nativeClipboard(page.locator('.studio-app'), 'paste'), false, 'An open modal also prevents native-menu layer Paste');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await selectLayer(plainId);
  const selectedTextCopy = await page.locator('.preview-note').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString();
    const event = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event); return { text, prevented: event.defaultPrevented };
  });
  assert.ok(selectedTextCopy.text.length > 0, 'The browser has an actual UI text selection');
  assert.equal(selectedTextCopy.prevented, false, 'Copying selected UI text stays native');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  assert.deepEqual((await get()).scenes, beforeGuards.scenes, 'Typing and modal guards never add layers or alter designs');
  checks.push('Ctrl/Cmd shortcuts and desktop Edit menu events work on Studio rows while inputs, selected text and dialogs retain native behavior');

  await selectLayer(richId); await copy.click();
  const copiedBeforeRemoval = await layer(originalId, richId);
  await until(() => paste.getAttribute('title').then(value => value.includes(copiedBeforeRemoval.name)), 'copy before removing original');
  await save(document => { const original = document.scenes.find(scene => scene.id === originalId); original.layers = original.layers.filter(layer => layer.id !== richId); });
  await until(() => row(richId).count().then(count => count === 0), 'original removal reaches the workspace');
  const thirdLayersBefore = (await scene(thirdId)).layers.map(layer => layer.id);
  await selectScene(thirdId); await paste.click();
  const detachedPaste = await until(async () => (await scene(thirdId)).layers.find(layer => !thirdLayersBefore.includes(layer.id)), 'paste survives removal of the original layer');
  assert.deepEqual(withoutId(detachedPaste), withoutId(copiedBeforeRemoval));
  await selectLayer(detachedPaste.id);
  await row(detachedPaste.id).click({ button: 'right', position: { x: 12, y: 12 } });
  await menu.getByRole('menuitem', { name: /^Paste layer/ }).click();
  await until(async () => (await scene(thirdId)).layers.length === thirdLayersBefore.length + 2, 'context menu Paste works');
  await unchangedOutputs();
  const persisted = await get();
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await until(() => row(detachedPaste.id).isVisible(), 'pasted layer renders after reload');
  assert.deepEqual((await get()).scenes, persisted.scenes, 'Pasted layers persist after reload');
  assert.equal(await paste.isDisabled(), true, 'Only the clipboard resets at the end of the browser session');
  checks.push('removing the original does not invalidate a copied snapshot; context Paste and persisted layers survive reload');

  await selectLayer(detachedPaste.id); await copy.click();
  await until(() => paste.getAttribute('title').then(value => value.includes(detachedPaste.name)), 'copy before source removal');
  await page.setViewportSize({ width: 1366, height: 768 });
  await selectLayer(detachedPaste.id); await paste.scrollIntoViewIfNeeded();
  const footerFits = await panel.locator('.layer-panel-footer').evaluate(footer => {
    const bounds = footer.getBoundingClientRect();
    return footer.scrollWidth <= footer.clientWidth + 1 && [...footer.querySelectorAll('button')].every(button => {
      const rect = button.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right + 1 && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1;
    });
  });
  assert.ok(footerFits, 'Layer footer actions remain inside the panel at laptop width');
  await page.screenshot({ path: path.join(dir, 'layer-clipboard-footer-1366.png'), fullPage: true });
  await row(detachedPaste.id).click({ button: 'right', position: { x: 12, y: 12 } });
  await menu.waitFor();
  const menuFits = await menu.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight; });
  assert.ok(menuFits, 'Layer context menu stays inside the laptop viewport');
  await page.screenshot({ path: path.join(dir, 'layer-clipboard-menu-1366.png'), fullPage: true });
  await menu.press('Escape'); await menu.waitFor({ state: 'hidden' });
  checks.push('Copy/Paste footer and context menu fit a 1366px laptop viewport');

  await command({ type: 'remove-source', sourceId });
  await until(() => row(detachedPaste.id).count().then(count => count === 0), 'source removal reaches the workspace');
  const afterRemoval = await get();
  await paste.click();
  await page.getByText('The copied layer’s source was removed. Add the source again, then copy its layer.', { exact: true }).first().waitFor();
  assert.deepEqual((await get()).scenes, afterRemoval.scenes, 'A missing source cannot create a broken pasted layer');
  checks.push('removed sources produce a readable error without adding an invalid layer');
  await page.screenshot({ path: path.join(dir, 'layer-clipboard-checked.png'), fullPage: true });
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  console.log(JSON.stringify({ checks, artifacts: dir }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(dir, 'layer-clipboard-failed.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: error.message, stack: error.stack, checks, errors, artifacts: dir, logs }, null, 2));
  process.exitCode = 1;
} finally {
  releaseHeldSave?.();
  await page?.unrouteAll({ behavior: 'wait' }).catch(() => {});
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited; }
  }
}
