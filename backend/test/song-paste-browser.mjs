// Exercise the operator and audience in separate tabs on a disposable station.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-song-paste-'));
const port = await new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const port = listener.address().port;
    listener.close(() => resolve(port));
  });
});
const base = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '',
  browser,
  passed = false;
for (const pipe of [server.stdout, server.stderr])
  pipe.on('data', (chunk) => {
    logs = (logs + chunk).slice(-5000);
  });
async function until(check, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  throw new Error('Timed out waiting for ' + message);
}
async function json(response) {
  assert.ok(response.ok(), await response.text());
  return response.json();
}
try {
  await until(async () => (await fetch(base + '/api/content').catch(() => null))?.ok, 'temporary station startup');
  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.LUMEN_CHROME_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const api = context.request,
    errors = [],
    commands = [];
  await json(await api.post(base + '/api/auth/login', { data: { username: 'admin', password: 'admin' } }));
  await json(
    await api.put(base + '/api/content', {
      data: {
        version: 2,
        updatedAt: new Date().toISOString(),
        settings: { transitionMs: 0 },
        music: { mode: 'off' },
        channels: [{ id: 'lyrics', name: 'Lyrics', kind: 'lyrics', playlistId: 'archive', defaultMode: 'manual' }],
        playlists: [{ id: 'archive', name: 'Slides', items: [] }],
      },
    }),
  );
  const songsUrl = base + '/api/worship/songs',
    channel = base + '/api/worship/channels/lyrics';
  const workspace = async () => json(await api.get(channel));
  const command = async (value) =>
    json(await api.post(channel + '/command', { data: { revision: (await workspace()).revision, command: value } }));
  const list = async () => json(await api.get(songsUrl));
  const readSong = async (id) => json(await api.get(songsUrl + '/' + id));
  const old = await json(
    await api.post(songsUrl, {
      data: {
        title: 'Opening hymn',
        sections: [
          { id: 'opening', label: 'Verse 1', text: 'The opening line remains on screen' },
          { id: 'prepared', label: 'Verse 2', text: 'This verse is ready for later' },
        ],
      },
    }),
  );
  await command({ type: 'setlist', songIds: [old.id] });
  await command({ type: 'theme', theme: { background: '#223644', color: '#ffeebb', align: 'left', size: 'xl' } });
  const initial = await command({ type: 'take', selection: { kind: 'lyrics', songId: old.id, sectionId: 'opening' } });
  const page = await context.newPage(),
    projector = await context.newPage();
  for (const tab of [page, projector]) tab.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url() === channel + '/command') commands.push(req.postDataJSON().command);
  });
  await page.goto(base);
  await page.getByRole('heading', { name: 'Find a song' }).waitFor();
  await projector.goto(base + '/live/lyrics');
  const audience = projector.locator('.cue-canvas:visible').last();
  async function screenIs(canvas, text, reference) {
    await until(
      async () =>
        (await canvas.count()) &&
        (await canvas.locator('.cue-body').textContent()) === text &&
        (await canvas.locator('.cue-reference').textContent()) === reference,
      'audience lyrics and section name',
    );
  }
  await screenIs(audience, old.sections[0].text, 'Verse 1');
  await page.getByRole('option').filter({ hasText: old.title }).click();
  await page.locator('.w-section-cue').filter({ hasText: old.sections[1].text }).click();
  const prepared = page.getByTestId('prepared-cue');
  const heldText = prepared.getByText(old.sections[1].text, { exact: true });
  await heldText.waitFor();
  const dialog = page.getByRole('dialog'),
    open = async () => {
      await page.getByRole('button', { name: 'New song', exact: true }).click();
      await dialog.waitFor();
    };
  const field = (label) => dialog.getByLabel(label, { exact: true }),
    button = (label) => dialog.getByRole('button', { name: label, exact: true });
  const preview = dialog.locator('.cue-canvas');
  const checkPrivate = async () => {
    assert.deepEqual(commands, [], 'Working in the library cannot send a channel command');
    assert.deepEqual(await workspace(), initial, 'The setlist and live cue are unchanged');
    await screenIs(audience, old.sections[0].text, 'Verse 1');
  };

  await open();
  await field('Song title').fill('Discarded draft');
  await field('Lyrics').fill('A private rehearsal');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await list()).length, 1);
  await checkPrivate();

  const title = 'Evening Rehearsal',
    verse = 'Through the open doors\nWe gather with our song',
    chorus = 'Evening voices carry\nA quiet song of thanks';
  await open();
  await field('Song title').fill(title);
  assert.equal(await button('Add to library').isDisabled(), true);
  await field('Lyrics').fill('[Verse 1]\r\n' + verse + '\r\n \t\r\n[Chorus]\n' + chorus + '\n\nOne last line');
  const split = field('New section at'),
    show = field('Show section names on screen');
  const next = button('Next section'),
    previous = button('Previous section');
  assert.equal(await show.isChecked(), false);
  assert.equal(await previous.isDisabled(), true);
  await screenIs(preview, verse, '');
  await split.selectOption({ label: 'Every line' });
  await screenIs(preview, 'Through the open doors', '');
  await next.click();
  await screenIs(preview, 'We gather with our song', '');
  await split.selectOption({ label: 'Blank line' });
  if (await previous.isEnabled()) await previous.click();
  await next.click();
  await show.check();
  await screenIs(preview, chorus, 'Chorus');
  await field('Section name').fill('Response');
  await screenIs(preview, chorus, 'Response');
  await split.selectOption({ label: 'Every line' });
  await split.selectOption({ label: 'Blank line' });
  for (let i = 0; i < 2 && (await previous.isEnabled()); i++) await previous.click();
  assert.equal(await previous.isDisabled(), true);
  await next.click();
  await screenIs(preview, chorus, 'Response');
  await next.click();
  await screenIs(preview, 'One last line', '');
  assert.equal(await next.isDisabled(), true);
  await previous.click();
  await screenIs(preview, chorus, 'Response');
  await show.uncheck();
  await screenIs(preview, chorus, '');
  await dialog.getByText('Credits', { exact: true }).click();
  await field('Writer / artist').fill('Lumen rehearsal team');
  await field('Copyright / licence credit').fill('Original rehearsal lyrics');
  const colors = (canvas) =>
    canvas.evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
      align: getComputedStyle(el).textAlign,
    }));
  const appearance = await colors(preview);
  await page.keyboard.press('Control+Enter');
  await checkPrivate();
  assert.equal((await list()).length, 1, 'No song is added during rehearsal');
  await page.setViewportSize({ width: 390, height: 780 });
  assert.ok(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    'Narrow song dialog fits horizontally',
  );
  await page.setViewportSize({ width: 1360, height: 900 });
  await button('Add to library').click();
  await dialog.waitFor({ state: 'hidden' });
  const saved = (await list()).find((song) => song.title === title);
  assert.ok(saved);
  assert.equal(saved.showSectionLabels, false);
  assert.equal(saved.author, 'Lumen rehearsal team');
  assert.equal(saved.copyright, 'Original rehearsal lyrics');
  assert.deepEqual(
    saved.sections.map((s) => [s.label, s.text]),
    [
      ['Verse 1', verse],
      ['Response', chorus],
      ['', 'One last line'],
    ],
  );
  assert.equal(new Set(saved.sections.map((s) => s.id)).size, 3);
  await checkPrivate();
  await heldText.waitFor();

  await page.reload();
  const row = page.getByRole('option').filter({ hasText: title });
  await row.click();
  const section = page.locator('.w-section-cue').filter({ hasText: 'Response' });
  await section.click();
  await checkPrivate();
  const send = page.getByRole('button', { name: 'Send live', exact: true });
  await send.click();
  await screenIs(audience, chorus, '');
  assert.deepEqual(await colors(audience), appearance, 'Projection and rehearsal use the same cue appearance');
  const firstTake = await workspace();
  assert.deepEqual(firstTake.live.selection, { kind: 'lyrics', songId: saved.id, sectionId: saved.sections[1].id });
  assert.deepEqual(firstTake.setlist, initial.setlist);
  assert.equal(commands.length, 1);

  const editBaseline = await command({ type: 'setlist', songIds: [old.id, saved.id] });
  const edit = async () => {
    await page.getByRole('button', { name: 'Edit selected song', exact: true }).click();
    await dialog.waitFor();
  };
  const checkEditPrivate = async () => {
    assert.equal(commands.length, 1, 'Editing cannot send a channel command');
    assert.deepEqual(await workspace(), editBaseline, 'Editing preserves the setlist and the song’s current live snapshot');
    await screenIs(audience, chorus, '');
  };

  await edit();
  assert.equal(await field('Song title').inputValue(), title);
  const existingLyrics = await field('Lyrics').inputValue();
  assert.ok(existingLyrics.includes(verse));
  assert.ok(existingLyrics.includes(chorus));
  assert.ok(existingLyrics.includes('One last line'));
  assert.equal(await split.inputValue(), 'blank');
  assert.equal(await show.isChecked(), false);
  assert.equal(await field('Section name').inputValue(), 'Verse 1');
  await screenIs(preview, verse, '');
  await next.click();
  assert.equal(await field('Section name').inputValue(), 'Response');
  await screenIs(preview, chorus, '');
  await next.click();
  assert.equal(await field('Section name').inputValue(), '');
  await screenIs(preview, 'One last line', '');
  await dialog.getByText('Credits', { exact: true }).click();
  assert.equal(await field('Writer / artist').inputValue(), saved.author);
  assert.equal(await field('Copyright / licence credit').inputValue(), saved.copyright);
  await button('Save song').click();
  await dialog.waitFor({ state: 'hidden' });
  const unchanged = await readSong(saved.id);
  assert.deepEqual(unchanged.sections, saved.sections, 'Opening and saving preserves section boundaries and IDs');
  assert.equal(unchanged.author, saved.author);
  assert.equal(unchanged.copyright, saved.copyright);
  assert.equal(unchanged.showSectionLabels, false);
  assert.equal(unchanged.revision, saved.revision + 1);
  await prepared.getByText(chorus, { exact: true }).waitFor();
  await checkEditPrivate();

  await edit();
  const revisedChorus = chorus.replace('Evening voices carry', 'Evening voices rise');
  const lyricsWithRevisedChorus = existingLyrics.replace(chorus, revisedChorus);
  await field('Lyrics').fill(lyricsWithRevisedChorus);
  await button('Save song').click();
  await dialog.waitFor({ state: 'hidden' });
  const revised = await readSong(saved.id);
  assert.equal(revised.sections[1].id, saved.sections[1].id, 'Editing a section in place preserves its ID');
  assert.equal(revised.sections[1].text, revisedChorus);
  await prepared.getByText(revisedChorus, { exact: true }).waitFor();
  await checkEditPrivate();

  await edit();
  await field('Lyrics').fill('Discard this replacement');
  await split.selectOption({ label: 'Every line' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await readSong(saved.id), revised, 'Cancelling an edit preserves the stored song');
  await checkEditPrivate();

  await edit();
  assert.equal(await field('Lyrics').inputValue(), lyricsWithRevisedChorus);
  assert.equal(await split.inputValue(), 'blank');
  const revisedFirstLine = 'Through the open doors together';
  await field('Lyrics').fill('[Verse 1]\n' + revisedFirstLine + '\nWe gather with our song\n\n[Response]\n' + chorus + '\n\nOne last line');
  await split.selectOption({ label: 'Every line' });
  await screenIs(preview, revisedFirstLine, '');
  await field('Section name').fill('Opening');
  await show.check();
  await screenIs(preview, revisedFirstLine, 'Opening');
  await next.click();
  await screenIs(preview, 'We gather with our song', 'Verse 1');
  await next.click();
  await screenIs(preview, 'Evening voices carry', 'Response');
  await checkEditPrivate();
  await button('Save song').click();
  await dialog.waitFor({ state: 'hidden' });
  const edited = await readSong(saved.id);
  assert.equal((await list()).length, 2, 'Editing updates the song rather than adding a duplicate');
  assert.equal(edited.id, saved.id);
  assert.equal(edited.author, saved.author);
  assert.equal(edited.copyright, saved.copyright);
  assert.equal(edited.showSectionLabels, true);
  assert.equal(edited.revision, revised.revision + 1);
  assert.deepEqual(edited.sections.map((s) => [s.label, s.text]), [
    ['Opening', revisedFirstLine],
    ['Verse 1', 'We gather with our song'],
    ['Response', 'Evening voices carry'],
    ['Response', 'A quiet song of thanks'],
    ['', 'One last line'],
  ]);
  assert.equal(new Set(edited.sections.map((s) => s.id)).size, 5);
  await prepared.getByText(revisedFirstLine, { exact: true }).waitFor();
  await checkEditPrivate();

  // Saved split boundaries are loaded as blocks, so simply reopening and saving
  // cannot merge two adjacent sections that happen to have the same label.
  await edit();
  await screenIs(preview, revisedFirstLine, 'Opening');
  await next.click();
  await screenIs(preview, 'We gather with our song', 'Verse 1');
  await next.click();
  await screenIs(preview, 'Evening voices carry', 'Response');
  await next.click();
  await screenIs(preview, 'A quiet song of thanks', 'Response');
  await button('Save song').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual((await readSong(saved.id)).sections, edited.sections);
  await checkEditPrivate();

  await page.locator('.w-section-cue').filter({ hasText: 'Evening voices carry' }).click();
  await send.click();
  await screenIs(audience, 'Evening voices carry', 'Response');
  assert.equal(commands.length, 2);
  assert.deepEqual((await workspace()).setlist, [old.id, saved.id]);
  assert.deepEqual(errors, []);
  console.log(
    'Passed: whole-song paste and edit, split modes, stepping, labels, credits, cancel, stable IDs, setlist and live isolation, reload and explicit live projection.',
  );
  passed = true;
} catch (error) {
  console.error(error, logs, 'Station fixture:', directory);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  if (passed) await fs.rm(directory, { recursive: true, force: true });
}
