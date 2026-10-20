// Run after npm run build. The server, users and scenes below belong entirely
// to a temporary station; this suite never contacts an operator's station.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-workspace-design-'));
const port = Number(process.env.LUMEN_DESIGN_TEST_PORT ?? 3421), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page, request;
const errors = [], checks = [];
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
async function until(fn, label, timeout = 15000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const layer = (id, name, patch = {}) => ({ id, name, kind: 'text', visible: true, locked: false,
  x: 8, y: 32, width: 84, height: 25, opacity: 1, fit: 'contain', text: '',
  color: '#f5f4ef', background: '#00000000', fontSize: 92, fontWeight: 500, align: 'center', radius: 0, ...patch });

try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'temporary station start', 30000);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } }); request = context.request;
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/studio`);
  await page.getByRole('heading', { name: 'Sign in to your station', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.getByRole('button', { name: 'Sign in', exact: true }).isDisabled(), 'Empty login cannot be submitted');
  await page.screenshot({ path: path.join(dir, 'login-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Login stays in the mobile viewport');
  await page.screenshot({ path: path.join(dir, 'login-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByLabel('Username', { exact: true }).fill('admin');
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('not-the-password');
  assert.equal(await password.getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  assert.equal(await password.getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  assert.equal(await password.getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Invalid username or password.' }).waitFor();
  assert.ok(await page.getByRole('heading', { name: 'Sign in to your station', exact: true }).isVisible(), 'A rejected login stays on the form');
  await password.fill('admin');
  await password.press('Enter');
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  checks.push('accessible sign-in, password visibility, rejected credentials, keyboard submit and mobile login');

  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const state = await get();
  state.scenes = [
    { id: 'design_welcome', name: 'Sunday service', background: '#19302f', layers: [
      layer('design_eyebrow', 'Service label', { text: 'SUNDAY GATHERING', y: 21, height: 8, fontSize: 24, color: '#b5d4c4' }),
      layer('design_title', 'Welcome title', { text: 'A place to belong.', y: 35, height: 20, fontSize: 110 }),
      layer('design_subtitle', 'Welcome subtitle', { text: 'Welcome. We are glad you are here.', y: 65, height: 10, fontSize: 30, color: '#c2cfca' }),
      layer('design_line', 'Accent rule', { kind: 'shape', x: 46, y: 81, width: 8, height: 1, background: '#b5d4c4' }),
    ] },
    { id: 'design_message', name: 'The message', background: '#1c232b', layers: [
      layer('design_message_label', 'Message label', { text: 'THIS WEEK’S MESSAGE', y: 26, height: 8, fontSize: 24, color: '#9fb8c6' }),
      layer('design_message_title', 'Message title', { text: 'Faith for the everyday.', y: 37, height: 22, fontSize: 100 }),
      layer('design_message_speaker', 'Speaker', { text: 'Pastor Daniel · Sunday service', y: 66, height: 10, fontSize: 30, color: '#b1bdc7' }),
    ] },
    { id: 'design_closing', name: 'See you next week', background: '#302b25', layers: [
      layer('design_closing_title', 'Closing title', { text: 'Go with hope.', y: 37, height: 22, fontSize: 110 }),
      layer('design_closing_subtitle', 'Closing subtitle', { text: 'Thank you for being part of today.', y: 66, height: 10, fontSize: 30, color: '#c7bbab' }),
    ] },
  ];
  state.previewSceneId = 'design_message';
  const saved = await request.put(`${base}/api/studio`, { data: state });
  assert.equal(saved.status(), 200, await saved.text());
  const committedResponse = await request.post(`${base}/api/studio/command`, { data: { revision: (await get()).revision, command: { type: 'take', sceneId: 'design_welcome' } } });
  assert.equal(committedResponse.status(), 200, await committedResponse.text());
  const committed = await get();
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  await until(async () => await page.locator('.scene-card').count() === 3, 'fixture scene browser');
  const beforePreferences = await get();
  const search = page.getByRole('textbox', { name: 'Find a scene', exact: true });
  await search.fill('MESSAGE');
  await until(async () => await page.locator('.scene-card').count() === 1, 'case-insensitive scene search');
  assert.ok(await page.locator('.scene-card').filter({ hasText: 'The message' }).isVisible());
  await search.fill('A missing scene');
  await page.getByText('No matching scenes', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear scene search', exact: true }).click();
  await until(async () => await page.locator('.scene-card').count() === 3, 'clear search restores all scenes');
  await page.getByRole('button', { name: 'Show compact scene list', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Show compact scene list', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('.scene-list').evaluate(element => element.classList.contains('is-compact')));
  await page.reload(); await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Show compact scene list', exact: true }).getAttribute('aria-pressed'), 'true', 'Scene density persists after reload');
  assert.equal((await get()).revision, beforePreferences.revision, 'Search, clear, density and reload never save a production revision');
  await page.getByRole('button', { name: 'Show scene thumbnails', exact: true }).click();
  assert.deepEqual((await get()).program, committed.program, 'Scene browser preferences do not publish Program');
  assert.deepEqual((await get()).outputs, committed.outputs, 'Scene browser preferences do not change any outputs');
  checks.push('case-insensitive scene search, empty results, clear, compact/thumbnail view and local persistence with no production writes');

  // A local shape/text fixture gives both monitors a real rendered picture,
  // without opening a camera, screen share, microphone or external media.
  const start = await request.post(`${base}/api/studio/engine/start`);
  assert.equal(start.status(), 200, await start.text());
  await until(async () => (await (await request.get(`${base}/api/studio/status`)).json()).state === 'running', 'temporary renderer running', 30000);
  await page.locator('.program-badge').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('.layer-row').filter({ hasText: 'Message title' }).click();
  const selectedName = page.locator('[data-inspector-layer-name]');
  await selectedName.waitFor();
  for (const [width, height] of [[1728, 1117], [1366, 900], [1024, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    if (width <= 1050 && await page.getByRole('button', { name: 'Collapse inspector', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
    }
    await page.locator('.studio-workspace').evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(180);
    const headerLiveView = page.locator('.lumen-header').getByRole('button', { name: 'Open Live View', exact: true });
    assert.equal(await page.getByRole('button', { name: 'Open Live View', exact: true }).count(), 1, `One consistent live-view button at ${width}px`);
    await headerLiveView.click({ trial: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal viewport overflow at ${width}px`);
    const sidebar = await page.getByRole('complementary', { name: 'Scenes', exact: true }).boundingBox();
    assert.ok(sidebar.x >= 0 && sidebar.x + sidebar.width <= width, `Scene browser remains inside ${width}px viewport`);
    await page.screenshot({ path: path.join(dir, `studio-${width}.png`), fullPage: true });
  }
  checks.push('real rendered Studio at 1728px, 1366px, 1024px and 390px, bounded sidebar and single accessible live-view action');

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const touchPage = await touch.newPage(); touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.goto(`${base}/studio`); await touchPage.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  assert.ok(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Coarse touch controls do not cause mobile horizontal overflow');
  await touchPage.locator('.lumen-header').getByRole('button', { name: 'Open Live View', exact: true }).click({ trial: true });
  await touchPage.screenshot({ path: path.join(dir, 'studio-mobile-touch.png'), fullPage: true });
  await touch.close();
  const finalState = await get();
  assert.equal(finalState.revision, beforePreferences.revision, 'Renderer startup and responsive/local interactions never save a revision');
  assert.deepEqual(finalState.program, committed.program);
  assert.deepEqual(finalState.outputs, committed.outputs);
  assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('\n')}`);
  checks.push('touch-device controls and live state isolation throughout visual checks');
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'workspace-design-failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await request?.post(`${base}/api/studio/engine/stop`).catch(() => {});
  await browser?.close();
  if (server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 6000))]);
  }
}
