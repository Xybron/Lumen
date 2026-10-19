// Search-focus regression on a disposable local station. Nothing is published;
// no operator data, engine, physical inputs, or recording devices are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-scripture-autofocus-'));
const port = Number(process.env.LUMEN_SCRIPTURE_AUTOFOCUS_TEST_PORT ?? 3447);
const base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let server, browser, page, logs = '';
const checks = [], errors = [], publications = [];
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station startup', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const request = context.request;
  const login = await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } });
  assert.equal(login.status(), 200, await login.text());
  const channels = [
    { id: 'scripture', name: 'Main Scripture', kind: 'scripture' },
    { id: 'scripture_two', name: 'Second Scripture', kind: 'scripture' },
    { id: 'lyrics', name: 'Lyrics', kind: 'lyrics' },
  ];
  const saved = await request.put(`${base}/api/content`, { data: {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: channels.map(channel => ({ ...channel, playlistId: `p_${channel.id}`, defaultMode: 'manual' })),
    playlists: channels.map(channel => ({ id: `p_${channel.id}`, name: `${channel.name} archive`, items: [] })),
  } });
  assert.equal(saved.status(), 200, await saved.text());
  const production = async () => (await request.get(`${base}/api/studio`)).json();
  const workspace = async id => (await request.get(`${base}/api/worship/channels/${id}`)).json();
  const studio = await production();
  studio.sources = [
    { id: 'main', name: 'Persistent main input', kind: 'microphone', loop: false, audio: { volume: .73, muted: false, mode: 'always', delayMs: 80 } },
    { id: 'scripture_feed', name: 'Scripture text', kind: 'channel', channelId: 'scripture', loop: false, audio: { volume: 0, muted: true, mode: 'follow', delayMs: 0 } },
  ];
  const layer = { id: 'scripture_text', name: 'Scripture lower third', kind: 'source', sourceId: 'scripture_feed', visible: true, locked: false,
    x: 8, y: 70, width: 84, height: 24, opacity: 1, fit: 'contain', text: '', color: '#ffffff', background: '#00000080', fontSize: 48, fontWeight: 500, align: 'center', radius: 0, channelStyle: 'overlay' };
  studio.scenes = [{ id: 'preacher', name: 'Preacher with Scripture', background: '#18302b', layers: [layer] }, { id: 'announcement', name: 'Announcement', background: '#302820', layers: [] }];
  studio.previewSceneId = 'announcement'; studio.mainAudioSourceId = 'main'; studio.masterVolume = .81; studio.masterMuted = false;
  const studioSave = await request.put(`${base}/api/studio`, { data: studio }); assert.equal(studioSave.status(), 200, await studioSave.text());
  for (const command of [{ type: 'take', sceneId: 'preacher' }, { type: 'route', outputId: studio.outputs[0].id, sceneId: 'announcement' }]) {
    const current = await production(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: current.revision, command } });
    assert.equal(response.status(), 200, await response.text());
  }
  // A pre-existing on-air verse makes accidental Enter/space publication visible.
  const initial = await workspace('scripture');
  const seed = await request.post(`${base}/api/worship/channels/scripture/command`, { data: { revision: initial.revision, command: { type: 'take', selection: { kind: 'scripture', versionId: 'KJV', book: 43, chapter: 3, verse: 16 } } } });
  assert.equal(seed.status(), 200, await seed.text());
  const initialStudio = await production();
  const initialLive = Object.fromEntries(await Promise.all(channels.map(async channel => [channel.id, await workspace(channel.id)])));
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(worship\/channels\/[^/]+|studio)\/command$/.test(new URL(request.url()).pathname)) publications.push(request.postDataJSON());
  });
  const input = () => page.getByLabel('Search scripture', { exact: true });
  const active = locator => locator.evaluate(element => document.activeElement === element);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scriptureChip = name => page.getByRole('button', { name: `${name} — scripture`, exact: true });
  const lyricsChip = () => page.getByRole('button', { name: 'Lyrics — lyrics', exact: true });
  async function focused(label) {
    await until(async () => await input().count() === 1 && await active(input()), label);
    assert.equal(await input().evaluate(element => element.selectionStart === element.selectionEnd), true, 'An empty search receives a caret, not an unrelated selected control');
  }
  async function typeSearch(query, reference) {
    // Native keyboard input, with no input.click/fill/focus, proves the gesture
    // actually lets a newly arrived operator start typing immediately.
    await page.keyboard.type(query);
    await until(async () => (await page.locator('.w-verse-result').allInnerTexts()).some(text => text.includes(reference)), `native typing resolves ${reference}`);
    assert.equal(await input().inputValue(), query);
  }
  async function readyScripture() {
    // A modal menu correctly hides the workspace from the accessibility tree;
    // its actual DOM can still finish rendering while the menu is active.
    await page.locator('.w-search-heading h2').filter({ hasText: /^Find a passage$/ }).waitFor(); await settle();
  }
  async function lyrics() {
    await lyricsChip().click(); await page.getByRole('heading', { name: 'Find a song', exact: true }).waitFor(); await settle();
    assert.equal(await active(page.getByLabel('Search songs', { exact: true })), false, 'Lyrics retains its existing non-autofocus behavior');
  }
  async function holdChannel(id = 'scripture') {
    const held = [];
    const pattern = `**/api/worship/channels/${id}`;
    const handler = async route => { held.push(route); };
    await page.route(pattern, handler);
    return {
      wait: () => until(() => held.length > 0, `held ${id} initial load`),
      release: async () => {
        await page.unroute(pattern, handler);
        for (const route of held) await route.continue().catch(() => {});
      },
    };
  }

  const firstLoad = await holdChannel();
  await page.goto(base); await firstLoad.wait();
  assert.equal(await input().count(), 0, 'Before delayed channel load, the search does not exist yet');
  await firstLoad.release(); await focused('direct initial load focuses Scripture once its search mounts');
  await typeSearch('jn3 17', 'John 3:17');
  assert.equal(await active(input()), true, 'Search-result arrival leaves the already focused input in place');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await until(async () => (await page.getByTestId('prepared-cue').innerText()).includes('John 3:17'), 'keyboard-only preparation from initial autofocus');
  assert.equal(await active(input()), true, 'Keyboard preparation retains search focus');
  checks.push('Delayed direct load autofocuses the rendered Scripture search; native typing, arrows and Enter immediately work without a click');

  // Focus is an entry convenience, not an ongoing effect: queries, result
  // arrivals, draft responses and public state updates must not take it back.
  const pending = [];
  const holdSearch = async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'jn3') pending.push(route);
    else await route.continue();
  };
  await page.route('**/api/worship/scripture?*', holdSearch);
  await input().fill('jn3'); await until(() => pending.length > 0, 'hold search result response');
  const chapter = page.getByLabel('Bible chapter', { exact: true });
  await chapter.focus();
  for (const route of pending) await route.continue().catch(() => {});
  await page.unroute('**/api/worship/scripture?*', holdSearch);
  await until(async () => await page.locator('.w-verse-result').count() === 36, 'search results arrive'); await settle();
  assert.equal(await active(chapter), true, 'Late search results do not refocus search over the chapter selector');
  const row = page.locator('.w-verse-result').nth(17);
  await row.click();
  await until(async () => (await page.getByTestId('prepared-cue').innerText()).includes('John 3:18'), 'row private preparation settles'); await settle();
  assert.equal(await active(row), true, 'Private preparation does not steal focus from a clicked verse');
  const book = page.getByLabel('Bible book', { exact: true });
  await book.focus();
  await book.selectOption('19');
  await until(async () => (await input().inputValue()).startsWith('Psalms '), 'book browse updates the query'); await settle();
  assert.equal(await active(book), true, 'Browsing and its new results retain the Bible selector focus');
  await page.getByRole('button', { name: 'Manage Bible library', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await settle();
  assert.equal(await active(input()), false, 'Closing the Bible library never queues a fresh automatic focus');
  checks.push('Search responses, result preparation, chapter browsing and library-dialog closure never steal an operator-selected focus');

  await lyrics();
  await scriptureChip('Main Scripture').click(); await focused('returning from Lyrics focuses Scripture again');
  await typeSearch('jer20 11', 'Jeremiah 20:11');
  await scriptureChip('Second Scripture').click(); await focused('each independent Scripture channel autofocuses');
  await typeSearch('ps23 1', 'Psalms 23:1');
  await scriptureChip('Main Scripture').click(); await focused('returning between Scripture channel IDs autofocuses');
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await until(() => page.url() === `${base}/studio`, 'open Studio without switching scenes');
  await scriptureChip('Main Scripture').click(); await focused('returning through the Studio toolbar autofocuses Scripture');
  await page.reload(); await focused('reloading directly into Scripture autofocuses');
  checks.push('Lyrics remains unchanged; re-entering from Lyrics, another Scripture channel, Studio or a direct reload always focuses the new Scripture search');

  // User intent during loading consumes the one-time request. Keeping a modal
  // open (and then closing it) must not let a late response re-arm autofocus.
  for (const kind of ['menu', 'dialog', 'header', 'multiview']) {
    await lyrics();
    const delayed = await holdChannel();
    await scriptureChip('Main Scripture').click(); await delayed.wait();
    let focusedControl;
    if (kind === 'menu') {
      focusedControl = page.getByRole('button', { name: 'Add channel', exact: true });
      await focusedControl.click(); await page.getByRole('menu').waitFor();
    } else if (kind === 'dialog') {
      focusedControl = page.getByRole('button', { name: 'Pending media', exact: true });
      await focusedControl.click(); await page.getByRole('dialog').waitFor();
    } else if (kind === 'header') {
      focusedControl = page.getByRole('link', { name: 'Lumen home', exact: true });
      await focusedControl.click();
    } else {
      await page.getByRole('button', { name: 'Open Multiview', exact: true }).click();
      const region = page.getByTestId('floating-multiview'); await region.waitFor();
      focusedControl = page.getByRole('button', { name: 'Move Multiview', exact: true });
      await focusedControl.click();
    }
    await delayed.release(); await readyScripture();
    assert.equal(await active(input()), false, `${kind}: delayed channel load respects the operator's external interaction`);
    if (kind === 'menu' || kind === 'dialog') {
      assert.equal(await page.locator(`[role="${kind}"][data-state="open"]`).count(), 1, `${kind} remains open after search mounts`);
      await page.keyboard.press('Escape'); await page.getByRole(kind).waitFor({ state: 'hidden' });
    } else if (kind === 'multiview') {
      assert.equal(await page.getByTestId('floating-multiview').isVisible(), true, 'Multiview remains open after search mounts');
      await page.getByRole('button', { name: 'Collapse Multiview', exact: true }).click();
    } else assert.equal(await active(focusedControl), true, 'The header retains its deliberate focus');
    await page.waitForTimeout(180); await settle();
    assert.equal(await active(input()), false, `${kind}: closing or leaving the external control cannot defer a stale autofocus`);
  }
  checks.push('Deliberate menu, dialog, header and Multiview interaction while loading cancels automatic focus permanently for that channel entry');

  // An abandoned channel load must not move focus in the next channel.
  await lyrics(); const abandoned = await holdChannel();
  await scriptureChip('Main Scripture').click(); await abandoned.wait();
  await lyrics(); const lyricsInput = page.getByLabel('Search songs', { exact: true });
  await lyricsInput.click(); await page.keyboard.type('grace');
  await abandoned.release(); await page.waitForTimeout(200); await settle();
  assert.equal(await active(lyricsInput), true, 'A completed abandoned Scripture load cannot steal focus in Lyrics');
  assert.equal(await lyricsInput.inputValue(), 'grace');
  checks.push('Leaving before loading finishes cancels the old focus request without stealing focus in the next channel');

  await scriptureChip('Main Scripture').click(); await focused('fresh entry after cancellation focuses normally');
  await page.keyboard.type('jn3 16');
  await until(async () => (await page.locator('.w-verse-result').allInnerTexts()).some(text => text.includes('John 3:16')), 'final focused search');
  await page.screenshot({ path: path.join(dir, 'scripture-autofocus.png'), fullPage: true });
  assert.equal(publications.length, 0, 'Focus, typing, preparing and channel navigation never publish Scripture or switch Studio scenes');
  assert.deepEqual(await production(), initialStudio, 'Program, Preview, output routing and persistent Main audio remain untouched');
  for (const channel of channels) assert.deepEqual(await workspace(channel.id), initialLive[channel.id], `${channel.name} live state is unchanged`);
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state, 'offline', 'Focus tests never start the production engine');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, publications: publications.length, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-7000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
