// Manual Scripture search regression on a disposable offline station. No
// operator data, engine, physical inputs, or recording devices are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-scripture-search-'));
const port = Number(process.env.LUMEN_SCRIPTURE_SEARCH_TEST_PORT ?? 3445);
const base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page, server;
const errors = [], checks = [], takes = [], previews = [];
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const selection = verse => ({ kind: 'scripture', versionId: 'KJV', book: 43, chapter: 3, verse });
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'temporary station startup', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const content = {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: ['scripture', 'lyrics'].map(kind => ({ id: kind, name: kind === 'scripture' ? 'Scripture' : 'Lyrics', kind, playlistId: `p_${kind}`, defaultMode: 'manual' })),
    playlists: ['scripture', 'lyrics'].map(kind => ({ id: `p_${kind}`, name: `${kind} archive`, items: [] })),
  };
  const saved = await request.put(`${base}/api/content`, { data: content }); assert.equal(saved.status(), 200, await saved.text());
  const workspace = async () => (await request.get(`${base}/api/worship/channels/scripture`)).json();
  const production = async () => (await request.get(`${base}/api/studio`)).json();
  const publish = async command => {
    const state = await workspace();
    const response = await request.post(`${base}/api/worship/channels/scripture/command`, { data: { revision: state.revision, command } });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  // Seed a meaningful live composition and persistent audio: content search and
  // preparation must never change Program, Preview, audio, or output routing.
  const state = await production();
  state.sources = [
    { id: 'main', name: 'Persistent main input', kind: 'microphone', loop: false, audio: { volume: .73, muted: false, mode: 'always', delayMs: 80 } },
    { id: 'scripture_feed', name: 'Scripture text', kind: 'channel', channelId: 'scripture', loop: false, audio: { volume: 0, muted: true, mode: 'follow', delayMs: 0 } },
  ];
  const layer = { id: 'scripture_text', name: 'Scripture lower third', kind: 'source', sourceId: 'scripture_feed', visible: true, locked: false,
    x: 8, y: 70, width: 84, height: 24, opacity: 1, fit: 'contain', text: '', color: '#ffffff', background: '#00000080', fontSize: 48, fontWeight: 500, align: 'center', radius: 0, channelStyle: 'overlay' };
  state.scenes = [{ id: 'preacher', name: 'Preacher with Scripture', background: '#18302b', layers: [layer] }, { id: 'announcement', name: 'Announcement', background: '#302820', layers: [] }];
  state.previewSceneId = 'announcement'; state.mainAudioSourceId = 'main'; state.masterVolume = .81; state.masterMuted = false;
  const studioSave = await request.put(`${base}/api/studio`, { data: state }); assert.equal(studioSave.status(), 200, await studioSave.text());
  for (const command of [{ type: 'take', sceneId: 'preacher' }, { type: 'route', outputId: state.outputs[0].id, sceneId: 'announcement' }]) {
    const current = await production(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: current.revision, command } });
    assert.equal(response.status(), 200, await response.text());
  }
  const initialStudio = await production();
  await publish({ type: 'take', selection: selection(16) });
  const initialLive = await workspace();
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/worship/preview')) previews.push(request);
    if (request.url().endsWith('/api/worship/channels/scripture/command') && request.postDataJSON().command?.type === 'take') takes.push(request);
  });
  await page.goto(base); await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  const input = page.getByLabel('Search scripture', { exact: true });
  const rows = page.locator('.w-verse-result');
  const choices = page.getByTestId('scripture-book-choice');
  const send = page.getByRole('button', { name: 'Send live', exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function search(query) {
    const response = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/worship/scripture' && url.searchParams.get('q') === query;
    });
    await input.fill(query);
    assert.equal((await response).status(), 200, `Search ${JSON.stringify(query)} succeeds`);
    await until(() => page.locator('.w-search-box .w-spin').count().then(count => count === 0), `Search ${query} settles`);
    await settle();
  }
  async function exact(query, reference) {
    await search(query);
    assert.equal(await rows.count(), 1, `${JSON.stringify(query)} finds one exact verse`);
    assert.ok((await rows.first().innerText()).includes(reference), `${JSON.stringify(query)} resolves to ${reference}`);
    assert.equal(await choices.count(), 0, 'An unambiguous reference needs no extra selection');
  }
  async function remainsPrivate(label) {
    await settle();
    assert.deepEqual(await workspace(), initialLive, `${label}: live Scripture is unchanged`);
    assert.deepEqual(await production(), initialStudio, `${label}: Studio, audio and routing are unchanged`);
    assert.equal(takes.length, 0, `${label}: no content was implicitly published`);
  }
  async function prepared(reference) {
    await until(async () => await send.isEnabled() && (await page.getByTestId('prepared-cue').innerText()).includes(`${reference} · KJV`), `prepared ${reference}`);
  }
  async function active(reference) {
    await until(async () => {
      const id = await input.getAttribute('aria-activedescendant');
      return id && page.locator(`[id="${id}"][data-search-active="true"]`).innerText().then(text => text.includes(reference));
    }, `keyboard highlight ${reference}`);
  }
  await exact('jeremia 20 11', 'Jeremiah 20:11');
  await page.screenshot({ path: path.join(dir, 'search-jeremiah-1512.png'), fullPage: true });
  for (const [query, reference] of [['jer20 11', 'Jeremiah 20:11'], ['jn3:16', 'John 3:16'], ['1cor13 4', '1 Corinthians 13:4'], ['ps23 1', 'Psalms 23:1']]) await exact(query, reference);
  await remainsPrivate('Compact references, abbreviations, and the screenshot typo');
  checks.push('Short references, numbered books, separator-free book/chapter and the screenshot’s Jeremiah spelling resolve locally');

  for (const query of ['lord my shepherd', 'lord my sheph', 'lor shep']) {
    await search(query);
    assert.ok((await rows.allInnerTexts()).some(text => text.includes('Psalms 23:1')), `${query} finds the familiar shepherd verse using partial words`);
  }
  await remainsPrivate('Keyword and partial-word search');
  checks.push('Remembered words and partial words find passages without a complete quotation');

  await search('jer');
  assert.ok(await choices.count() > 0 || await rows.count() > 0, 'A short book prefix offers useful results or choices');
  await search('cor13 4');
  assert.deepEqual((await choices.allInnerTexts()).map(text => text.trim()), ['1 Corinthians 13:4', '2 Corinthians 13:4'], 'An omitted numbered-book prefix offers both valid members of its family');
  assert.equal(await rows.count(), 0, 'An omitted ordinal never silently chooses the first numbered book');
  const beforeFamilyPreviews = previews.length;
  await choices.filter({ hasText: /^2 Corinthians\s+13:4/ }).click();
  await until(async () => await rows.count() === 1 && (await rows.first().innerText()).includes('2 Corinthians 13:4'), 'choosing the second family member resolves that exact book');
  assert.equal(previews.length, beforeFamilyPreviews, 'Choosing a numbered book family searches without preparing');
  await remainsPrivate('Numbered book family selection');
  await search('jo3:16');
  assert.ok(await choices.count() > 1, 'An ambiguous book prefix offers explicit book choices');
  assert.equal(await rows.count(), 0, 'Ambiguous shorthand does not silently become an unrelated book’s verses');
  const choiceLabels = (await choices.allInnerTexts()).map(text => text.trim());
  for (const impossible of ['Jonah 3:16', '2 John 3:16', '3 John 3:16']) assert.ok(!choiceLabels.includes(impossible), `${impossible} is not offered because it is not present in the installed Bible`);
  for (const label of choiceLabels) {
    const response = await request.get(`${base}/api/worship/scripture?version=KJV&q=${encodeURIComponent(label)}`);
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.verses.length, 1, `Every offered book interpretation has the exact verse available: ${label}`);
    const verse = result.verses[0];
    assert.equal(`${verse.bookName} ${verse.chapter}:${verse.verse}`, label, 'Available choices resolve without changing their canonical reference');
  }
  await page.screenshot({ path: path.join(dir, 'search-choices-1512.png'), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await settle();
  assert.ok(await input.isVisible(), 'Search remains visible at a smaller station size');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Search choices do not cause horizontal overflow');
  await page.screenshot({ path: path.join(dir, 'search-choices-1024.png'), fullPage: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  const beforeChoicePreviews = previews.length;
  const johnChoice = choices.filter({ hasText: /^John\s+3:16/ });
  assert.equal(await johnChoice.count(), 1, 'The canonical John choice is clearly identified');
  await johnChoice.click();
  await until(async () => await rows.count() === 1 && (await rows.first().innerText()).includes('John 3:16'), 'choosing John resolves exactly that book');
  assert.equal(previews.length, beforeChoicePreviews, 'Selecting a book interpretation searches only, without preparing or publishing');
  await remainsPrivate('Ambiguity selection');
  checks.push('Ambiguous shorthand and omitted ordinals offer only installed canonical passages; choosing one searches only and stays responsive on small screens');

  await search('jn3');
  assert.equal(await rows.count(), 36);
  const beforeArrowPreviews = previews.length;
  await input.press('ArrowDown'); await active('John 3:1');
  await input.press('ArrowDown'); await active('John 3:2');
  assert.equal(previews.length, beforeArrowPreviews, 'Arrow navigation highlights without preparing');
  await input.press('Enter'); await prepared('John 3:2');
  await remainsPrivate('Keyboard prepare');
  await input.press('ArrowUp'); await active('John 3:1');
  await input.press('ArrowUp'); await active('John 3:36');
  await input.press('Enter'); await prepared('John 3:36');
  await exact('jer20 11', 'Jeremiah 20:11');
  assert.equal(await input.getAttribute('aria-activedescendant'), null, 'Changing query resets the previous highlighted result');
  await input.press('Enter'); await prepared('Jeremiah 20:11');
  await remainsPrivate('Default Enter after query change');
  checks.push('Arrow keys highlight, Enter prepares the highlighted verse, and changing the query clears stale keyboard selection');

  // Search is deliberately quick enough to overlap requests. An old response
  // must not restore a stale highlighted verse while the operator keeps typing.
  const heldSearches = [];
  const holdOldSearch = async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'jn3:17') heldSearches.push(route);
    else await route.continue();
  };
  await page.route('**/api/worship/scripture?*', holdOldSearch);
  await input.fill('jn3:17');
  await until(() => heldSearches.length === 1, 'hold the superseded search');
  await exact('jer20 11', 'Jeremiah 20:11');
  for (const route of heldSearches) await route.continue().catch(() => {});
  await page.unroute('**/api/worship/scripture?*', holdOldSearch);
  await page.waitForTimeout(160); await settle();
  assert.equal(await rows.count(), 1, 'A late query cannot restore a different result set');
  assert.ok((await rows.first().innerText()).includes('Jeremiah 20:11'), 'Only the latest query remains selectable');
  await input.press('ArrowDown'); await active('Jeremiah 20:11');
  await input.press('Enter'); await prepared('Jeremiah 20:11');
  await remainsPrivate('Rapid typing and late search response');
  checks.push('Rapid typing and delayed superseded search responses cannot restore or prepare an older verse');

  // Private preparations and active-result navigation still require a separate
  // deliberate live gesture. All existing publishing paths remain content-only.
  await search('jn3');
  await rows.nth(16).click(); await prepared('John 3:17');
  await remainsPrivate('Single-click after enhanced search');
  const live = async verse => {
    await until(async () => (await workspace()).live?.selection.verse === verse, `explicit live John 3:${verse}`);
    await until(() => send.isEnabled(), 'Send live settles');
  };
  let count = takes.length;
  await rows.nth(17).dblclick(); await live(18);
  assert.equal(takes.length, count + 1, 'Double-click publishes exactly once');
  for (const [verse, chord] of [[19, null], [20, 'Control+Enter'], [21, 'Meta+Enter']]) {
    await rows.nth(verse - 1).click(); await prepared(`John 3:${verse}`);
    count = takes.length;
    if (chord) await page.keyboard.press(chord); else await send.click();
    await live(verse);
    assert.equal(takes.length, count + 1, `${chord ?? 'Send live'} publishes exactly once`);
  }
  // The result combobox keeps input focus while arrows/Enter prepare. Its own
  // Send live chords must remain available without exempting other comboboxes
  // or dialog/listbox controls from their established keyboard safeguards.
  for (const [verse, chord] of [[22, 'Control+Enter'], [23, 'Meta+Enter']]) {
    await exact(`jn3:${verse}`, `John 3:${verse}`);
    await input.press('Enter'); await prepared(`John 3:${verse}`);
    assert.ok(await input.evaluate(element => element === document.activeElement), 'Enter preparation leaves the search combobox focused');
    const beforeShortcutPreviews = previews.length;
    count = takes.length;
    await page.keyboard.press(chord); await live(verse);
    assert.equal(takes.length, count + 1, `${chord} publishes exactly once from the focused Scripture search combobox`);
    assert.equal(previews.length, beforeShortcutPreviews, `${chord} never natively reprepares the search input`);
  }
  assert.deepEqual(await production(), initialStudio, 'Even explicit content publication never changes Studio scene/audio/output state');
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state, 'offline', 'Searching and publishing never start the engine');
  assert.deepEqual(errors, []);
  checks.push('Single-click stays private, while double-click, Send live, Ctrl+Enter and Meta+Enter remain exact explicit publications from result and search-input focus without scene switching');
  console.log(JSON.stringify({ checks, takes: takes.length, previews: previews.length, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-7000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
