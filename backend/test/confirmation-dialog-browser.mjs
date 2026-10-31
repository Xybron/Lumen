// Isolated UI confirmation checks. Never starts the real engine, accesses an
// input, or touches the operator's data; every mutation uses a temporary station.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-confirmation-dialog-'));
const port = Number(process.env.LUMEN_CONFIRMATION_TEST_PORT ?? 3451), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page;
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
const checks = [], errors = [], nativeDialogs = [], studioTakes = [];
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station start', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const request = context.request;
  const login = await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } });
  assert.equal(login.status(), 200, await login.text());
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const save = async mutate => {
    const state = await get(); mutate(state);
    const response = await request.put(`${base}/api/studio`, { data: state });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  await save(state => {
    state.scenes.push({ id: 'confirm_scene', name: 'Confirmation rehearsal', background: '#17191c', layers: [] });
    state.previewSceneId = 'confirm_scene';
    state.sources.push({ id: 'confirm_source', name: 'Rehearsal input', kind: 'microphone', loop: false,
      audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } });
    state.outputs.push({ id: 'confirm_output', name: 'Rehearsal screen', mode: 'program', scene: null, blanked: false, audioEnabled: false });
  });
  const agentResponse = await request.post(`${base}/api/agents`, { data: { name: 'Rehearsal capture' } });
  assert.equal(agentResponse.status(), 200, await agentResponse.text());
  const agent = await agentResponse.json();
  const agents = async () => (await (await request.get(`${base}/api/agents`)).json()).agents;
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`); void dialog.dismiss(); });
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/studio/command') && request.postDataJSON()?.command?.type === 'take') studioTakes.push(request);
  });
  await page.goto(`${base}/studio`);
  await page.getByRole('heading', { name: 'Production Studio' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const dialog = title => page.getByRole('dialog', { name: title, exact: true });
  const focusIs = locator => locator.evaluate(element => element === document.activeElement);
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const dismissVia = async (title, action) => {
    const modal = dialog(title); await modal.waitFor(); await settled();
    const revision = (await get()).revision, takes = studioTakes.length;
    await action(modal); await modal.waitFor({ state: 'hidden' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await get()).revision, revision, 'Cancelling a confirmation must not edit Studio');
    assert.equal(studioTakes.length, takes, 'Dialog keyboard input must not Cut or Fade underneath');
  };

  const sceneTrigger = page.getByRole('button', { name: 'Delete scene', exact: true });
  await sceneTrigger.click();
  await dialog('Delete scene?').waitFor();
  await until(() => focusIs(dialog('Delete scene?').getByRole('button', { name: 'Cancel', exact: true })), 'Cancel receives safe initial focus');
  assert.ok((await dialog('Delete scene?').textContent()).includes('Confirmation rehearsal'));
  await dismissVia('Delete scene?', async () => page.keyboard.press('Enter'));
  await until(() => focusIs(sceneTrigger), 'scene trigger focus restored after Enter cancels');
  assert.ok((await get()).scenes.some(scene => scene.id === 'confirm_scene'));
  await sceneTrigger.click();
  await dismissVia('Delete scene?', async () => page.keyboard.press('Escape'));
  await until(() => focusIs(sceneTrigger), 'scene trigger focus restored after Escape');
  await sceneTrigger.click();
  await dismissVia('Delete scene?', async () => page.mouse.click(8, 8));
  await until(() => focusIs(sceneTrigger), 'scene trigger focus restored after outside dismissal');
  checks.push('scene confirmation uses app dialog, names target, defaults to Cancel, restores focus, and supports Enter/Escape/outside cancellation');

  await sceneTrigger.click();
  await dialog('Delete scene?').getByRole('button', { name: 'Delete scene', exact: true }).click();
  await dialog('Delete scene?').waitFor({ state: 'hidden' });
  await until(async () => !(await get()).scenes.some(scene => scene.id === 'confirm_scene'), 'confirmed scene removal');
  const sourceTrigger = page.getByRole('button', { name: 'Remove Rehearsal input', exact: true });
  await sourceTrigger.click();
  await dismissVia('Remove source?', modal => modal.getByRole('button', { name: 'Cancel', exact: true }).click());
  await until(() => focusIs(sourceTrigger), 'source trigger focus restored');
  await sourceTrigger.click();
  await dialog('Remove source?').getByRole('button', { name: 'Remove source', exact: true }).click();
  await until(async () => !(await get()).sources.some(source => source.id === 'confirm_source'), 'confirmed source removal');
  const outputTrigger = page.getByRole('button', { name: 'Remove Rehearsal screen', exact: true });
  await outputTrigger.click();
  await dismissVia('Remove output?', modal => modal.getByRole('button', { name: 'Cancel', exact: true }).click());
  await outputTrigger.click();
  await dialog('Remove output?').getByRole('button', { name: 'Remove output', exact: true }).click();
  await until(async () => !(await get()).outputs.some(output => output.id === 'confirm_output'), 'confirmed output removal');
  checks.push('source/output removal requires explicit action-specific confirmation; cancellation preserves state');

  const sourceForReset = { id: 'reset_source', name: 'Reset camera', kind: 'camera', loop: false,
    audio: { volume: 0.8, muted: true, mode: 'follow', delayMs: 0 } };
  const prepareResetScene = async () => {
    await save(state => {
      if (!state.sources.some(source => source.id === sourceForReset.id)) state.sources.push(sourceForReset);
      state.scenes = [{ id: 'reset_scene', name: 'Reset scene', background: '#000000', layers: [
        { id: 'reset_layer', name: 'Reset camera', kind: 'source', sourceId: sourceForReset.id, visible: true, locked: false,
          x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'cover', text: '', color: '#ffffff', background: '#00000000', fontSize: 48, fontWeight: 500, align: 'center', radius: 0 },
      ] }];
      state.previewSceneId = 'reset_scene';
    });
    const state = await get();
    const taken = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: { type: 'take', sceneId: 'reset_scene' } } });
    assert.equal(taken.status(), 200, await taken.text());
    await save(state => { state.scenes = []; state.previewSceneId = null; });
    await page.getByRole('button', { name: 'Clear Program', exact: true }).waitFor();
  };
  await prepareResetScene();
  await page.getByRole('button', { name: 'Clear Program', exact: true }).click();
  const clearDialog = dialog('Clear Program?'); await clearDialog.waitFor();
  await dismissVia('Clear Program?', modal => modal.getByRole('button', { name: 'Cancel', exact: true }).click());
  assert.ok((await get()).program, 'Cancelling leaves Program visible');
  await page.getByRole('button', { name: 'Clear Program', exact: true }).click();
  await clearDialog.getByRole('button', { name: 'Clear Program', exact: true }).click();
  await until(async () => !(await get()).program, 'Program cleared without a draft scene');
  assert.ok((await get()).sources.some(source => source.id === sourceForReset.id), 'Clearing Program retains the reusable source');
  await prepareResetScene();
  await page.getByRole('button', { name: 'Remove Reset camera', exact: true }).click();
  const liveSourceDialog = dialog('Remove source from output?'); await liveSourceDialog.waitFor();
  assert.match(await liveSourceDialog.textContent(), /including Program/);
  await liveSourceDialog.getByRole('button', { name: 'Remove source', exact: true }).click();
  await until(async () => { const state = await get(); return !state.sources.some(source => source.id === sourceForReset.id) && !state.program; }, 'source and final live picture removed together');
  checks.push('empty draft scenes explain why Program stays live; clearing Program and removing a live source both use explicit confirmation');

  await page.getByRole('button', { name: /^Account menu for / }).click();
  await page.getByRole('menuitem', { name: 'Capture agents', exact: true }).click();
  const manager = dialog('Capture agents'); await manager.waitFor();
  const agentTrigger = manager.getByRole('button', { name: 'Remove Rehearsal capture', exact: true });
  await agentTrigger.click();
  const nested = dialog('Remove capture agent?'); await nested.waitFor();
  assert.equal(await page.getByRole('dialog', { includeHidden: true }).count(), 2, 'Confirmation layers above the still-mounted manager');
  assert.equal(await page.getByRole('dialog').count(), 1, 'Only the top confirmation remains exposed to accessibility tools');
  await until(() => focusIs(nested.getByRole('button', { name: 'Cancel', exact: true })), 'nested confirmation Cancel focus');
  await page.keyboard.press('Escape');
  await nested.waitFor({ state: 'hidden' });
  assert.ok(await manager.isVisible(), 'Escape closes confirmation only, not its originating manager');
  await until(() => focusIs(agentTrigger), 'nested confirmation restores focus into parent dialog');
  assert.ok((await agents()).some(item => item.agentId === agent.agentId));
  await agentTrigger.click();
  await nested.waitFor();
  await settled();
  await page.mouse.click(8, 8);
  await nested.waitFor({ state: 'hidden' });
  assert.ok(await manager.isVisible(), 'Outside confirmation dismissal keeps originating manager open');
  await agentTrigger.click();
  await nested.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await until(async () => !(await agents()).some(item => item.agentId === agent.agentId), 'confirmed capture agent removal');
  assert.ok(await manager.isVisible(), 'Confirmed removal returns to Capture agents');
  await page.screenshot({ path: path.join(dir, 'capture-agents.png') });
  await page.keyboard.press('Escape'); await manager.waitFor({ state: 'hidden' });
  checks.push('nested capture-agent confirmation traps focus above parent, Escape/outside close only confirmation, explicit removal returns to manager');

  await page.getByRole('button', { name: /^Account menu for / }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  const signout = dialog('Sign out?'); await signout.waitFor();
  await page.screenshot({ path: path.join(dir, 'confirmation-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(dir, 'confirmation-mobile.png') });
  const bounds = await signout.boundingBox();
  assert.ok(bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= 382 && bounds.y + bounds.height <= 836, 'Confirmation fits the narrow viewport');
  await page.keyboard.press('Escape'); await signout.waitFor({ state: 'hidden' });
  const me = await request.get(`${base}/api/auth/me`); assert.equal(me.status(), 200);
  checks.push('account-menu confirmation survives menu closure, remains responsive and cancels without sign-out');
  assert.deepEqual(nativeDialogs, [], 'No confirmation should use browser-native dialogs');
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  assert.equal(studioTakes.length, 0, 'No confirmation or dismissal keyboard action may switch Program');
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
}
