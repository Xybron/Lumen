// Dock interaction checks use a disposable station, with no operator data or inputs.
// Run after npm run build: node backend/test/dock-interaction-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-dock-interaction-'));
const port = Number(process.env.LUMEN_DOCK_TEST_PORT ?? 3498), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
const names = ['Add channel', 'Open Production Studio', 'Open Multiview', 'Open Recordings and Clips', 'Open Media library', 'Pending media'];
let server, browser, page, logs = '';
const errors = [], checks = [];
async function until(operation, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await operation(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function json(response, status = 200) { assert.equal(response.status(), status, await response.text()); return response.json(); }
async function stop() {
  const child = server; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 6000).unref(); });
}
function control(name, target = page) { return target.locator('.dock-utility').and(target.getByLabel(name, { exact: true })); }
async function measure(target) {
  return target.evaluate(element => {
    const bounds = element.getBoundingClientRect(), label = element.querySelector('.dock-tool-label'), icon = element.querySelector('.dock-tool-icon');
    const style = getComputedStyle(label);
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, opacity: Number(style.opacity), maxWidth: parseFloat(style.maxWidth),
      focusVisible: element.matches(':focus-visible'), duration: style.transitionDuration.split(',').map(value => parseFloat(value)), iconTransform: getComputedStyle(icon).transform };
  });
}
async function idle(target = page) { await target.mouse.move(2, 2); await target.locator('body').click({ position: { x: 2, y: 2 } }); }
async function labelState(target, visible) { await until(async () => { const state = await measure(target); return visible ? state.opacity === 1 && state.maxWidth > 0 : state.opacity === 0 && state.maxWidth === 0; }, visible ? 'label revealed' : 'label collapsed'); }
async function insideDock(target) {
  return target.evaluate(element => {
    const button = element.getBoundingClientRect(), viewport = element.closest('.dock-items').getBoundingClientRect();
    return button.left >= viewport.left - 1 && button.right <= viewport.right + 1;
  });
}

try {
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...environment, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base, LUMEN_CHROME_PATH: executablePath }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station starts');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(15000);
  const request = context.request;
  await json(await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }));
  const content = await json(await request.put(`${base}/api/content`, { data: {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [{ id: 'dock_channel', name: 'Sunday slides', kind: 'presentation', playlistId: 'dock_playlist', defaultMode: 'manual' }],
    playlists: [{ id: 'dock_playlist', name: 'Sunday slides', items: [{ id: 'dock_slide', type: 'text', title: 'Welcome', body: 'Welcome' }] }],
    sources: [], destinations: [], routes: [], program: { programSourceId: null, previewSourceId: null },
  } }));
  const studio = await json(await request.get(`${base}/api/studio`));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const channel = page.getByRole('button', { name: 'Sunday slides — presentation', exact: true });
  await channel.waitFor(); await idle();
  assert.equal(await page.locator('.dock-utility').count(), names.length);
  for (const name of names) {
    const target = control(name); await labelState(target, false);
    const initial = await measure(target);
    assert.ok(initial.width >= 38 && initial.width <= 39, `${name}: consistent idle target`);
    const pointer = { x: initial.x + initial.width / 2, y: initial.y + initial.height / 2 };
    await page.mouse.move(pointer.x, pointer.y); await labelState(target, true);
    const expanded = await measure(target);
    assert.ok(expanded.width > initial.width + 20, `${name}: expands to show its label`);
    assert.ok(pointer.x >= expanded.x && pointer.x <= expanded.x + expanded.width, `${name}: keeps original pointer inside its target`);
    await idle(); await labelState(target, false);
  }
  assert.equal(await channel.getByText('Sunday slides', { exact: true }).isVisible(), true);
  checks.push('Every utility is icon-only at rest, reveals on hover, retains its hit area, and retracts; channel names stay visible');

  await control('Add channel').focus(); await page.keyboard.press('Tab');
  const studioControl = control('Open Production Studio');
  assert.equal(await studioControl.evaluate(element => element === document.activeElement), true);
  await labelState(studioControl, true);
  assert.equal((await measure(studioControl)).focusVisible, true);
  await idle();
  await control('Add channel').click();
  await until(() => control('Add channel').getAttribute('data-state').then(value => value === 'open'), 'Add menu open');
  await page.mouse.move(2, 2); await labelState(control('Add channel'), true);
  await page.keyboard.press('Escape'); await idle();
  await control('Pending media').click();
  await until(() => control('Pending media').getAttribute('aria-expanded').then(value => value === 'true'), 'Pending dialog open');
  await page.mouse.move(2, 2); await labelState(control('Pending media'), true);
  await page.keyboard.press('Escape'); await idle();
  checks.push('Keyboard focus and open utilities reveal labels while preserving accessible names');

  await control('Open Media library').click();
  await page.getByRole('heading', { name: 'Media library', exact: true }).waitFor(); await idle();
  assert.equal(await control('Open Media library').getAttribute('aria-current'), 'page');
  await labelState(control('Open Media library'), true); await labelState(control('Open Production Studio'), false);
  await page.getByRole('button', { name: 'Collapse toolbar', exact: true }).click();
  assert.equal(await page.locator('#channel-toolbar-items').isVisible(), false);
  assert.equal(await page.locator('.dock-summary').getByText('Media', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Expand toolbar', exact: true }).click();
  await idle(); await labelState(control('Open Media library'), true);
  await page.locator('.floating-dock').screenshot({ path: path.join(directory, 'dock-active.png') });
  checks.push('Current route retains its label and collapsed toolbar retains a clear Media summary');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await control('Open Production Studio').hover(); await labelState(control('Open Production Studio'), true);
  const reduced = await measure(control('Open Production Studio'));
  assert.ok(reduced.duration.every(value => value <= .00001), 'Reduced motion disables label animation');
  assert.equal(reduced.iconTransform, 'none', 'Reduced motion disables icon movement');
  checks.push('Reduced-motion users get immediate labels without icon movement');

  await page.emulateMedia({ reducedMotion: 'no-preference' }); await idle();
  // A narrow CSS viewport also represents a desktop window at increased zoom.
  await page.setViewportSize({ width: 480, height: 700 });
  await until(() => insideDock(control('Open Media library')), 'active utility stays visible in a narrow viewport');
  await control('Add channel').focus(); await page.keyboard.press('Tab');
  await labelState(control('Open Production Studio'), true);
  await until(() => insideDock(control('Open Production Studio')), 'keyboard label stays fully visible after expansion');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  checks.push('Narrow and zoomed layouts keep active and keyboard-focused utilities visible within the dock');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const mobile = await mobileContext.newPage(); mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(`${base}/media`); await mobile.getByRole('heading', { name: 'Media library', exact: true }).waitFor();
  for (const name of names) {
    const state = await measure(control(name, mobile));
    assert.ok(state.width >= 44 && state.height >= 44, `${name}: coarse pointer target at least 44px`);
    await labelState(control(name, mobile), name === 'Open Media library');
  }
  await until(() => insideDock(control('Open Media library', mobile)), 'active mobile utility visible');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal page overflow');
  assert.equal(await mobile.getByRole('button', { name: 'Sunday slides — presentation', exact: true }).getByText('Sunday slides', { exact: true }).isVisible(), true);
  await mobile.screenshot({ path: path.join(directory, 'mobile.png') });
  checks.push('Touch layout preserves 44px utility targets and active labels without page overflow');

  const after = await json(await request.get(`${base}/api/studio`));
  for (const key of ['program', 'programTransition', 'outputs', 'mainAudioSourceId', 'masterVolume', 'masterMuted', 'channelInsert']) assert.deepEqual(after[key], studio[key], `${key} remains unchanged`);
  const contentAfter = await json(await request.get(`${base}/api/content`));
  assert.deepEqual(contentAfter.program, content.program); assert.deepEqual(contentAfter.playlists, content.playlists);
  assert.deepEqual(errors, []);
  checks.push('No live program, routing, audio or presentation content changes');
  console.log(JSON.stringify({ result: 'PASS', directory, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(logs.slice(-5000)); console.error(`Dock artifacts: ${directory}`); throw error;
} finally { await browser?.close(); await stop(); }
