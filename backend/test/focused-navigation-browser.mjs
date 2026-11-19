// Disposable station only: verifies navigation, one shared Outputs panel and
// actual Program recording without cameras, microphones or external streams.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-focused-navigation-'));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-focused-navigation-report-'));
const port = Number(process.env.LUMEN_FOCUSED_NAVIGATION_TEST_PORT || 3503), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
await new Promise((resolve, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(port, '127.0.0.1', () => socket.close(resolve)); });
let server, browser, page, logs = '';
const errors = [];
async function until(check, label, timeout = 30000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { if (await check()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...environment, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base, LUMEN_CHROME_PATH: executablePath }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station ready');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = async url => (await request.get(`${base}/api/${url}`)).json();
  const fixture = { version: 2, updatedAt: new Date().toISOString(), settings: {}, music: { mode: 'off' },
    channels: [{ id: 'prayer', name: 'Prayer marathon', kind: 'presentation', playlistId: 'prayers', defaultMode: 'manual' },
      { id: 'scripture', name: 'Scripture', kind: 'scripture', playlistId: 'scriptures', defaultMode: 'manual' }],
    playlists: [{ id: 'prayers', name: 'Prayer marathon', items: [{ id: 'point_1', type: 'text', title: 'Prayer for the nation', body: 'Let justice roll on like a river.', durationMs: 120000 }] },
      { id: 'scriptures', name: 'Scripture', items: [] }],
    sources: [{ id: 'prayer_source', kind: 'channel', ref: 'prayer' }, { id: 'scripture_source', kind: 'channel', ref: 'scripture' }],
    destinations: [], routes: [], program: { programSourceId: 'prayer_source', previewSourceId: null } };
  const seeded = await request.put(`${base}/api/content`, { data: fixture });
  assert.equal(seeded.status(), 200, await seeded.text());
  const original = await get('studio');
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const header = () => page.locator('.lumen-header:visible');
  const toolbar = () => header().getByLabel('Shared Program controls', { exact: true });
  const outputs = () => page.getByRole('dialog', { name: 'Outputs', exact: true });
  const controls = async () => {
    for (const label of ['Open Outputs', 'Open Go Live controls', 'More Program controls'])
      assert.equal(await toolbar().getByRole('button', { name: label, exact: true }).isVisible(), true, label);
    assert.equal(await header().getByRole('button', { name: 'Set up Program screen', exact: true }).count(), 0, 'Screen setup is in the shared Outputs panel');
    assert.equal(await header().getByRole('button', { name: 'Open Lumen Share', exact: true }).count(), 0, 'Share setup is in the shared Outputs panel');
    assert.equal(await header().locator('.engine-indicator,.program-name').count(), 0, 'Header contains actions rather than production status');
    assert.doesNotMatch(await header().innerText(), /\b\d+(?:\.\d+)?\s*fps\b|\b\d{2}:\d{2}:\d{2}\b/i, 'FPS and elapsed clocks belong in the status bar');
  };
  const openOutputs = async () => {
    await toolbar().getByRole('button', { name: 'Open Outputs', exact: true }).click();
    await outputs().waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'Only one output configuration dialog is mounted');
    await outputs().getByRole('button', { name: 'Set up Program screen', exact: true }).waitFor();
  };
  const closeOutputs = () => outputs().getByRole('button', { name: 'Close', exact: true }).click();
  const checkBounds = async (width, suffix) => {
    await page.setViewportSize({ width, height: width < 800 ? 950 : 982 });
    if (suffix === 'studio' && width < 800) {
      const collapse = page.getByRole('button', { name: 'Collapse inspector', exact: true });
      if (await collapse.isVisible()) await collapse.click();
      await page.locator('.studio-app').evaluate(el => { el.scrollTop = 0; });
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await controls();
    assert.equal(await header().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `Header fits at ${width}px`);
    const outside = await header().locator('button:visible').evaluateAll(buttons => buttons.filter(button => {
      const rect = button.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1;
    }).map(button => button.getAttribute('aria-label') || button.textContent));
    assert.deepEqual(outside, [], `Header actions stay inside ${width}px viewport`);
    if (suffix === 'studio') {
      const footer = await page.getByTestId('production-statusbar').boundingBox();
      const viewport = page.viewportSize();
      assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= viewport.height + 1, `Production status remains visible at ${width}px`);
      const dock = await page.getByRole('navigation', { name: 'Channel toolbar', exact: true }).boundingBox();
      assert.ok(dock && dock.y + dock.height <= footer.y - 7, `Channel toolbar clears the production status strip at ${width}px`);
    }
    await page.screenshot({ path: path.join(artifacts, `${suffix}-${width}.png`), fullPage: width < 800 });
  };

  await page.getByRole('button', { name: 'Send to Program', exact: true }).waitFor();
  await controls();
  assert.equal(await header().getByRole('button', { name: 'Send to Program', exact: true }).count(), 0, 'Presenting stays in the channel workspace');
  await openOutputs();
  assert.equal((await get('studio/status')).state, 'offline', 'Inspecting Outputs does not start Program');
  assert.equal((await get('studio')).revision, original.revision, 'Inspecting Outputs does not change routing');
  await outputs().getByRole('button', { name: 'Set up Program screen', exact: true }).click();
  await outputs().getByRole('heading', { name: 'Program output', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1, 'Screen setup stays inside the same Outputs dialog');
  assert.equal((await get('studio/status')).state, 'offline', 'Inspecting display setup does not start Program');
  await outputs().getByRole('button', { name: 'All outputs', exact: true }).click();
  await closeOutputs();
  await page.getByRole('button', { name: 'Send to Program', exact: true }).click();
  await until(async () => (await get('studio/status')).state === 'running', 'Send to Program starts renderer');
  const presented = await get('studio');
  assert.ok(presented.program?.id.startsWith('presentation_'));
  assert.equal(presented.scenes.length, original.scenes.length + 1);
  assert.deepEqual(presented.scenes.slice(0, original.scenes.length), original.scenes, 'Existing scenes survive quick presentation');
  assert.deepEqual(presented.outputs, original.outputs, 'Quick presentation preserves screen routing');
  assert.equal(presented.mainAudioSourceId, original.mainAudioSourceId, 'Quick presentation preserves Main');
  assert.equal(await page.getByRole('button', { name: 'On Program', exact: true }).isDisabled(), true);
  assert.equal((await request.post(`${base}/api/studio/command`, { data: { revision: presented.revision, command: { type: 'take', sceneId: original.scenes[0].id } } })).status(), 200);
  await page.getByRole('button', { name: 'Send to Program', exact: true }).click();
  await until(async () => !!(await get('studio')).program?.id.startsWith('presentation_'), 'return to presentation');
  assert.equal((await get('studio')).scenes.length, presented.scenes.length, 'Dedicated presentation scene is reused');

  await toolbar().getByRole('button', { name: 'Record Program', exact: true }).click();
  await until(async () => !!(await get('studio/status')).recording, 'record starts outside Studio');
  const recordingId = (await get('studio/status')).recording.id;
  assert.doesNotMatch(await toolbar().getByRole('button', { name: 'Stop recording Program', exact: true }).innerText(), /\d{2}:\d{2}/, 'Record action has a stable label');
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  await controls();
  assert.equal((await get('studio/status')).recording.id, recordingId, 'Navigation preserves recording');
  const footer = page.getByTestId('production-statusbar');
  await footer.waitFor();
  await footer.getByTestId('program-engine-status').filter({ hasText: 'Engine running' }).waitFor();
  await until(async () => /\d+(?:\.\d+)?\s*fps/.test(await footer.getByTestId('program-fps').innerText()), 'real engine FPS in footer');
  assert.equal(await footer.getByTestId('memory-usage').innerText(), 'Unavailable', 'Browser does not claim native desktop memory readings');
  assert.equal(await footer.getByTestId('live-elapsed').innerText(), 'Off air', 'Recording does not imply broadcasting');
  await until(async () => /^\d{2}:\d{2}:\d{2}$/.test(await footer.getByTestId('recording-elapsed').innerText()) && await footer.getByTestId('recording-elapsed').innerText() !== '00:00:00', 'recording elapsed clock ticks');
  const summary = page.getByTestId('outputs-summary');
  await summary.waitFor();
  assert.equal(await summary.locator('button,input,select').count(), 0, 'Studio output destinations are read-only');
  assert.equal(await page.getByRole('button', { name: 'Add output', exact: true }).count(), 0, 'Configuration is absent from the lower workspace');
  await openOutputs();
  await outputs().getByRole('button', { name: 'Add output', exact: true }).waitFor();
  const firstOutput = presented.outputs[0];
  await outputs().getByLabel(`${firstOutput.name} route`, { exact: true }).selectOption(original.scenes[0].id);
  await until(async () => (await get('studio')).outputs.find(item => item.id === firstOutput.id)?.mode === 'scene', 'shared panel pins output');
  await closeOutputs();
  await summary.getByText(original.scenes[0].name, { exact: false }).waitFor();
  for (const width of [1512, 1280, 768, 375]) {
    await checkBounds(width, 'studio');
    assert.equal(await footer.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `Footer fits at ${width}px`);
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.getByRole('link', { name: 'Open Media library', exact: true }).click();
  await page.getByTestId('media-library').waitFor();
  await controls();
  assert.equal((await get('studio/status')).recording.id, recordingId, 'Media preserves recording');
  await openOutputs();
  assert.equal(await outputs().getByLabel(`${firstOutput.name} route`, { exact: true }).inputValue(), original.scenes[0].id, 'Same saved routing is visible in another workspace');
  await outputs().getByRole('button', { name: 'Open Lumen Share', exact: true }).click();
  await outputs().getByRole('heading', { name: 'Program output', exact: true }).waitFor();
  await outputs().getByRole('button', { name: 'Create output link', exact: true }).click();
  await outputs().getByLabel('View-only link', { exact: true }).waitFor();
  const link = await outputs().getByLabel('View-only link', { exact: true }).inputValue();
  assert.match(link, /\/output\/program#/);
  assert.equal(await page.getByRole('dialog').count(), 1, 'Sharing also uses the same dialog');
  await outputs().getByRole('button', { name: 'All outputs', exact: true }).click();
  await outputs().getByRole('button', { name: 'Set up Program screen', exact: true }).click();
  await outputs().getByRole('heading', { name: 'Monitor or projector', exact: true }).waitFor();
  await closeOutputs();
  await toolbar().getByRole('button', { name: 'Stop recording Program', exact: true }).click();
  await until(async () => !(await get('studio/status')).recording, 'record stops from Media');
  await until(async () => (await get('studio/recordings')).some(item => item.id === recordingId && item.status === 'complete'), 'real recording finalized');
  await page.goto(`${base}/studio?output=${encodeURIComponent(firstOutput.id)}&returnTo=${encodeURIComponent('/media')}`);
  await outputs().waitFor();
  await until(() => page.url().includes('/studio?') && !new URL(page.url()).searchParams.has('output'), 'Media output reference normalizes the route');
  assert.equal(new URL(page.url()).searchParams.get('returnTo'), '/media');
  assert.equal(await page.getByRole('dialog').count(), 1, 'Media output reference opens the same shared dialog');
  await until(() => page.evaluate(id => document.activeElement?.closest('[data-output-id]')?.getAttribute('data-output-id') === id, firstOutput.id), 'Media output reference focuses its named destination');
  await closeOutputs();
  await page.getByRole('link', { name: 'Back to Media', exact: true }).click();
  await page.getByTestId('media-library').waitFor();
  await toolbar().getByRole('button', { name: 'Open Go Live controls', exact: true }).click();
  await page.getByRole('dialog', { name: 'Go Live', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close Go Live controls', exact: true }).click();
  await page.getByRole('button', { name: 'Scripture — scripture', exact: true }).click();
  await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  await controls();
  await openOutputs(); await closeOutputs();
  await page.getByRole('button', { name: 'Prayer marathon — presentation', exact: true }).click();
  await page.getByRole('button', { name: 'On Program', exact: true }).waitFor();
  for (const width of [1512, 1280, 768, 375]) await checkBounds(width, 'presentation');
  await openOutputs();
  assert.equal(await outputs().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Shared Outputs panel fits mobile');
  await page.screenshot({ path: path.join(artifacts, 'outputs-mobile.png'), fullPage: true });
  await closeOutputs();
  const output = await context.newPage(); await output.goto(`${base}/studio/output/program`);
  assert.equal(await output.getByLabel('Shared Program controls', { exact: true }).count(), 0, 'Public Program has no operator controls');
  assert.equal(await output.getByTestId('production-statusbar').count(), 0, 'Public Program has no operator status strip');
  assert.equal((await request.post(`${base}/api/users`, { data: { username: 'viewer', password: 'test-pass', displayName: 'Viewer' } })).status(), 200);
  const viewer = await browser.newContext();
  assert.equal((await viewer.request.post(`${base}/api/auth/login`, { data: { username: 'viewer', password: 'test-pass' } })).status(), 200);
  const viewerPage = await viewer.newPage(); await viewerPage.goto(base);
  await viewerPage.getByRole('link', { name: 'Lumen home', exact: true }).waitFor();
  assert.equal(await viewerPage.getByRole('button', { name: 'Open Outputs', exact: true }).count(), 0, 'Unprivileged viewer cannot configure outputs');
  assert.equal((await viewer.request.post(`${base}/api/studio/command`, { data: { revision: (await get('studio')).revision, command: { type: 'blank', outputId: firstOutput.id, blanked: true } } })).status(), 403);
  await viewer.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', artifacts, checks: ['focused header and contextual presentation action', 'one shared Outputs dialog across Presentation/Studio/Media/Worship', 'inspect settings without starting Program', 'routing persistence and read-only lower destinations', 'real recording across workspaces', 'footer engine/FPS/connection and honest memory fallback', 'separate recording/live clocks', 'Program share and display setup', 'responsive header/footer/dialog', 'public and viewer isolation'] }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true, mask: [page.locator('[data-team-private]')] }).catch(() => {});
  console.error(logs.slice(-6000)); console.error(`Artifacts: ${artifacts}`); throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { const exit = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 6000))]); }
  await fs.rm(directory, { recursive: true, force: true });
}
