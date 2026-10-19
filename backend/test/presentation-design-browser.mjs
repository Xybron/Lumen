// UI workflow regression. All data, accounts and outputs belong to an isolated
// temporary station; this never connects to the operator's running station.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-presentation-design-'));
const port = Number(process.env.LUMEN_PRESENTATION_TEST_PORT ?? 3422), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let server, browser, logs = '';
const errors = [];
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function shutdown() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
  await exited;
}
const slide = (id, title) => ({ id, type: 'text', title, body: title, durationMs: 30000 });
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  await until(async () => (await fetch(`${base}/api/studio`)).ok, 'temporary station ready', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  context.setDefaultTimeout(15000);
  const request = context.request;
  const login = await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } });
  assert.equal(login.status(), 200);
  const fixture = {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [
      { id: 'alpha', name: 'Alpha presentation', kind: 'presentation', playlistId: 'p_alpha', defaultMode: 'manual' },
      { id: 'beta', name: 'Beta presentation', kind: 'announcement', playlistId: 'p_beta', defaultMode: 'manual' },
      { id: 'scripture', name: 'Scripture', kind: 'scripture', playlistId: 'p_scripture', defaultMode: 'manual' },
      { id: 'lyrics', name: 'Lyrics', kind: 'lyrics', playlistId: 'p_lyrics', defaultMode: 'manual' },
    ],
    playlists: [
      { id: 'p_alpha', name: 'Alpha presentation', items: [slide('alpha_1', 'Alpha first'), slide('alpha_2', 'Alpha second')] },
      { id: 'p_beta', name: 'Beta presentation', items: [slide('beta_1', 'Beta first')] },
      { id: 'p_legacy', name: 'Legacy service', items: [slide('legacy_1', 'Legacy welcome'), slide('legacy_2', 'Legacy notices')] },
      { id: 'p_scripture', name: 'Scripture archive', items: [] }, { id: 'p_lyrics', name: 'Lyrics archive', items: [] },
    ],
    sources: [{ id: 'src_alpha', kind: 'channel', ref: 'alpha' }, { id: 'src_beta', kind: 'channel', ref: 'beta' },
      { id: 'src_scripture', kind: 'channel', ref: 'scripture' }, { id: 'src_lyrics', kind: 'channel', ref: 'lyrics' }],
    destinations: [{ id: 'main', kind: 'screen', label: 'Main screen' }], routes: [{ id: 'route_alpha', sourceId: 'src_alpha', destinationId: 'main' }],
    program: { programSourceId: 'src_alpha', previewSourceId: 'src_beta' },
  };
  const seeded = await request.put(`${base}/api/content`, { data: fixture }); assert.equal(seeded.status(), 200, await seeded.text());
  const getContent = async () => (await request.get(`${base}/api/content`)).json();
  const original = await getContent();
  const studio = await (await request.get(`${base}/api/studio`)).json();
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Alpha presentation', exact: true }).waitFor();
  const collapse = page.getByRole('button', { name: 'Collapse toolbar', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  const output = await context.newPage(); output.on('pageerror', error => errors.push(error.message));
  await output.goto(`${base}/live/alpha`); await output.getByText('Alpha first', { exact: true }).waitFor();
  const rail = page.getByRole('complementary', { name: 'Presentation playlists', exact: true });
  assert.equal(await rail.getByText('Scripture archive', { exact: true }).count(), 0, 'Dedicated Scripture archive is not a presentation playlist');
  assert.equal(await rail.getByText('Lyrics archive', { exact: true }).count(), 0, 'Dedicated Lyrics archive is not a presentation playlist');
  const unchangedLive = async label => {
    const next = await getContent();
    assert.deepEqual(next.channels.find(channel => channel.id === 'alpha'), original.channels.find(channel => channel.id === 'alpha'), label);
    assert.deepEqual(next.playlists.find(playlist => playlist.id === 'p_alpha'), original.playlists.find(playlist => playlist.id === 'p_alpha'), label);
    assert.deepEqual(next.program, original.program, `${label}: content routing remains unchanged`);
    assert.deepEqual(next.routes, original.routes, `${label}: active routes remain unchanged`);
    const currentStudio = await (await request.get(`${base}/api/studio`)).json();
    assert.deepEqual(currentStudio.program, studio.program, `${label}: Studio Program remains unchanged`);
    assert.deepEqual(currentStudio.programTransition, studio.programTransition, `${label}: no Take is triggered`);
    await output.getByText('Alpha first', { exact: true }).waitFor();
  };
  await rail.getByRole('button', { name: 'Open presentation Beta presentation', exact: true }).click();
  await page.getByRole('heading', { name: 'Beta presentation', exact: true }).waitFor();
  assert.equal((await getContent()).updatedAt, original.updatedAt, 'Focusing a bound playlist does not save content');
  await page.getByRole('button', { name: 'New slide', exact: true }).click();
  await until(async () => (await getContent()).playlists.find(playlist => playlist.id === 'p_beta').items.length === 2, 'New slide targets the focused presentation');
  await unchangedLive('Editing a different presentation');

  const legacyItems = original.playlists.find(playlist => playlist.id === 'p_legacy').items;
  const channelCount = (await getContent()).channels.length;
  await rail.getByRole('button', { name: 'Open Legacy service as presentation', exact: true }).click();
  const opening = page.getByRole('dialog', { name: 'Open as presentation', exact: true }); await opening.waitFor();
  assert.ok((await opening.innerText()).includes('playback will not start'));
  await page.screenshot({ path: path.join(dir, 'presentation-legacy-confirm.png'), fullPage: true });
  await opening.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await getContent()).channels.length, channelCount, 'Cancelling never creates a channel');
  await rail.getByRole('button', { name: 'Open Legacy service as presentation', exact: true }).click();
  await opening.getByRole('button', { name: 'Create presentation channel', exact: true }).click();
  await page.getByRole('heading', { name: 'Legacy service', exact: true }).waitFor();
  const linked = await getContent(), legacyChannel = linked.channels.find(channel => channel.playlistId === 'p_legacy');
  assert.ok(legacyChannel); assert.equal(legacyChannel.kind, 'presentation'); assert.equal(legacyChannel.defaultMode, 'manual');
  assert.deepEqual(linked.playlists.find(playlist => playlist.id === 'p_legacy').items, legacyItems, 'Linking retains the original slide IDs and content');
  assert.equal(linked.playlists.length, original.playlists.length, 'Linking does not duplicate the playlist');
  assert.ok(linked.sources.some(source => source.kind === 'channel' && source.ref === legacyChannel.id));
  assert.equal(await page.getByRole('button', { name: 'Manual', exact: true }).getAttribute('aria-pressed'), 'true', 'Legacy channel opens in Manual, never auto-start');
  await unchangedLive('Explicitly linking a legacy playlist');
  await page.screenshot({ path: path.join(dir, 'presentation-linked-desktop.png'), fullPage: true });

  await rail.getByRole('button', { name: 'New presentation', exact: true }).click();
  await rail.getByLabel('Presentation name', { exact: true }).fill('Sunday announcements');
  await rail.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('heading', { name: 'Sunday announcements', exact: true }).waitFor();
  const withNew = await getContent(), newChannel = withNew.channels.find(channel => channel.name === 'Sunday announcements');
  assert.ok(newChannel); assert.equal(newChannel.kind, 'presentation');
  assert.deepEqual(withNew.playlists.find(playlist => playlist.id === newChannel.playlistId).items, []);
  assert.ok(withNew.sources.some(source => source.kind === 'channel' && source.ref === newChannel.id));
  await unchangedLive('Creating a new paired presentation');
  await rail.getByRole('button', { name: 'Rename Sunday announcements', exact: true }).click();
  const rename = rail.getByLabel('Rename presentation', { exact: true });
  await rename.fill('Sunday notices'); await rename.press('Enter');
  await until(async () => (await getContent()).channels.find(channel => channel.id === newChannel.id)?.name === 'Sunday notices', 'Linked presentation rename');
  assert.equal((await getContent()).playlists.find(playlist => playlist.id === newChannel.playlistId).name, 'Sunday notices', 'Linked channel and playlist names stay in sync');
  await unchangedLive('Renaming another presentation');

  await rail.getByRole('button', { name: 'Delete Beta presentation', exact: true }).click();
  const deleting = page.getByRole('dialog', { name: 'Delete presentation?', exact: true }); await deleting.waitFor();
  await deleting.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok((await getContent()).channels.some(channel => channel.id === 'beta'), 'Deletion is cancellable');
  await rail.getByRole('button', { name: 'Delete Beta presentation', exact: true }).click();
  await deleting.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await until(async () => !(await getContent()).channels.some(channel => channel.id === 'beta'), 'Confirmed delete removes linked channel');
  const afterDelete = await getContent();
  assert.ok(!afterDelete.playlists.some(playlist => playlist.id === 'p_beta'));
  assert.ok(!afterDelete.sources.some(source => source.ref === 'beta'));
  assert.equal(afterDelete.program.programSourceId, 'src_alpha', 'Deleting another channel leaves the selected Program source');
  await output.getByText('Alpha first', { exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  const drawersClosed = async () => page.evaluate(() => {
    const left = document.querySelector('.playlist-rail')?.parentElement.getBoundingClientRect();
    const right = document.querySelector('.presentation-cues')?.parentElement.getBoundingClientRect();
    return left && right && left.right <= 1 && right.left >= innerWidth - 1;
  });
  await until(drawersClosed, 'Breakpoint resize immediately puts both hidden drawers offscreen');
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await rail.getByRole('button', { name: 'Open presentation Alpha presentation', exact: true }).click();
  await page.getByRole('button', { name: 'Close playlists', exact: true }).click();
  await until(drawersClosed, 'Explicit playlist close finishes without covering workspace');
  await page.getByRole('heading', { name: 'Alpha presentation', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await page.getByRole('button', { name: 'Close playlists', exact: true }).focus();
  await page.keyboard.press('Escape'); await until(drawersClosed, 'Escape closes playlist drawer');
  await page.getByRole('button', { name: 'Up Next', exact: true }).click();
  await page.getByRole('button', { name: 'Close upcoming slides', exact: true }).focus();
  await page.keyboard.press('Escape'); await until(drawersClosed, 'Escape closes upcoming drawer');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile workspace has no document horizontal overflow');
  await page.screenshot({ path: path.join(dir, 'presentation-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Presentation workflow passed: bound focus, correct edit target, safe legacy linking, paired creation, confirmed deletion, live isolation, mobile layout. Artifacts: ${dir}`);
} catch (error) {
  console.error(logs.slice(-5000)); console.error(`Test artifacts: ${dir}`); throw error;
} finally { await browser?.close(); await shutdown(); }
