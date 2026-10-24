// Lyrics search/keyboard regression on a disposable offline station. This never
// opens the operator's data, engine, microphone, capture devices, or recordings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-lyrics-search-'));
const port = Number(process.env.LUMEN_LYRICS_SEARCH_TEST_PORT ?? 3446);
const base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page, server;
const errors = [], checks = [], takes = [], previews = [], listeningWrites = [];
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const fixtures = [
  { id: 'grace', title: 'Amazing Grace', author: 'John Newton', copyright: 'Public domain', sections: [
    { id: 'grace_v1', label: 'Verse 1', text: 'Amazing grace how sweet the sound\nThat saved a wretch like me' },
    { id: 'grace_v2', label: 'Verse 2', text: 'Through many dangers toils and snares\nI have already come' },
  ] },
  { id: 'love', title: 'Amazing Love', author: 'Lumen test library', sections: [
    { id: 'love_v1', label: 'Verse 1', text: 'Light is rising in the morning\nEvery heart can sing again' },
    { id: 'love_c', label: 'Chorus', text: 'Your amazing love will never leave us\nHope will light the road ahead' },
  ] },
  { id: 'river', title: 'River of Mercy', author: 'Lumen test library', sections: [
    { id: 'river_v1', label: 'Verse 1', text: 'We gather here before the dawn\nWe lift a quiet song of hope' },
    { id: 'river_c', label: 'Chorus', text: 'You carry us through the deepest waters\nYour mercy brings us home' },
    { id: 'river_bridge', label: 'Bridge', text: 'Let the weary find their courage\nLet the broken rise again' },
  ] },
  { id: 'dawn', title: 'Grace at Dawn', author: 'Lumen test library', sections: [
    { id: 'dawn_v1', label: 'Verse 1', text: 'Amazing grace is on our lips\nThe morning bells ring out again' },
  ] },
  { id: 'overflow', title: 'Zzz Overflow Anthem', author: 'Lumen test library', sections: [
    { id: 'overflow_v1', label: 'Verse 1', text: 'Distant lanterns gather on the hillside\nLet every village sing a welcome' },
  ] },
];
const selection = (songId, sectionId) => ({ kind: 'lyrics', songId, sectionId });
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
    channels: ['lyrics', 'scripture'].map(kind => ({ id: kind, name: kind === 'lyrics' ? 'Lyrics' : 'Scripture', kind, playlistId: `p_${kind}`, defaultMode: 'manual' })),
    playlists: ['lyrics', 'scripture'].map(kind => ({ id: `p_${kind}`, name: `${kind} archive`, items: [] })),
  };
  const saved = await request.put(`${base}/api/content`, { data: content }); assert.equal(saved.status(), 200, await saved.text());
  // The old empty-library endpoint returns at most 500 songs. Matching a song
  // beyond that page must still open its complete sections and prepare it.
  const libraryFixtures = [...fixtures, ...Array.from({ length: 497 }, (_, index) => ({
    id: `filler_${index}`, title: `Library hymn ${String(index).padStart(3, '0')}`, sections: [{ id: `filler_section_${index}`, label: 'Verse', text: `Fixture refrain number ${index}` }],
  }))];
  for (let index = 0; index < libraryFixtures.length; index += 25) {
    await Promise.all(libraryFixtures.slice(index, index + 25).map(async data => {
      const response = await request.post(`${base}/api/worship/songs`, { data });
      assert.equal(response.status(), 201, await response.text());
    }));
  }
  const libraryPage = await (await request.get(`${base}/api/worship/songs`)).json();
  assert.equal(libraryPage.length, 500); assert.ok(!libraryPage.some(song => song.id === 'overflow'));
  const workspace = async () => (await request.get(`${base}/api/worship/channels/lyrics`)).json();
  const production = async () => (await request.get(`${base}/api/studio`)).json();
  const publish = async command => {
    const state = await workspace();
    const response = await request.post(`${base}/api/worship/channels/lyrics/command`, { data: { revision: state.revision, command } });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const state = await production();
  state.sources = [
    { id: 'main', name: 'Persistent main input', kind: 'microphone', loop: false, audio: { volume: .73, muted: false, mode: 'always', delayMs: 80 } },
    { id: 'lyrics_feed', name: 'Lyrics text', kind: 'channel', channelId: 'lyrics', loop: false, audio: { volume: 0, muted: true, mode: 'follow', delayMs: 0 } },
  ];
  const layer = { id: 'lyrics_text', name: 'Lyrics lower third', kind: 'source', sourceId: 'lyrics_feed', visible: true, locked: false,
    x: 8, y: 70, width: 84, height: 24, opacity: 1, fit: 'contain', text: '', color: '#ffffff', background: '#00000080', fontSize: 48, fontWeight: 500, align: 'center', radius: 0, channelStyle: 'overlay' };
  state.scenes = [{ id: 'worship', name: 'Worship with lyrics', background: '#18302b', layers: [layer] }, { id: 'announcement', name: 'Announcement', background: '#302820', layers: [] }];
  state.previewSceneId = 'announcement'; state.mainAudioSourceId = 'main'; state.masterVolume = .81; state.masterMuted = false;
  const studioSave = await request.put(`${base}/api/studio`, { data: state }); assert.equal(studioSave.status(), 200, await studioSave.text());
  for (const command of [{ type: 'take', sceneId: 'worship' }, { type: 'route', outputId: state.outputs[0].id, sceneId: 'announcement' }]) {
    const current = await production(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: current.revision, command } });
    assert.equal(response.status(), 200, await response.text());
  }
  const initialStudio = await production();
  await publish({ type: 'setlist', songIds: ['grace', 'river'] });
  await publish({ type: 'take', selection: selection('grace', 'grace_v1') });
  const initialLive = await workspace();
  const initialScripture = await (await request.get(`${base}/api/worship/channels/scripture`)).json();
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/worship/preview')) previews.push(request);
    if (request.url().endsWith('/api/worship/channels/lyrics/command') && request.postDataJSON().command?.type === 'take') takes.push(request);
    if (/\/listening(?:\/|$)/.test(new URL(request.url()).pathname)) listeningWrites.push(request);
  });
  await page.goto(base); await page.getByRole('heading', { name: 'Find a song', exact: true }).waitFor();
  const input = page.getByLabel('Search songs', { exact: true });
  const rows = page.locator('.w-song-select');
  const send = page.getByRole('button', { name: 'Send live', exact: true });
  const dock = page.getByRole('navigation', { name: 'Channel toolbar', exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const searchPath = '/api/worship/song-search';
  async function search(query) {
    if (await input.inputValue() === query) {
      await until(() => page.locator('.w-search-box .w-spin').count().then(count => count === 0), `Existing search ${query} settles`);
      await settle(); return;
    }
    const response = page.waitForResponse(response => {
      const url = new URL(response.url()); return url.pathname === searchPath && url.searchParams.get('q') === query;
    });
    await input.fill(query);
    assert.equal((await response).status(), 200, `Search ${JSON.stringify(query)} succeeds`);
    await until(() => page.locator('.w-search-box .w-spin').count().then(count => count === 0), `Search ${query} settles`);
    await settle();
  }
  const title = row => row.locator('h3').evaluate(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim());
  const rowFor = name => rows.filter({ has: page.getByRole('heading', { name, exact: true }) });
  async function first(query, expected) {
    await search(query); assert.ok(await rows.count() > 0, `${query} has a result`);
    assert.equal(await title(rows.first()), expected, `${query} ranks the expected song first`);
  }
  async function privateState(label) {
    await settle();
    assert.deepEqual(await workspace(), initialLive, `${label}: Lyrics live state/setlist remain unchanged`);
    assert.deepEqual(await production(), initialStudio, `${label}: Studio Program, Preview, audio and routes remain unchanged`);
    assert.deepEqual(await (await request.get(`${base}/api/worship/channels/scripture`)).json(), initialScripture, `${label}: Scripture is unchanged`);
    assert.equal(takes.length, 0, `${label}: search/prepare cannot implicitly publish`);
    assert.equal(listeningWrites.length, 0, `${label}: manual search never starts a listening or capture session`);
  }
  async function prepared(songId, sectionId) {
    const fixture = fixtures.find(song => song.id === songId), section = fixture.sections.find(section => section.id === sectionId);
    await until(async () => await send.isEnabled() && (await page.getByTestId('prepared-cue').innerText()).includes(section.text.split('\n')[0]), `prepared ${fixture.title}, ${section.label}`);
    assert.deepEqual(previews.at(-1).postDataJSON(), selection(songId, sectionId), 'Preparation resolves the exact matched song/section');
  }
  async function active(expected) {
    await until(async () => {
      const id = await input.getAttribute('aria-activedescendant');
      return id && page.locator(`[id="${id}"][data-search-active="true"]`).innerText().then(text => text.includes(expected));
    }, `keyboard highlight ${expected}`);
  }
  for (const query of ['amaz gr', 'amazng grcae', 'amazing grace']) await first(query, 'Amazing Grace');
  await search('amazing grace');
  const ranked = await rows.locator('h3').allInnerTexts();
  assert.ok(ranked.indexOf('Amazing Grace') < ranked.indexOf('Grace at Dawn'), 'A matching title outranks the same words buried in another song’s lyrics');
  await privateState('Partial titles and common title typos');
  checks.push('Partial titles and common omissions/transpositions find the intended song; exact title matches outrank lyric-only matches');

  await first('distant lant', 'Zzz Overflow Anthem');
  await input.press('Enter'); await prepared('overflow', 'overflow_v1');
  assert.equal(await page.locator('.w-song-heading h2').innerText(), 'Zzz Overflow Anthem', 'A result outside the blank-library page opens the selected song column');
  assert.equal(await page.locator('.w-song-cues .w-section-cue').count(), fixtures.find(song => song.id === 'overflow').sections.length, 'The selected song column exposes every section');
  await privateState('Search beyond the first library page');
  checks.push('Search covers the full local library and correctly opens songs outside the first 500-song browse page');

  for (const query of ['deep wat', 'deepst watres', 'carry deepest waters']) {
    await first(query, 'River of Mercy');
    assert.ok((await page.locator('.w-song-result').first().innerText()).includes('deepest waters'), 'A remembered lyric result exposes its matching line');
    await input.press('Enter'); await prepared('river', 'river_c');
    assert.ok(await input.evaluate(element => element === document.activeElement), 'Enter preparation retains search input focus');
  }
  await page.screenshot({ path: path.join(dir, 'lyrics-search-1512.png'), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 }); await settle();
  assert.ok(await input.isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Result snippets do not cause horizontal overflow');
  await page.screenshot({ path: path.join(dir, 'lyrics-search-1024.png'), fullPage: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await privateState('Remembered and misspelled lyrics');
  checks.push('Remembered word fragments and lyric typos show a matching line and prepare its actual Chorus, not the first verse');

  await search('amazing');
  const names = await rows.locator('h3').allInnerTexts(); assert.ok(names.length >= 2, 'Keyboard test has multiple ranked songs');
  const beforeArrows = previews.length;
  await input.press('ArrowDown'); await active(names[0]);
  await input.press('ArrowDown'); await active(names[1]);
  assert.equal(previews.length, beforeArrows, 'Arrow navigation highlights without preparing');
  await input.press('Enter');
  const secondSong = fixtures.find(song => song.title === names[1]); await prepared(secondSong.id, secondSong.sections[0].id);
  await input.press('ArrowUp'); await active(names[0]);
  await input.press('ArrowUp'); await active(names.at(-1));
  await search('deep wat');
  assert.equal(await input.getAttribute('aria-activedescendant'), null, 'Changing query clears the previous song highlight');
  const beforeImeEnter = previews.length;
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, isComposing: true }); await settle();
  assert.equal(previews.length, beforeImeEnter, 'Confirming IME composition never prepares a song');
  await input.press('Enter'); await prepared('river', 'river_c');
  await privateState('Keyboard result navigation');
  checks.push('Arrow keys highlight and wrap without publication, Enter prepares the highlighted song, and query changes clear stale navigation');

  const held = [];
  const holdOld = async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'amazng') held.push(route);
    else await route.continue();
  };
  await page.route(`**${searchPath}?*`, holdOld);
  await input.fill('amazng'); await until(() => held.length === 1, 'old song search held');
  assert.equal(await rows.count(), 0, 'Old song rows cannot remain selectable during a new query');
  const pendingEnterPreviews = previews.length;
  await input.press('Enter'); await until(() => held.length === 2, 'Enter resolves the current pending query');
  await first('deep wat', 'River of Mercy');
  for (const route of held) await route.continue().catch(() => {});
  await page.unroute(`**${searchPath}?*`, holdOld);
  await page.waitForTimeout(160); await settle();
  assert.equal(previews.length, pendingEnterPreviews, 'A superseded Enter cannot prepare a song after the operator changes query');
  assert.equal(await title(rows.first()), 'River of Mercy', 'A late old response cannot restore older song results');
  await input.press('Enter'); await prepared('river', 'river_c');
  await privateState('Out-of-order song search');
  checks.push('Rapid typing, Enter during search, and delayed superseded requests cannot restore or prepare a stale song');

  // Single- and double-clicking a song remain private preparations. Scripture’s
  // separate double-click-to-publish gesture must not leak into Lyrics.
  await first('amaz gr', 'Amazing Grace');
  await rowFor('Amazing Grace').click(); await prepared('grace', 'grace_v1');
  await rowFor('Amazing Grace').dblclick(); await prepared('grace', 'grace_v1');
  await privateState('Song clicking');
  const pin = page.getByRole('button', { name: 'Unpin song', exact: true }).first(); await pin.focus();
  for (const modifier of ['ctrlKey', 'metaKey']) await pin.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, [modifier]: true });
  const edit = page.getByRole('button', { name: 'Edit song', exact: true }).first(); await edit.focus();
  for (const modifier of ['ctrlKey', 'metaKey']) await edit.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, [modifier]: true });
  await privateState('Pin and Edit shortcut safeguards');
  await page.getByRole('button', { name: 'Edit song', exact: true }).first().click();
  await page.getByLabel('Song title', { exact: true }).waitFor();
  for (const chord of ['Control+Enter', 'Meta+Enter']) await page.keyboard.press(chord);
  await page.keyboard.press('Escape');
  await privateState('Song editor shortcut safeguards');
  await dock.getByRole('button', { name: 'Open Multiview', exact: true }).click();
  const multiview = page.getByTestId('studio-multiview'); await multiview.waitFor(); await multiview.focus();
  for (const chord of ['Control+Enter', 'Meta+Enter']) await page.keyboard.press(chord);
  await page.getByRole('button', { name: 'Collapse Multiview', exact: true }).click();
  await privateState('Multiview shortcut safeguards');
  await rowFor('Amazing Grace').focus();
  for (const chord of ['Control+Shift+Enter', 'Meta+Shift+Enter', 'Control+Alt+Enter', 'Meta+Alt+Enter', 'Control+Meta+Enter']) await page.keyboard.press(chord);
  for (const modifier of ['ctrlKey', 'metaKey']) for (const flag of ['repeat', 'isComposing']) {
    await rowFor('Amazing Grace').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, [modifier]: true, [flag]: true });
  }
  await privateState('Modified, held and IME shortcuts');
  checks.push('Song clicks never implicitly send live; editor, Multiview, held-key, IME and ambiguous modified chords retain publishing safeguards');

  async function explicitLive(songId, sectionId, gesture, label) {
    const count = takes.length, previewCount = previews.length;
    await gesture();
    await until(async () => {
      const state = await workspace(); return !state.blanked && state.live?.selection.songId === songId && state.live?.selection.sectionId === sectionId && await send.isEnabled();
    }, label);
    assert.equal(takes.length, count + 1, `${label}: one explicit Take`);
    assert.equal(previews.length, previewCount, `${label}: modified Enter does not natively reprepare`);
    assert.deepEqual(takes.at(-1).postDataJSON().command.selection, selection(songId, sectionId));
  }
  await explicitLive('grace', 'grace_v1', () => send.click(), 'Send live button');
  for (const [songId, sectionId, query, chord] of [['river', 'river_c', 'deep wat', 'Control+Enter'], ['grace', 'grace_v1', 'amazng grcae', 'Meta+Enter']]) {
    await first(query, fixtures.find(song => song.id === songId).title);
    await input.press('Enter'); await prepared(songId, sectionId);
    await explicitLive(songId, sectionId, () => page.keyboard.press(chord), `${chord} from the focused search combobox`);
    await rows.first().click(); await prepared(songId, sectionId);
    await explicitLive(songId, sectionId, () => page.keyboard.press(chord), `${chord} from the focused song result`);
  }
  await search('deep wat');
  const delayed = [];
  const holdPreview = async route => { delayed.push(route); };
  await page.route('**/api/worship/preview', holdPreview);
  await rows.first().click(); await until(() => delayed.length === 1, 'matched lyric preparation held');
  const beforePendingTakes = takes.length, beforePendingLive = await workspace();
  for (const chord of ['Control+Enter', 'Meta+Enter']) await page.keyboard.press(chord);
  assert.equal(takes.length, beforePendingTakes, 'A pending lyric preparation cannot publish the old draft');
  assert.deepEqual(await workspace(), beforePendingLive);
  await delayed[0].continue(); await page.unroute('**/api/worship/preview', holdPreview);
  await prepared('river', 'river_c');
  await explicitLive('river', 'river_c', () => page.keyboard.press('Control+Enter'), 'Resolved lyric search preparation');
  assert.deepEqual(await production(), initialStudio, 'All explicit Lyrics publications preserve Studio Program, Preview, main audio and routing');
  assert.deepEqual(await (await request.get(`${base}/api/worship/channels/scripture`)).json(), initialScripture, 'Lyrics publication never changes Scripture');
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state, 'offline', 'Search and content publication never start the production engine');
  assert.equal(listeningWrites.length, 0, 'Search and explicit publication never open a physical listening session');
  assert.deepEqual(errors, []);
  checks.push('Send live, Ctrl+Enter and Meta+Enter publish exactly one correct section from search-input or result focus; pending preparation cannot send stale content and Studio stays manual');

  // Pinning intentionally changes the service setlist, so check this after all
  // preparation-only deep-equality assertions against the original workspace.
  const beforePin = await workspace(), beforePinTakes = takes.length;
  await first('distant lant', 'Zzz Overflow Anthem');
  await page.locator('.w-song-result').first().getByRole('button', { name: 'Pin song to setlist', exact: true }).click();
  await until(async () => (await workspace()).setlist.includes('overflow'), 'overflow song pinned');
  const overflowSetlist = page.locator('.w-setlist-song > button').filter({ hasText: 'Zzz Overflow Anthem' });
  await overflowSetlist.waitFor();
  await page.reload(); await page.getByRole('heading', { name: 'Find a song', exact: true }).waitFor();
  await overflowSetlist.waitFor();
  assert.ok((await workspace()).setlist.includes('overflow'), 'The overflow song pin persists after reload');
  await overflowSetlist.click(); await prepared('overflow', 'overflow_v1');
  assert.equal(await page.locator('.w-song-heading h2').innerText(), 'Zzz Overflow Anthem', 'A pinned song outside the first library page opens the selected song column after reload');
  assert.equal(await page.locator('.w-song-cues .w-section-cue').count(), fixtures.find(song => song.id === 'overflow').sections.length, 'Every pinned song section remains available after reload');
  const afterPin = await workspace();
  assert.deepEqual(afterPin.live, beforePin.live, 'Pinning and preparing an overflow song never replace the live cue');
  assert.equal(afterPin.blanked, beforePin.blanked);
  assert.equal(takes.length, beforePinTakes, 'Pinning and reloading never send an implicit Take');
  assert.deepEqual(await production(), initialStudio, 'Pinning, reload and overflow setlist preparation leave Studio unchanged');
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state, 'offline');
  assert.deepEqual(errors, []);
  checks.push('Songs outside the first 500-song browse page can be pinned, survive reload, and prepare from the setlist without changing the live cue or Studio');
  console.log(JSON.stringify({ checks, takes: takes.length, previews: previews.length, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-7000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
