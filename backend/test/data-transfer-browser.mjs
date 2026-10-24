// Run after the backend and frontend builds. Every station and archive belongs
// to a temporary directory; this suite never opens the operator's saved data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-data-transfer-'));
const { WorshipLibrary } = await import('../dist/worship-library.js');
const { ContentSchema } = await import('../dist/schema.js');
const { initialProduction } = await import('../dist/production-schema.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ2kAAAAASUVORK5CYII=', 'base64');
const songOne = { id: 'portable_song_one', title: 'Portable silver lanterns', author: 'Synthetic author', copyright: 'Synthetic fixture', sections: [{ id: 'verse_one', label: 'Verse 1', text: 'Silver lanterns shine beside the quiet garden.' }] };
const songTwo = { id: 'portable_song_two', title: 'Portable golden courtyard', author: 'Synthetic author', copyright: 'Synthetic fixture', sections: [{ id: 'verse_two', label: 'Verse 1', text: 'Golden windows brighten the courtyard at dawn.' }] };
const retainedSong = { id: 'retained_song', title: 'Retained local song', sections: [{ id: 'retained_verse', label: 'Verse 1', text: 'A local synthetic song stays unchanged.' }] };
const sourceBible = { version: { id: 'SPAN', name: 'Synthetic portable range', language: 'en', attribution: 'Synthetic range fixture' }, verses: [
  { book: 43, chapter: 3, verse: 2, endVerse: 4, text: 'Silver lanterns illuminate the courtyard while curious travelers gather beside the ancient fountain.' },
  { book: 43, chapter: 3, verse: 5, text: 'The final synthetic paragraph follows the joined passage.' },
] };
const sourceImage = 'media/backgrounds/portable-image.png', orphanImage = 'media/backgrounds/unselected-image.png';
const none = () => ({ bibles: [], songs: [], presentations: [], media: [], scenes: [], recordings: [], setlists: [], clips: [], settings: false });
const zero = () => ({ bibles: 0, songs: 0, presentations: 0, media: 0, scenes: 0, recordings: 0, setlists: 0, clips: 0, settings: 0 });
const stations = [], errors = [], takes = [], checks = [];
let browser, sourcePage, targetPage;

async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

async function seed(name, source) {
  const dir = path.join(artifacts, name); await fs.mkdir(path.join(dir, 'media', 'backgrounds'), { recursive: true });
  const library = new WorshipLibrary(path.join(dir, 'worship.db'));
  try {
    if (source) {
      library.saveSong(songOne); library.saveSong(songTwo); library.importBible(sourceBible);
      library.command('portable_setlist', 0, { type: 'setlist', songIds: [songTwo.id] });
      library.command('portable_setlist', 1, { type: 'version', versionId: 'SPAN' });
    }
    else {
      library.saveSong(retainedSong);
      library.command('local_lyrics', 0, { type: 'take', selection: { kind: 'lyrics', songId: retainedSong.id, sectionId: 'retained_verse' } });
    }
  } finally { library.close(); }
  const content = ContentSchema.parse({ version: 2, updatedAt: new Date().toISOString(),
    settings: { transitionMs: source ? 1234 : 321, fontFamily: source ? 'Portable fixture font' : 'Inter' }, music: { mode: 'off' },
    playlists: source ? [{ id: 'portable_deck', name: 'Portable presentation', items: [{ id: 'portable_slide', type: 'image', title: 'Portable image slide', body: 'Synthetic presentation', background: { kind: 'image', src: sourceImage } }] }, { id: 'portable_setlist_playlist', name: 'Portable worship order', items: [] }] : [
      { id: 'local_lyrics_playlist', name: 'Local lyrics', items: [] }, { id: 'local_scripture_playlist', name: 'Local scripture', items: [] },
    ],
    channels: source ? [{ id: 'portable_channel', name: 'Portable presentation', kind: 'presentation', playlistId: 'portable_deck', defaultMode: 'manual' }, { id: 'portable_setlist', name: 'Portable worship order', kind: 'lyrics', playlistId: 'portable_setlist_playlist', defaultMode: 'manual' }] : [
      { id: 'local_lyrics', name: 'Local lyrics', kind: 'lyrics', playlistId: 'local_lyrics_playlist', defaultMode: 'manual' },
      { id: 'local_scripture', name: 'Local scripture', kind: 'scripture', playlistId: 'local_scripture_playlist', defaultMode: 'manual' },
    ],
    sources: source ? [{ id: 'portable_source', kind: 'channel', ref: 'portable_channel' }] : [],
    destinations: [{ id: 'existing_screen', kind: 'screen', label: 'Existing screen' }], routes: [],
    program: { programSourceId: null, previewSourceId: null },
  });
  await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify(content));
  if (source) {
    await fs.writeFile(path.join(dir, sourceImage), png);
    await fs.writeFile(path.join(dir, orphanImage), Buffer.concat([png, Buffer.from('Unrelated synthetic asset')]));
  }
  const production = initialProduction();
  if (source) {
    production.scenes.push({ ...structuredClone(production.scenes[0]), id: 'portable_scene', name: 'Portable studio scene' });
    const recordingDir = path.join(dir, 'recordings', 'rec_portable'); await fs.mkdir(recordingDir, { recursive: true });
    const original = path.join(recordingDir, 'recording.webm');
    await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=160x90:r=5', '-t', '1', '-c:v', 'libvpx-vp9', '-threads', '1', '-an', '-y', original]);
    const recordingBytes = (await fs.stat(original)).size, now = '2026-10-24T12:00:00.000Z';
    await fs.writeFile(path.join(recordingDir, 'recording.json'), JSON.stringify({ id: 'rec_portable', name: 'Portable synthetic recording', status: 'complete', createdAt: now, durationMs: 1000, bytes: recordingBytes, nextChunk: 0 }));
    const settings = { inMs: 0, outMs: 1000, format: '16:9', fit: 'contain', positionX: .5, positionY: .5 };
    const draft = { ...settings, id: 'clip_portable', name: 'Portable clip project', recordingId: 'rec_portable', revision: 2, ownerId: 'usr_fixture', ownerName: 'Fixture editor', createdAt: now, updatedAt: now };
    const exported = { id: 'export_portable', name: 'Portable completed clip', draftId: draft.id, draftRevision: 2, recordingId: draft.recordingId, ownerId: draft.ownerId, status: 'complete', progress: 1, bytes: recordingBytes, createdAt: now, completedAt: now, settings, options: { container: 'webm', resolution: '720p' } };
    await fs.mkdir(path.join(dir, 'clips', 'exports'), { recursive: true });
    await fs.copyFile(original, path.join(dir, 'clips', 'exports', 'export_portable.webm'));
    await fs.writeFile(path.join(dir, 'clips', 'clips.json'), JSON.stringify({ version: 1, drafts: [draft], exports: [exported], media: { rec_portable: { durationMs: 1000, width: 160, height: 90 } } }));
  }
  // A held Program snapshot makes accidental changes observable without ever
  // starting an output engine or issuing a Take during the browser test.
  production.program = structuredClone(production.scenes[0]);
  production.programTransition = { id: 'fixture_held_take', kind: 'cut', durationMs: 0 };
  await fs.writeFile(path.join(dir, 'production.json'), JSON.stringify(production));
  return dir;
}

async function startStation(name, source) {
  const dir = await seed(name, source);
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  // Never inherit production tenant, relay, capture, or remote media settings.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LUMEN_|VPS_|MEDIA_ENGINE_)/.test(key)));
  const server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...env, LUMEN_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  const station = { dir, base, server, logs: '' }; stations.push(station);
  server.stdout.on('data', value => { station.logs += value; }); server.stderr.on('data', value => { station.logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, `${name} startup`, 30000);
  station.context = await browser.newContext({ viewport: { width: 1512, height: 982 }, acceptDownloads: true });
  station.request = station.context.request;
  const login = await station.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } });
  assert.equal(login.status(), 200, await login.text());
  station.page = await station.context.newPage(); station.page.setDefaultTimeout(15000);
  // Chrome can evict a response's inspector body after a File-backed binary
  // upload. Observe a clone of the JSON in-page without changing the request
  // or relying on Playwright's separate CDP response-body cache.
  await station.page.addInitScript(() => {
    window.__transferResponses = [];
    window.__observedAudio = [];
    const NativeAudio = window.Audio;
    window.Audio = new Proxy(NativeAudio, { construct(target, args) { const element = Reflect.construct(target, args); window.__observedAudio.push(element); return element; } });
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (/\/api\/data-transfer\/(preview|import|export|clear(?:\/preview)?)$/.test(response.url)) {
        void response.clone().json().then(body => window.__transferResponses.push({ url: response.url, status: response.status, body })).catch(() => {});
      }
      return response;
    };
  });
  station.page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  station.page.on('request', request => {
    if (request.method() !== 'POST') return;
    const url = new URL(request.url());
    if (/\/command$/.test(url.pathname) && request.postDataJSON()?.command?.type === 'take') takes.push(url.pathname);
    if (/\/studio\/(start|broadcast\/start|recordings)$/.test(url.pathname)) takes.push(url.pathname);
  });
  return station;
}

async function json(station, endpoint) {
  const response = await station.request.get(`${station.base}/api/${endpoint}`);
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
async function preview(station, filename, request = station.request) {
  const response = await request.post(`${station.base}/api/data-transfer/preview`, {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Lumen-Filename': encodeURIComponent(path.basename(filename)) }, data: await fs.readFile(filename),
  });
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
async function focusedInside(dialog) {
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Modal focus stays inside the transfer dialog');
}
async function openTransfer(current) {
  const account = current.getByRole('button', { name: /^Account menu for / });
  await account.waitFor();
  await until(() => account.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), 'generated profile image loads');
  await account.click();
  await current.getByRole('menuitem', { name: 'Data settings', exact: true }).click();
  const dialog = current.getByTestId('transfer-dialog'); await dialog.waitFor();
  await focusedInside(dialog); return dialog;
}
async function selectItem(dialog, category, id, checked) {
  await dialog.getByTestId(`transfer-category-${category}`).click();
  await dialog.getByTestId(`transfer-item-${category}-${id}`).setChecked(checked);
}
async function uploadPreview(station, dialog, filename) {
  await dialog.getByTestId('transfer-import-tab').click();
  await dialog.getByTestId('transfer-file').setInputFiles(filename);
  const offset = await station.page.evaluate(() => window.__transferResponses.length);
  const response = station.page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/api/data-transfer/preview'));
  await dialog.getByTestId('transfer-preview').click();
  const ready = await response; assert.equal(ready.status(), 200);
  return capturedResponse(station.page, 'preview', offset);
}
async function capturedResponse(current, endpoint, offset) {
  const response = await until(() => current.evaluate(({ endpoint, offset }) => window.__transferResponses.slice(offset).find(value => value.url.endsWith(`/api/data-transfer/${endpoint}`)), { endpoint, offset }), `${endpoint} JSON response`);
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}

try {
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--mute-audio'] });
  const source = await startStation('source', true), target = await startStation('target', false);
  sourcePage = source.page; targetPage = target.page;
  const originalContent = await json(target, 'content'), originalStudio = await json(target, 'studio');
  const originalWorkspace = await json(target, 'worship/channels/local_lyrics');
  const originalSongs = await json(target, 'worship/songs');

  await sourcePage.goto(source.base);
  assert.equal(await sourcePage.getByRole('button', { name: 'Data transfer', exact: true }).count(), 0, 'No redundant transfer button in the header');
  const sourceDialog = await openTransfer(sourcePage);
  await until(async () => (await sourceDialog.boundingBox())?.width >= 700, 'desktop transfer dialog has room for its categories and records');
  await sourceDialog.getByTestId('transfer-export-tab').click();
  await sourceDialog.getByTestId('transfer-clear-all').click();
  for (const [category, id] of [['bibles', 'SPAN'], ['songs', songOne.id], ['songs', songTwo.id], ['presentations', 'portable_deck'], ['media', orphanImage]]) {
    await selectItem(sourceDialog, category, id, true);
  }
  await sourceDialog.getByTestId('transfer-settings').setChecked(true);
  const downloadReady = sourcePage.waitForEvent('download');
  const exportResponseReady = sourcePage.waitForResponse(value => value.url().endsWith('/api/data-transfer/export') && value.request().method() === 'POST');
  await sourceDialog.getByTestId('transfer-export').click();
  const exportResponse = await exportResponseReady; assert.equal(exportResponse.status(), 200);
  const exportLink = await exportResponse.json(); assert.match(exportLink.downloadUrl, /^\/api\/data-transfer\/download\/[\w-]+$/);
  const download = await downloadReady; assert.match(download.suggestedFilename(), /\.lumen$/i);
  const archive = path.join(artifacts, 'portable-fixtures.lumen'); await download.saveAs(archive);
  assert.equal(await download.failure(), null); assert.ok((await fs.stat(archive)).size > 0);
  checks.push('Profile menu uses the generated avatar and opens Data settings; selected records stream through a native .lumen download');

  await targetPage.goto(target.base); await targetPage.getByRole('heading', { name: 'Find a song', exact: true }).waitFor();
  await targetPage.getByRole('heading', { name: retainedSong.title, exact: true }).waitFor();
  const documentIdentity = await targetPage.evaluate(() => { window.__transferDocumentIdentity = Math.random(); return window.__transferDocumentIdentity; });
  const targetDialog = await openTransfer(targetPage);
  const inspected = await uploadPreview(target, targetDialog, archive);
  assert.equal(inspected.catalog.songs.length, 2); assert.deepEqual(inspected.catalog.bibles.map(value => value.id), ['SPAN']);
  assert.equal(inspected.catalog.presentations.length, 1);
  assert.deepEqual(new Set(inspected.catalog.media.map(value => value.id)), new Set([sourceImage, orphanImage]));
  assert.equal(inspected.catalog.settings, true);
  assert.ok(Date.parse(inspected.expiresAt) > Date.parse(inspected.createdAt));
  assert.ok(Date.parse(inspected.expiresAt) > Date.now() && Date.parse(inspected.expiresAt) <= Date.now() + 15 * 60 * 1000 + 1000);
  assert.deepEqual(await json(target, 'content'), originalContent, 'Preview does not change presentations or settings');
  assert.deepEqual(await json(target, 'worship/songs'), originalSongs, 'Preview does not apply songs');
  await selectItem(targetDialog, 'songs', songTwo.id, false);
  await targetDialog.getByTestId('transfer-settings').setChecked(false);
  await selectItem(targetDialog, 'media', orphanImage, false);
  await selectItem(targetDialog, 'media', sourceImage, false);

  await targetPage.setViewportSize({ width: 390, height: 844 });
  await targetDialog.getByTestId('transfer-import').scrollIntoViewIfNeeded();
  const box = await targetDialog.boundingBox();
  assert.ok(box && box.x >= -1 && box.x + box.width <= 391 && box.y >= -1 && box.y + box.height <= 845, 'Transfer dialog fits a narrow viewport');
  await targetDialog.getByTestId('transfer-import').focus();
  for (let index = 0; index < 5; index++) { await targetPage.keyboard.press('Tab'); await focusedInside(targetDialog); }
  await targetPage.screenshot({ path: path.join(artifacts, 'import-mobile.png'), fullPage: true });
  await targetPage.setViewportSize({ width: 1512, height: 982 });
  checks.push('Preview is read-only; selectable items, narrow layout, and modal keyboard focus work');

  const importOffset = await targetPage.evaluate(() => window.__transferResponses.length);
  const importReady = targetPage.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/api/data-transfer/import'));
  await targetDialog.getByTestId('transfer-import').click();
  const importedResponse = await importReady; assert.equal(importedResponse.status(), 200);
  const result = await capturedResponse(targetPage, 'import', importOffset);
  assert.deepEqual(result.imported, { ...zero(), bibles: 1, songs: 1, presentations: 1, media: 1 });
  assert.ok(result.backupPath && path.resolve(result.backupPath).startsWith(target.dir + path.sep), 'Backup belongs to the disposable destination');
  await fs.stat(result.backupPath);
  await until(async () => !(await targetDialog.getByTestId('transfer-import').count()) || !(await targetDialog.getByTestId('transfer-import').isEnabled()), 'completed import cannot apply twice');
  await targetPage.screenshot({ path: path.join(artifacts, 'import-complete.png'), fullPage: true });
  await targetDialog.press('Escape'); await targetDialog.waitFor({ state: 'hidden' });
  await targetPage.getByRole('heading', { name: songOne.title, exact: true }).waitFor();
  assert.equal(await targetPage.getByRole('heading', { name: songTwo.title, exact: true }).count(), 0);
  assert.equal(await targetPage.evaluate(() => window.__transferDocumentIdentity), documentIdentity, 'Open library refreshes without a page reload');

  const currentContent = await json(target, 'content'), songs = await json(target, 'worship/songs');
  assert.deepEqual(songs.map(value => value.id).sort(), [retainedSong.id, songOne.id].sort());
  assert.deepEqual(songs.find(value => value.id === retainedSong.id), originalSongs[0]);
  assert.deepEqual(currentContent.settings, originalContent.settings);
  for (const field of ['program', 'routes', 'destinations', 'music']) assert.deepEqual(currentContent[field], originalContent[field], `Preserve ${field}`);
  for (const playlist of originalContent.playlists) assert.deepEqual(currentContent.playlists.find(value => value.id === playlist.id), playlist);
  for (const channel of originalContent.channels) assert.deepEqual(currentContent.channels.find(value => value.id === channel.id), channel);
  const importedPlaylist = currentContent.playlists.find(value => value.name === 'Portable presentation');
  assert.ok(importedPlaylist); assert.notEqual(importedPlaylist.id, 'portable_deck');
  const importedChannel = currentContent.channels.find(value => value.playlistId === importedPlaylist.id);
  assert.ok(importedChannel); assert.notEqual(importedChannel.id, 'portable_channel'); assert.equal(importedChannel.defaultMode, 'manual');
  assert.ok(currentContent.sources.some(value => value.kind === 'channel' && value.ref === importedChannel.id));
  const imagePath = importedPlaylist.items[0].background.src;
  assert.match(imagePath, /^\/?media\/backgrounds\/[\w.-]+$/);
  const imageResponse = await target.request.get(`${target.base}/${imagePath.replace(/^\//, '')}`);
  assert.equal(imageResponse.status(), 200); assert.deepEqual(await imageResponse.body(), png);
  const catalog = await json(target, 'data-transfer/catalog');
  assert.equal(catalog.media.length, 1, 'Only the required image is imported');
  assert.equal(catalog.songs.some(value => value.id === songTwo.id), false);
  const range = await json(target, 'worship/scripture?version=SPAN&q=John%203%3A3');
  assert.equal(range.verses.length, 1); assert.equal(range.verses[0].verse, 2); assert.equal(range.verses[0].endVerse, 4);
  assert.equal(range.verses[0].text, sourceBible.verses[0].text);
  assert.deepEqual(await json(target, 'worship/channels/local_lyrics'), originalWorkspace);
  assert.deepEqual(await json(target, 'studio'), originalStudio);
  assert.equal((await json(target, 'studio/status')).state, 'offline');
  assert.equal(takes.length, 0);
  checks.push('Selective import restores joined Bible ranges, one song, and a remapped presentation with its required image; excluded records and live output stay unchanged');

  const staleSave = await target.request.put(`${target.base}/api/content`, {
    headers: { 'X-Lumen-Content-Version': originalContent.updatedAt }, data: originalContent,
  });
  assert.equal(staleSave.status(), 409, 'A stale open editor cannot erase imported presentations');
  assert.deepEqual(await json(target, 'content'), currentContent);
  checks.push('A stale editor save is rejected after import instead of overwriting the merged presentation');

  const repeat = await preview(target, archive);
  const duplicate = await target.request.post(`${target.base}/api/data-transfer/import`, { data: { token: repeat.token, selection: { ...none(), bibles: ['SPAN'], songs: [songOne.id] } } });
  assert.equal(duplicate.status(), 200, await duplicate.text());
  const skipped = await duplicate.json();
  assert.deepEqual(skipped.imported, zero());
  assert.equal(skipped.skipped.bibles, 1); assert.equal(skipped.skipped.songs, 1);
  assert.deepEqual(await json(target, 'worship/songs'), songs);
  const replay = await target.request.post(`${target.base}/api/data-transfer/import`, { data: { token: repeat.token, selection: { ...none(), songs: [songOne.id] } } });
  assert.ok([403, 404, 410].includes(replay.status()), 'Completed preview tokens cannot be reused');
  checks.push('API reimport skips existing Bible/song IDs and completed preview tokens cannot apply twice');

  const malformed = path.join(artifacts, 'malformed.lumen'); await fs.writeFile(malformed, 'This is not a Lumen archive.');
  const beforeMalformed = await json(target, 'content');
  const errorDialog = await openTransfer(targetPage);
  await errorDialog.getByTestId('transfer-import-tab').click();
  await errorDialog.getByTestId('transfer-file').setInputFiles(malformed);
  const invalidReady = targetPage.waitForResponse(value => value.url().endsWith('/api/data-transfer/preview') && value.request().method() === 'POST');
  await errorDialog.getByTestId('transfer-preview').click();
  const invalid = await invalidReady; assert.ok(invalid.status() >= 400 && invalid.status() < 500);
  await errorDialog.getByRole('alert').waitFor();
  if (await errorDialog.getByTestId('transfer-import').count()) assert.equal(await errorDialog.getByTestId('transfer-import').isEnabled(), false);
  assert.deepEqual(await json(target, 'content'), beforeMalformed);
  assert.deepEqual(await json(target, 'worship/songs'), songs);
  await errorDialog.press('Escape');
  checks.push('Malformed archive shows a useful error and cannot be applied');

  async function userContext(username, admin = false, role = 'viewer') {
    const created = await target.request.post(`${target.base}/api/users`, { data: { username, displayName: username, password: 'fixture-password', isAdmin: admin } });
    assert.equal(created.status(), 200); const { user } = await created.json();
    if (!admin) assert.equal((await target.request.post(`${target.base}/api/users/${user.id}/grants`, { data: { channelId: '*', role } })).status(), 200);
    const context = await browser.newContext();
    assert.equal((await context.request.post(`${target.base}/api/auth/login`, { data: { username, password: 'fixture-password' } })).status(), 200);
    return context;
  }
  const anonymous = await browser.newContext(), viewer = await userContext('transfer_viewer'), otherAdmin = await userContext('transfer_other_admin', true);
  for (const [context, status] of [[anonymous, 401], [viewer, 403]]) {
    for (const [method, endpoint, data] of [['get', 'catalog'], ['post', 'export', none()], ['post', 'preview', {}], ['post', 'import', { token: 'unowned-token', selection: none() }], ['delete', 'preview/unowned-token'], ['get', 'clear/catalog'], ['post', 'clear/preview', { selection: none() }], ['post', 'clear', { token: 'unowned-token', confirmation: 'CLEAR' }], ['delete', 'clear/preview/unowned-token']]) {
      const response = await context.request[method](`${target.base}/api/data-transfer/${endpoint}`, data ? { data } : {});
      assert.equal(response.status(), status, `${method} ${endpoint} rejects unauthorized users`);
    }
  }
  const owned = await preview(target, archive);
  const stolen = await otherAdmin.request.post(`${target.base}/api/data-transfer/import`, { data: { token: owned.token, selection: { ...none(), songs: [songTwo.id] } } });
  assert.ok([403, 404, 410].includes(stolen.status()), 'Preview token belongs to the uploading user, including between administrators');
  // Deletion deliberately need not reveal whether someone else's token exists.
  await otherAdmin.request.delete(`${target.base}/api/data-transfer/preview/${owned.token}`);
  const ownerStillValid = await target.request.post(`${target.base}/api/data-transfer/import`, { data: { token: owned.token, selection: { ...none(), songs: [songOne.id] } } });
  assert.equal(ownerStillValid.status(), 200, 'Another user cannot invalidate the owner\'s preview');
  assert.equal((await ownerStillValid.json()).skipped.songs, 1);
  const cancelled = await target.request.delete(`${target.base}/api/data-transfer/preview/${owned.token}`);
  assert.ok([200, 204].includes(cancelled.status()));
  assert.equal((await json(target, 'worship/songs')).some(value => value.id === songTwo.id), false);
  const author = await userContext('transfer_author', false, 'author'), authorPage = await author.newPage();
  await authorPage.goto(target.base);
  const authorDialog = await openTransfer(authorPage);
  assert.equal(await authorDialog.getByTestId('transfer-clear-tab').count(), 0, 'Station authors have import/export but no Clear mode');
  for (const [method, endpoint, data] of [['get', 'clear/catalog'], ['post', 'clear/preview', { selection: none() }], ['post', 'clear', { token: 'unowned-token', confirmation: 'CLEAR' }], ['delete', 'clear/preview/unowned-token']]) {
    const rejected = await author.request[method](`${target.base}/api/data-transfer/${endpoint}`, data ? { data } : {});
    assert.equal(rejected.status(), 403, `Clear ${endpoint} requires administrator access`);
  }
  await Promise.all([anonymous.close(), viewer.close(), otherAdmin.close(), author.close()]);
  checks.push('Every transfer endpoint rejects anonymous/viewer access, and preview tokens are bound to their uploading user');

  // Hold responses long enough for several real slider gestures to arrive
  // before the first save finishes. Serialized saves must retain the last
  // gesture and reuse each acknowledged content version, rather than collide.
  await targetPage.getByRole('button', { name: `${importedChannel.name} — presentation`, exact: true }).click();
  const music = targetPage.locator('.music-mini-player:visible'), volume = music.getByRole('slider');
  await volume.waitFor();
  const volumeResponses = []; let activeSaves = 0;
  const savePattern = `${target.base}/api/content`;
  const delaySaveResponse = async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    activeSaves++;
    try {
      const response = await route.fetch();
      volumeResponses.push({ status: response.status(), volume: route.request().postDataJSON().music.volume });
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ response });
    } finally { activeSaves--; }
  };
  await targetPage.route(savePattern, delaySaveResponse);
  try {
    const slider = music.locator('[data-slot="slider"]'), bounds = await slider.boundingBox();
    assert.ok(bounds); const y = bounds.y + bounds.height / 2;
    await targetPage.mouse.move(bounds.x + bounds.width * .2, y); await targetPage.mouse.down();
    for (const fraction of [.3, .4, .5, .6, .7, .8, .9]) await targetPage.mouse.move(bounds.x + bounds.width * fraction, y);
    await targetPage.mouse.up(); await volume.focus(); await volume.press('End');
    await until(async () => volumeResponses.length >= 4 && activeSaves === 0 && volumeResponses.at(-1).volume === 1
      && (await volume.getAttribute('aria-valuenow')) === '1' && (await json(target, 'content')).music.volume === 1, 'rapid music volume changes finish in order');
  } finally { await targetPage.unroute(savePattern, delaySaveResponse); }
  assert.ok(volumeResponses.length >= 4, 'Several independent slider updates exercised the save queue');
  assert.ok(volumeResponses.every(value => value.status === 200), `Rapid local edits must not conflict: ${JSON.stringify(volumeResponses)}`);
  const afterVolume = await json(target, 'content');
  assert.equal(afterVolume.music.volume, 1); assert.equal(afterVolume.music.mode, 'off');
  assert.deepEqual(afterVolume.settings, originalContent.settings);
  assert.deepEqual(afterVolume.playlists, currentContent.playlists, 'Rapid volume saves retain imported presentations');
  await targetPage.screenshot({ path: path.join(artifacts, 'rapid-volume-saved.png'), fullPage: true });
  checks.push('Rapid real music-slider gestures persist the final volume through serialized saves with no 409 conflicts');

  assert.deepEqual(await json(target, 'studio'), originalStudio);
  assert.deepEqual(await json(target, 'worship/channels/local_lyrics'), originalWorkspace);
  // Exercise the additional portable categories and native file download with
  // real, tiny synthetic video. No copyrighted media or operator files enter.
  await sourceDialog.getByTestId('transfer-select-all').click();
  await sourceDialog.getByTestId('transfer-category-recordings').click();
  assert.equal(await sourceDialog.getByTestId('transfer-item-recordings-rec_portable').isChecked(), true);
  await sourceDialog.getByTestId('transfer-category-clips').click();
  assert.equal(await sourceDialog.getByTestId('transfer-item-clips-clip_portable').isChecked(), true);
  await sourceDialog.getByTestId('transfer-clear-all').click();
  for (const [category, id] of [['scenes', 'portable_scene'], ['setlists', 'portable_setlist'], ['clips', 'clip_portable']]) await selectItem(sourceDialog, category, id, true);
  const extendedDownloadReady = sourcePage.waitForEvent('download');
  await sourceDialog.getByTestId('transfer-export').click();
  const extendedDownload = await extendedDownloadReady, extendedArchive = path.join(artifacts, 'portable-production.lumen');
  await extendedDownload.saveAs(extendedArchive); assert.equal(await extendedDownload.failure(), null);

  await targetPage.goto(`${target.base}/recordings`);
  await targetPage.getByRole('heading', { name: 'All recordings', exact: true }).waitFor();
  const recordingDocument = await targetPage.evaluate(() => { window.__recordingDocument = Math.random(); return window.__recordingDocument; });
  const extendedDialog = await openTransfer(targetPage), extendedPreview = await uploadPreview(target, extendedDialog, extendedArchive);
  assert.deepEqual(extendedPreview.catalog.scenes.map(value => value.id), ['portable_scene']);
  assert.deepEqual(extendedPreview.catalog.clips.map(value => value.id), ['clip_portable']);
  assert.deepEqual(extendedPreview.catalog.recordings.map(value => value.id), ['rec_portable']);
  assert.deepEqual(extendedPreview.catalog.setlists.map(value => value.id), ['portable_setlist']);
  assert.deepEqual(extendedPreview.catalog.songs.map(value => value.id), [songTwo.id]);
  await extendedDialog.getByTestId('transfer-clear-all').click();
  for (const [category, id] of [['scenes', 'portable_scene'], ['setlists', 'portable_setlist'], ['clips', 'clip_portable']]) await selectItem(extendedDialog, category, id, true);
  const extendedOffset = await targetPage.evaluate(() => window.__transferResponses.length);
  await extendedDialog.getByTestId('transfer-import').click();
  const extendedResult = await capturedResponse(targetPage, 'import', extendedOffset);
  for (const category of ['scenes', 'recordings', 'setlists', 'clips', 'presentations', 'songs']) assert.equal(extendedResult.imported[category], 1, `Imported ${category}`);
  assert.equal(extendedResult.imported.settings, 0);
  await extendedDialog.getByTestId('transfer-result').waitFor();
  await extendedDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await targetPage.getByRole('heading', { name: 'Portable synthetic recording', exact: true }).waitFor();
  assert.equal(await targetPage.evaluate(() => window.__recordingDocument), recordingDocument, 'Open Recordings refreshes after import without navigation');
  const importedProduction = await json(target, 'studio'), importedClips = await json(target, 'clips'), extendedContent = await json(target, 'content');
  const importedScene = importedProduction.scenes.find(value => value.name === 'Portable studio scene');
  const importedRecording = importedClips.recordings.find(value => value.name === 'Portable synthetic recording');
  const importedDraft = importedClips.drafts.find(value => value.name === 'Portable clip project');
  const importedExport = importedClips.exports.find(value => value.name === 'Portable completed clip');
  const importedSetlistChannel = extendedContent.channels.find(value => value.name === 'Portable worship order');
  assert.ok(importedScene && importedRecording && importedDraft && importedExport && importedSetlistChannel);
  assert.notEqual(importedScene.id, 'portable_scene'); assert.notEqual(importedRecording.id, 'rec_portable'); assert.notEqual(importedDraft.id, 'clip_portable');
  assert.equal(importedDraft.recordingId, importedRecording.id); assert.equal(importedExport.draftId, importedDraft.id);
  assert.equal(importedExport.recordingId, importedRecording.id); assert.equal(importedDraft.canEdit, true);
  const importedSetlist = await json(target, `worship/channels/${importedSetlistChannel.id}`);
  assert.deepEqual(importedSetlist.setlist, [songTwo.id]); assert.equal(importedSetlist.versionId, 'SPAN'); assert.equal(importedSetlist.live, null);
  const transferredRecording = await target.request.get(`${target.base}/api/studio/recordings/${importedRecording.id}/download`);
  assert.equal(transferredRecording.status(), 200); assert.deepEqual(await transferredRecording.body(), await fs.readFile(path.join(source.dir, 'recordings/rec_portable/recording.webm')));
  for (const field of ['program', 'programTransition', 'outputs', 'previewSceneId', 'masterVolume', 'masterMuted']) assert.deepEqual(importedProduction[field], originalStudio[field], `New scenes preserve ${field}`);
  await targetPage.screenshot({ path: path.join(artifacts, 'recordings-import-refreshed.png'), fullPage: true });
  checks.push('Scenes, setlists, clip projects, completed exports and dependent original recordings transfer as remapped copies; Recordings refreshes and Program remains unchanged');

  // Clearing is a separate admin-only, reviewed operation. A recording still
  // required by a retained clip project must block even with typed approval.
  const clearDialog = await openTransfer(targetPage);
  await clearDialog.getByTestId('transfer-clear-tab').click();
  await clearDialog.getByTestId('transfer-category-recordings').waitFor();
  assert.equal(await clearDialog.getByTestId('transfer-clear-review').isEnabled(), false, 'Clear starts with nothing selected');
  await selectItem(clearDialog, 'recordings', importedRecording.id, true);
  const blockedOffset = await targetPage.evaluate(() => window.__transferResponses.length);
  await clearDialog.getByTestId('transfer-clear-review').click();
  const blockedReview = await capturedResponse(targetPage, 'clear/preview', blockedOffset);
  assert.ok(blockedReview.blockers.length, 'A retained clip dependency blocks its recording removal');
  await clearDialog.getByTestId('transfer-clear-blockers').waitFor();
  assert.equal(await clearDialog.getByTestId('transfer-clear-apply').isEnabled(), false);
  assert.equal((await json(target, 'clips')).recordings.length, importedClips.recordings.length);
  const clearDiscard = targetPage.waitForResponse(value => value.request().method() === 'DELETE' && value.url().endsWith(`/api/data-transfer/clear/preview/${blockedReview.token}`));
  await clearDialog.getByTestId('transfer-clear-back').click();
  assert.equal((await clearDiscard).status(), 204, 'Leaving Clear review removes its token');
  for (const [category, id] of [['clips', importedDraft.id], ['scenes', importedScene.id], ['setlists', importedSetlistChannel.id], ['songs', songTwo.id]]) await selectItem(clearDialog, category, id, true);
  const clearOffset = await targetPage.evaluate(() => window.__transferResponses.length);
  await clearDialog.getByTestId('transfer-clear-review').click();
  const clearPlan = await capturedResponse(targetPage, 'clear/preview', clearOffset);
  assert.deepEqual(clearPlan.blockers, []); assert.equal(clearPlan.counts.recordings, 1); assert.equal(clearPlan.counts.clips, 1);
  await clearDialog.getByTestId('transfer-clear-confirmation').waitFor();
  assert.equal(await clearDialog.getByTestId('transfer-clear-apply').isEnabled(), false);
  await clearDialog.getByTestId('transfer-clear-confirmation').fill('clear');
  assert.equal(await clearDialog.getByTestId('transfer-clear-apply').isEnabled(), false, 'Confirmation is exactly CLEAR');
  await targetPage.setViewportSize({ width: 390, height: 844 });
  await clearDialog.getByTestId('transfer-clear-confirmation').fill('CLEAR');
  await clearDialog.getByTestId('transfer-clear-apply').scrollIntoViewIfNeeded();
  const clearBox = await clearDialog.boundingBox(); assert.ok(clearBox && clearBox.x >= -1 && clearBox.x + clearBox.width <= 391, 'Clear review fits mobile');
  await targetPage.screenshot({ path: path.join(artifacts, 'clear-reviewed-mobile.png'), fullPage: true });
  const appliedOffset = await targetPage.evaluate(() => window.__transferResponses.length);
  await clearDialog.getByTestId('transfer-clear-apply').click();
  const cleared = await capturedResponse(targetPage, 'clear', appliedOffset);
  for (const category of ['scenes', 'recordings', 'setlists', 'clips', 'songs']) assert.equal(cleared.removed[category], 1, `Cleared selected ${category}`);
  assert.ok(cleared.backupPath.startsWith(target.dir + path.sep)); await fs.stat(cleared.backupPath);
  await clearDialog.getByTestId('transfer-clear-result').waitFor();
  await clearDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await until(async () => (await targetPage.getByRole('heading', { name: 'Portable synthetic recording', exact: true }).count()) === 0, 'Recordings refreshes after clear');
  assert.equal(await targetPage.evaluate(() => window.__recordingDocument), recordingDocument);
  const afterClearClips = await json(target, 'clips'), afterClearStudio = await json(target, 'studio');
  assert.equal(afterClearClips.recordings.some(value => value.id === importedRecording.id), false);
  assert.equal(afterClearClips.drafts.some(value => value.id === importedDraft.id), false); assert.equal(afterClearClips.exports.some(value => value.id === importedExport.id), false);
  assert.equal(afterClearStudio.scenes.some(value => value.id === importedScene.id), false);
  assert.deepEqual((await json(target, 'worship/songs')).map(value => value.id).sort(), [retainedSong.id, songOne.id].sort());
  assert.deepEqual(await json(target, 'worship/channels/local_lyrics'), originalWorkspace);
  for (const field of ['program', 'programTransition', 'outputs']) assert.deepEqual(afterClearStudio[field], originalStudio[field]);
  assert.equal(takes.length, 0);
  await targetPage.setViewportSize({ width: 1512, height: 982 });
  checks.push('Clear starts empty, reviews dependencies, blocks retained references, requires exact typed CLEAR, creates backup, removes only selected data and refreshes the open library');

  // The music store holds an off-DOM Audio element. Clearing its queued file
  // must release that element, while a retained track remains playable.
  const wave = Buffer.alloc(44 + 8_000 * 60 * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8_000, 24); wave.writeUInt32LE(16_000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  const clearAudioFile = path.join(artifacts, 'selected-audio.wav'), keepAudioFile = path.join(artifacts, 'retained-audio.wav');
  await fs.writeFile(clearAudioFile, wave); await fs.writeFile(keepAudioFile, wave);
  await targetPage.goto(target.base);
  await targetPage.getByRole('button', { name: `${importedChannel.name} — presentation`, exact: true }).click();
  const audioPlayer = targetPage.locator('.music-mini-player:visible');
  await audioPlayer.getByTitle('Open queue', { exact: true }).click();
  const queuePopover = targetPage.locator('[data-slot="popover-content"]:visible').filter({ has: targetPage.getByRole('heading', { name: 'Music queue', exact: true }) });
  await queuePopover.locator('input[type=file]').setInputFiles([clearAudioFile, keepAudioFile]);
  const queuedMusic = await until(async () => { const music = (await json(target, 'content')).music; return music.queue.length === 2 ? music : null; }, 'two synthetic tracks finish uploading');
  const selectedAudio = queuedMusic.queue.find(value => value.endsWith('-selected-audio.wav')), retainedAudio = queuedMusic.queue.find(value => value.endsWith('-retained-audio.wav'));
  assert.ok(selectedAudio && retainedAudio);
  await queuePopover.getByRole('button', { name: 'Playlist', exact: true }).click();
  await until(async () => (await json(target, 'content')).music.mode === 'playlist', 'playlist mode saves');
  await targetPage.keyboard.press('Escape');
  await audioPlayer.getByTitle('Play', { exact: true }).click();
  await until(() => targetPage.evaluate(selected => {
    const element = window.__observedAudio.find(audio => audio.currentSrc.endsWith(selected));
    if (!element || element.paused) return false;
    window.__clearedAudioElement = element; return true;
  }, selectedAudio), 'selected queued audio is playing');
  await audioPlayer.getByTitle('Pause', { exact: true }).waitFor();
  const audioClearDialog = await openTransfer(targetPage);
  await audioClearDialog.getByTestId('transfer-clear-tab').click();
  await selectItem(audioClearDialog, 'media', selectedAudio, true);
  const audioReviewOffset = await targetPage.evaluate(() => window.__transferResponses.length);
  await audioClearDialog.getByTestId('transfer-clear-review').click();
  const audioReview = await capturedResponse(targetPage, 'clear/preview', audioReviewOffset);
  assert.deepEqual(audioReview.blockers, []); assert.ok(audioReview.warnings.some(value => /audio.*queue|playback.*stop/i.test(value)));
  await audioClearDialog.getByTestId('transfer-clear-confirmation').fill('CLEAR');
  const audioApplyOffset = await targetPage.evaluate(() => window.__transferResponses.length);
  await audioClearDialog.getByTestId('transfer-clear-apply').click();
  const audioCleared = await capturedResponse(targetPage, 'clear', audioApplyOffset); assert.equal(audioCleared.removed.media, 1);
  await audioClearDialog.getByTestId('transfer-clear-result').waitFor();
  await audioClearDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await until(() => targetPage.evaluate(() => window.__clearedAudioElement?.paused && window.__clearedAudioElement.getAttribute('src') === null), 'clearing releases the removed Audio source');
  const afterAudioClear = (await json(target, 'content')).music;
  assert.deepEqual(afterAudioClear.queue, [retainedAudio]); assert.equal(afterAudioClear.current, undefined); assert.equal(afterAudioClear.mode, 'off');
  assert.equal(await audioPlayer.getByTitle('Play', { exact: true }).isEnabled(), false);
  await fs.stat(path.join(target.dir, retainedAudio)); await assert.rejects(fs.stat(path.join(target.dir, selectedAudio)), { code: 'ENOENT' });
  let removedTrackReloads = 0;
  const observeRemovedReload = request => { if (new URL(request.url()).pathname === `/${selectedAudio}`) removedTrackReloads++; };
  targetPage.on('request', observeRemovedReload);
  await audioPlayer.getByTitle('Open queue', { exact: true }).click();
  await queuePopover.getByRole('button', { name: 'Playlist', exact: true }).click();
  await until(async () => (await json(target, 'content')).music.mode === 'playlist', 'retained queue mode saves');
  await targetPage.keyboard.press('Escape'); await audioPlayer.getByTitle('Play', { exact: true }).click();
  await until(() => targetPage.evaluate(retained => window.__clearedAudioElement?.currentSrc.endsWith(retained) && !window.__clearedAudioElement.paused, retainedAudio), 'Play uses retained audio after clear');
  assert.equal(removedTrackReloads, 0, 'Play cannot resurrect the removed cached audio');
  targetPage.off('request', observeRemovedReload);
  await audioPlayer.getByTitle('Open queue', { exact: true }).click();
  await queuePopover.getByRole('button', { name: 'Off', exact: true }).click(); await targetPage.keyboard.press('Escape');
  await until(() => targetPage.evaluate(() => window.__clearedAudioElement?.paused), 'synthetic audio playback stops at test end');
  checks.push('Clearing selected playing audio removes it from the queue, releases its Audio source, retains other tracks, and Play loads the retained track without resurrecting deleted media');

  assert.deepEqual(errors, []); assert.equal(takes.length, 0);
  console.log(JSON.stringify({ checks, pageErrors: errors.length, implicitTakes: takes.length, artifacts }, null, 2));
} catch (error) {
  for (const [name, current] of [['source', sourcePage], ['target', targetPage]]) await current?.screenshot({ path: path.join(artifacts, `${name}-failure.png`), fullPage: true }).catch(() => {});
  console.error(error);
  for (const station of stations) console.error(`${station.base}\n${station.logs.slice(-2500)}`);
  console.error(`Artifacts: ${artifacts}`); process.exitCode = 1;
} finally {
  await browser?.close();
  await Promise.all(stations.map(async ({ server }) => {
    if (server.exitCode !== null || server.signalCode) return;
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
    let timer;
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 6000); })]); }
    finally { clearTimeout(timer); }
  }));
}
