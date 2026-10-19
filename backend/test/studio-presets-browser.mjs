// Run after npm run build. Every fixture belongs to a temporary station. This
// suite never opens physical inputs or touches an operator's production files.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-studio-presets-'));
const port = Number(process.env.LUMEN_PRESETS_TEST_PORT ?? 3420), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page, request, server;
const errors = [], checks = [];
function startServer() {
  const process = spawn(globalThis.process.execPath, ['backend/dist/server.js'], {
    cwd: root, env: { ...globalThis.process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.on('data', value => { logs += value; }); process.stderr.on('data', value => { logs += value; });
  return process;
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Temporary station did not stop')), 6000); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn, label, timeout = 15000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const layer = (id, name, patch = {}) => ({ id, name, kind: 'shape', visible: true, locked: false,
  x: 10, y: 15, width: 25, height: 20, opacity: .8, fit: 'contain', text: '',
  color: '#ffffff', background: '#7dd3fc', fontSize: 48, fontWeight: 500, align: 'center', radius: 8, ...patch });
const frame = (offset, patch = {}) => ({ offset, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0, ...patch });
const originalAnimation = { enabled: true, preset: 'fade', durationMs: 400, delayMs: 0, easing: 'ease-out',
  keyframes: [frame(0, { opacity: 0 }), frame(1)] };
const expectedAnimation = { enabled: true, preset: 'custom', durationMs: 1250, delayMs: 175, easing: 'ease-in-out',
  keyframes: [frame(0, { x: -240, y: 80, scale: .85, opacity: .15, rotation: -12 }),
    frame(.5, { x: -80, y: 25, scale: .95, opacity: .7, rotation: -3 }), frame(1)] };
const sceneId = 'presets_first_scene', secondSceneId = 'presets_second_scene';
const alphaId = 'presets_alpha', betaId = 'presets_beta', gammaId = 'presets_gamma';
const presetName = 'Sermon welcome', renamedPresetName = 'Welcome · soft entrance';
const withoutAnimation = value => { const { animation, ...rest } = value; return rest; };

try {
  server = startServer();
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station start', 30000);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 } }); request = context.request;
  const login = async () => { const response = await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }); assert.equal(response.status(), 200, await response.text()); };
  await login();
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
  const currentLayer = async (id, scene = sceneId) => (await get()).scenes.find(value => value.id === scene).layers.find(value => value.id === id);
  await save(state => {
    state.scenes.push({ id: sceneId, name: 'Preset source scene', background: '#111317', layers: [
      layer(alphaId, 'Original welcome card', { animation: originalAnimation }),
      layer(betaId, 'Another welcome card', { x: 60, y: 50, width: 30, height: 15, background: '#b7cfad' }),
    ] }, { id: secondSceneId, name: 'Preset destination scene', background: '#29241e', layers: [
      layer(gammaId, 'Closing message card', { x: 35, y: 30, width: 40, height: 25, opacity: .6, background: '#ffcc66' }),
    ] }); state.previewSceneId = sceneId;
  });
  await command({ type: 'take', sceneId });
  await command({ type: 'route', outputId: 'screen_main', sceneId: secondSceneId });
  const onAir = await get();
  const unchangedAir = async label => {
    const state = await get();
    assert.deepEqual(state.program, onAir.program, `${label} must not change committed Program`);
    assert.deepEqual(state.programTransition, onAir.programTransition, `${label} must not trigger a Take`);
    assert.deepEqual(state.outputs, onAir.outputs, `${label} must not change output snapshots, routes, or animation run identities`);
  };
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const controller = await context.newPage(); controller.on('pageerror', error => errors.push(error.message));
  const openStudio = async target => { await target.goto(`${base}/studio`); await target.getByRole('heading', { name: 'Production Studio' }).waitFor(); await target.evaluate(() => document.fonts.ready); };
  await openStudio(page); await openStudio(controller);
  const row = (target, id) => target.locator(`.layer-row[data-layer-id="${id}"]`);
  const selectLayer = async (target, id) => { await row(target, id).click(); await until(() => row(target, id).evaluate(value => value.classList.contains('selected')), `select ${id}`); };
  const editor = page.getByRole('dialog', { name: 'Animation editor', exact: true });
  const library = target => target.getByRole('dialog', { name: 'Animation presets', exact: true });
  const fillNumber = async (scope, label, value) => { const input = scope.getByLabel(label, { exact: true }); await input.fill(String(value)); await input.press('Tab'); };
  const closeLibrary = async target => { if (await library(target).isVisible()) { await library(target).press('Escape'); await library(target).waitFor({ state: 'hidden' }); } };
  await selectLayer(page, alphaId); await selectLayer(controller, alphaId);
  await controller.getByRole('button', { name: 'Animation preset library', exact: true }).click();
  await library(controller).waitFor();

  // Save the editor's un-applied custom document into the station library. A
  // library broadcast must not close/reset the editor or silently Apply it.
  await page.getByRole('button', { name: 'Open animation editor', exact: true }).click(); await editor.waitFor();
  await editor.getByLabel('Editor animation preset', { exact: true }).selectOption('custom');
  await fillNumber(editor, 'Editor animation duration', 1250); await fillNumber(editor, 'Editor animation delay', 175);
  await editor.getByLabel('Editor animation easing', { exact: true }).selectOption('ease-in-out');
  await editor.getByRole('button', { name: 'Keyframe 1', exact: true }).click();
  for (const [name, value] of Object.entries({ X: -240, Y: 80, scale: 85, opacity: 15, rotation: -12 })) await fillNumber(editor, `Keyframe ${name}`, value);
  await editor.getByRole('button', { name: 'Add keyframe', exact: true }).click();
  await fillNumber(editor, 'Keyframe time', 50);
  for (const [name, value] of Object.entries({ X: -80, Y: 25, scale: 95, opacity: 70, rotation: -3 })) await fillNumber(editor, `Keyframe ${name}`, value);
  const beforeSave = await get();
  await editor.getByRole('button', { name: 'Save animation preset', exact: true }).click();
  await editor.getByLabel('Preset name', { exact: true }).fill(`  ${presetName}  `);
  await editor.getByRole('button', { name: 'Save preset', exact: true }).click();
  const savedPreset = await until(async () => (await get()).animationPresets?.find(value => value.name === presetName), 'custom preset saved');
  assert.deepEqual(savedPreset.animation, expectedAnimation, 'Library saves all custom frames, timing and easing from the editor draft');
  const afterSave = await get();
  assert.equal(afterSave.revision, beforeSave.revision + 1, 'Saving to the library creates exactly one station revision');
  assert.deepEqual(afterSave.scenes, beforeSave.scenes, 'Save as preset does not Apply the unsaved editor animation');
  assert.ok(await editor.isVisible(), 'Library revision leaves the animation editor open');
  assert.equal(await editor.getByLabel('Editor animation duration', { exact: true }).inputValue(), '1250', 'Library broadcast preserves the editor draft');
  await until(() => library(controller).getByRole('button', { name: `Select preset ${presetName}`, exact: true }).isVisible(), 'second controller receives shared library over WebSocket');
  await page.screenshot({ path: path.join(dir, 'presets-editor-desktop.png'), fullPage: true });
  await unchangedAir('Saving an unsaved custom preset');
  await fillNumber(editor, 'Editor animation duration', 2000);
  await editor.getByRole('button', { name: 'Open preset library', exact: true }).click();
  await editor.getByRole('button', { name: `Select preset ${presetName}`, exact: true }).click();
  const beforePreview = (await get()).revision;
  await editor.getByRole('button', { name: 'Play preset preview', exact: true }).click();
  await page.waitForTimeout(160);
  await editor.getByLabel('Preset preview playhead', { exact: true }).evaluate(input => {
    input.value = String(Number(input.max) / 2); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal((await get()).revision, beforePreview, 'Reusable preset playback and scrubbing are local, not document edits');
  await editor.getByRole('button', { name: 'Apply preset', exact: true }).click();
  assert.equal(await editor.getByLabel('Editor animation duration', { exact: true }).inputValue(), '1250', 'Embedded library applies the preset into the editor draft');
  assert.equal((await get()).revision, beforePreview, 'Applying from the embedded library does not publish the unsaved editor draft');
  assert.deepEqual((await currentLayer(alphaId)).animation, originalAnimation);
  await editor.getByRole('button', { name: 'Cancel animation changes', exact: true }).click();
  assert.deepEqual((await currentLayer(alphaId)).animation, originalAnimation, 'Cancel still discards layer edits after saving a reusable preset');
  checks.push('unsaved editor saves to shared station library without Apply; embedded library playback/scrub and application stay local to the editor draft');

  await closeLibrary(controller);
  await selectLayer(page, betaId);
  const betaLayout = withoutAnimation(await currentLayer(betaId));
  await page.getByRole('button', { name: 'Animation preset library', exact: true }).click(); await library(page).waitFor();
  await library(page).getByLabel('Search animation presets', { exact: true }).fill('sermon');
  await library(page).getByRole('button', { name: `Select preset ${presetName}`, exact: true }).click();
  await page.screenshot({ path: path.join(dir, 'presets-library-desktop.png'), fullPage: true });
  await library(page).getByRole('button', { name: 'Apply preset', exact: true }).click();
  await until(async () => (await currentLayer(betaId)).animation?.durationMs === 1250, 'library applies copied animation to another layer');
  assert.deepEqual((await currentLayer(betaId)).animation, expectedAnimation);
  assert.deepEqual(withoutAnimation(await currentLayer(betaId)), betaLayout, 'Applying motion never moves, resizes, restyles or renames the destination');
  await closeLibrary(page);
  await page.locator('.scene-card').filter({ hasText: 'Preset destination scene' }).click(); await selectLayer(page, gammaId);
  const gammaLayout = withoutAnimation(await currentLayer(gammaId, secondSceneId));
  await page.getByLabel('Animation preset', { exact: true }).selectOption(`saved:${savedPreset.id}`);
  await until(async () => (await currentLayer(gammaId, secondSceneId)).animation?.durationMs === 1250, 'saved-preset quick select applies across scenes');
  assert.deepEqual((await currentLayer(gammaId, secondSceneId)).animation, expectedAnimation);
  assert.deepEqual(withoutAnimation(await currentLayer(gammaId, secondSceneId)), gammaLayout);
  await unchangedAir('Applying saved presets across layers and scenes');
  checks.push('library and quick-select application copy all animation values across layers/scenes without touching geometry or live snapshots');

  await page.locator('.scene-card').filter({ hasText: 'Preset source scene' }).click(); await selectLayer(page, betaId);
  await fillNumber(page, 'Animation duration', 900);
  await until(async () => (await currentLayer(betaId)).animation?.durationMs === 900, 'applied copy can be independently edited');
  assert.deepEqual((await get()).animationPresets.find(value => value.id === savedPreset.id).animation, expectedAnimation, 'Editing an applied copy cannot mutate its source preset');
  assert.deepEqual((await currentLayer(gammaId, secondSceneId)).animation, expectedAnimation, 'Editing one copy leaves other destinations unchanged');
  const editedAnimation = (await currentLayer(betaId)).animation;
  await page.getByLabel('Animation preset', { exact: true }).selectOption('none');
  await until(async () => (await currentLayer(betaId)).animation?.enabled === false, 'disable applied custom animation');
  await page.getByLabel('Animation preset', { exact: true }).selectOption('custom');
  await until(async () => (await currentLayer(betaId)).animation?.enabled === true, 'restore applied custom animation');
  assert.deepEqual((await currentLayer(betaId)).animation, editedAnimation);
  assert.equal(await editor.count(), 0, 'Restoring a disabled custom preset does not unexpectedly open the editor');
  await unchangedAir('Editing and disabling applied copies');
  checks.push('applied copies are independent of library/other layers; None and restore preserve custom motion');

  // Older controllers omit the new library. Even a newer controller cannot
  // replace or inject presets through an unrelated whole-document save.
  await save(state => { delete state.animationPresets; });
  assert.deepEqual((await get()).animationPresets, [savedPreset], 'A legacy PUT cannot wipe the library');
  await save(state => { state.animationPresets = [{ ...savedPreset, id: 'injected_preset', name: 'Client injection' }]; });
  assert.deepEqual((await get()).animationPresets, [savedPreset], 'PUT cannot inject or replace command-owned presets');
  const beforeDuplicate = await get();
  const duplicate = await request.post(`${base}/api/studio/command`, { data: { revision: beforeDuplicate.revision, command: {
    type: 'save-animation-preset', name: '  ＳＥＲＭＯＮ ＷＥＬＣＯＭＥ  ', animation: expectedAnimation,
  } } });
  assert.ok([400, 409].includes(duplicate.status()), `Duplicate normalized names are rejected: ${duplicate.status()} ${await duplicate.text()}`);
  assert.equal((await get()).revision, beforeDuplicate.revision, 'Rejected duplicate cannot save a revision');
  checks.push('legacy/malicious document PUTs cannot alter the command-owned library; normalized duplicate names are rejected atomically');

  const reservedState = await command({ type: 'save-animation-preset', name: 'Reserved entrance', animation: expectedAnimation });
  const reservedPreset = reservedState.animationPresets.find(value => value.name === 'Reserved entrance');
  await page.getByRole('button', { name: 'Animation preset library', exact: true }).click(); await library(page).waitFor();
  await library(page).getByRole('button', { name: `Select preset ${presetName}`, exact: true }).click();
  const scrub = async value => {
    await library(page).getByLabel('Preset preview playhead', { exact: true }).evaluate((input, time) => {
      input.value = String(time); input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  };
  await scrub(625);
  await library(page).getByRole('button', { name: 'Rename preset', exact: true }).click();
  await library(page).getByLabel('New preset name', { exact: true }).fill('Reserved entrance');
  await save(state => { state.scenes.find(scene => scene.id === 'scene_welcome').name = 'Welcome revision one'; });
  await until(() => page.locator('.scene-card').filter({ hasText: 'Welcome revision one' }).count(), 'unrelated revision arrives while renaming');
  assert.equal(await library(page).getByLabel('New preset name', { exact: true }).inputValue(), 'Reserved entrance', 'Unrelated revisions cannot close or reset an active rename form');
  assert.equal(await library(page).getByLabel('Preset preview playhead', { exact: true }).inputValue(), '625', 'Unrelated revisions do not reset a scrubbed preset preview');
  const beforeDuplicateRename = (await get()).revision;
  await library(page).getByRole('button', { name: 'Save preset name', exact: true }).click();
  await library(page).getByRole('alert').waitFor();
  assert.equal((await get()).revision, beforeDuplicateRename, 'Rejected duplicate rename does not save a revision');
  assert.equal(await library(page).getByLabel('New preset name', { exact: true }).inputValue(), 'Reserved entrance', 'Failure reload retains the current rename form and input');
  assert.equal(await library(page).getByLabel('Preset preview playhead', { exact: true }).inputValue(), '625', 'Failure reload retains the scrubbed preview');
  const renameError = await library(page).getByRole('alert').textContent();
  await save(state => { state.scenes.find(scene => scene.id === 'scene_welcome').name = 'Welcome revision two'; });
  await until(() => page.locator('.scene-card').filter({ hasText: 'Welcome revision two' }).count(), 'unrelated revision arrives after rename failure');
  assert.equal(await library(page).getByRole('alert').textContent(), renameError, 'Unrelated revisions cannot erase the current rename validation error');
  assert.equal(await library(page).getByLabel('New preset name', { exact: true }).inputValue(), 'Reserved entrance');
  await command({ type: 'delete-animation-preset', presetId: reservedPreset.id });
  await until(async () => await library(page).getByRole('button', { name: 'Select preset Reserved entrance', exact: true }).count() === 0, 'temporary duplicate fixture removed in controller');
  await library(page).getByLabel('New preset name', { exact: true }).fill(renamedPresetName);
  assert.equal(await library(page).getByRole('alert').count(), 0, 'Editing a rejected name clears stale inline feedback');
  await library(page).getByRole('button', { name: 'Save preset name', exact: true }).click();
  const renamed = await until(async () => (await get()).animationPresets.find(value => value.name === renamedPresetName), 'preset renamed');
  assert.equal(renamed.id, savedPreset.id); assert.equal(renamed.createdAt, savedPreset.createdAt); assert.deepEqual(renamed.animation, expectedAnimation);
  await scrub(675);
  await library(page).getByRole('button', { name: 'Delete preset', exact: true }).click();
  await save(state => { state.scenes.find(scene => scene.id === 'scene_welcome').name = 'Welcome revision three'; });
  await until(() => page.locator('.scene-card').filter({ hasText: 'Welcome revision three' }).count(), 'unrelated revision arrives during delete confirmation');
  assert.ok(await library(page).getByRole('button', { name: 'Confirm delete preset', exact: true }).isVisible(), 'Unrelated revisions cannot dismiss a delete confirmation');
  assert.equal(await library(page).getByLabel('Preset preview playhead', { exact: true }).inputValue(), '675', 'Delete confirmation keeps the scrubbed preview stable');
  await library(page).getByRole('button', { name: 'Cancel delete preset', exact: true }).click();
  checks.push('unrelated revisions and failed duplicate-rename reload preserve scrubbed previews, rename forms/errors and delete confirmations');
  await unchangedAir('Renaming library motion');
  await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => { const bounds = await library(page).boundingBox(); return bounds.x >= 0 && bounds.x + bounds.width <= 390; }, 'preset library fits narrow viewport');
  await library(page).getByRole('button', { name: 'Apply preset', exact: true }).click({ trial: true });
  await page.screenshot({ path: path.join(dir, 'presets-library-mobile.png'), fullPage: true });
  await closeLibrary(page); await page.setViewportSize({ width: 1728, height: 1117 });
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio' }).waitFor(); await selectLayer(page, betaId);
  assert.ok(await page.getByLabel('Animation preset', { exact: true }).locator(`option[value="saved:${savedPreset.id}"]`).count(), 'Saved presets survive browser reload');
  await stopServer(); server = startServer();
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station restart', 30000); await login();
  assert.deepEqual((await get()).animationPresets, [renamed], 'Saved preset metadata and complete motion persist through backend restart');
  await openStudio(page); await selectLayer(page, betaId);
  await unchangedAir('Browser and backend restart');
  checks.push('rename, responsive library controls, browser reload and backend restart retain complete station presets');

  // Lock protects the destination even when reusable motion is available.
  await page.getByRole('button', { name: 'Lock layer', exact: true }).click();
  await until(async () => (await currentLayer(betaId)).locked, 'destination locked');
  const lockedLayer = await currentLayer(betaId), lockedRevision = (await get()).revision;
  assert.ok(await page.getByLabel('Animation preset', { exact: true }).isDisabled(), 'Locked layer quick-select is disabled');
  assert.ok(await page.getByRole('button', { name: 'Open animation editor', exact: true }).isDisabled(), 'Locked layer cannot edit animation');
  await page.getByRole('button', { name: 'Animation preset library', exact: true }).click(); await library(page).waitFor();
  await library(page).getByRole('button', { name: `Select preset ${renamedPresetName}`, exact: true }).click();
  assert.ok(await library(page).getByRole('button', { name: 'Apply preset', exact: true }).isDisabled(), 'Library remains available to manage presets but cannot apply to a locked destination');
  await closeLibrary(page);
  assert.deepEqual(await currentLayer(betaId), lockedLayer); assert.equal((await get()).revision, lockedRevision);
  await page.getByRole('button', { name: 'Unlock layer', exact: true }).click(); await until(async () => !(await currentLayer(betaId)).locked, 'destination unlocked');
  await page.getByRole('button', { name: 'Open animation editor', exact: true }).click(); await editor.waitFor();
  await editor.getByRole('button', { name: 'Save animation preset', exact: true }).click();
  await editor.getByLabel('Preset name', { exact: true }).fill('   ');
  assert.ok(await editor.getByRole('button', { name: 'Save preset', exact: true }).isDisabled(), 'Blank preset name cannot be submitted');
  await editor.getByLabel('Preset name', { exact: true }).fill(`  ${renamedPresetName.toUpperCase()} `);
  const beforeDuplicateUI = (await get()).revision;
  if (!await editor.getByRole('button', { name: 'Save preset', exact: true }).isDisabled()) {
    await editor.getByRole('button', { name: 'Save preset', exact: true }).click();
    await editor.getByRole('alert').waitFor();
    assert.ok(await editor.getByLabel('Preset name', { exact: true }).isVisible(), 'Duplicate-name failure leaves the Save form open');
  }
  assert.equal((await get()).revision, beforeDuplicateUI, 'Duplicate-name validation does not save a document revision');
  await editor.getByLabel('Preset name', { exact: true }).fill('Another entrance');
  assert.equal(await editor.getByRole('alert').count(), 0, 'Editing the name clears the old Save error');
  await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => { const bounds = await editor.boundingBox(); return bounds.x >= 0 && bounds.x + bounds.width <= 390; }, 'editor Save as preset fits narrow viewport');
  await editor.getByRole('button', { name: 'Save preset', exact: true }).click({ trial: true });
  await page.screenshot({ path: path.join(dir, 'presets-save-mobile.png'), fullPage: true });
  await editor.getByRole('button', { name: 'Cancel save preset', exact: true }).click();
  await editor.getByRole('button', { name: 'Cancel animation changes', exact: true }).click();
  await page.setViewportSize({ width: 1728, height: 1117 });
  const copiesBeforeDelete = (await get()).scenes;
  await page.getByRole('button', { name: 'Animation preset library', exact: true }).click(); await library(page).waitFor();
  await library(page).getByRole('button', { name: `Select preset ${renamedPresetName}`, exact: true }).click();
  await library(page).getByRole('button', { name: 'Delete preset', exact: true }).click();
  await library(page).getByRole('button', { name: 'Confirm delete preset', exact: true }).click();
  await until(async () => (await get()).animationPresets.length === 0, 'preset removed from library');
  assert.deepEqual((await get()).scenes, copiesBeforeDelete, 'Deleting a preset leaves existing applied animations intact');
  await unchangedAir('Deleting library motion');
  await closeLibrary(page); await page.getByRole('button', { name: 'Open animation editor', exact: true }).click();
  assert.equal(await editor.getByLabel('Editor animation duration', { exact: true }).inputValue(), '900', 'Applied motion remains editable after its library item is deleted');
  await editor.getByRole('button', { name: 'Cancel animation changes', exact: true }).click();
  checks.push('locked destinations, inline blank/duplicate-name validation, responsive Save form and non-destructive preset deletion');
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'presets-failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close(); await stopServer();
}
