// Range UI regression on a disposable station. Uses synthetic joined text;
// never opens the operator's library, starts an engine, or sends content live.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-scripture-ranges-'));
process.env.LUMEN_DATA_DIR = dir;
const { WorshipLibrary } = await import('../dist/worship-library.js');
const joined = 'Silver lanterns illuminate the courtyard while curious travelers gather beside the ancient fountain.';
const seed = new WorshipLibrary(path.join(dir, 'worship.db'));
try {
  seed.importBible({ version: { id: 'SPAN', name: 'Synthetic range edition', language: 'en', attribution: 'Synthetic fixtures' }, verses: [
    { book: 43, chapter: 3, verse: 1, text: 'Existing live synthetic paragraph.' },
    { book: 43, chapter: 3, verse: 2, endVerse: 4, text: joined },
    { book: 43, chapter: 3, verse: 5, text: 'Last synthetic paragraph.' },
  ] });
  seed.command('scripture', 0, { type: 'take', selection: { kind: 'scripture', versionId: 'SPAN', book: 43, chapter: 3, verse: 1 } });
} finally { seed.close(); }
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
let browser, page, server, logs = '';
const errors = [], takes = [], checks = [];
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'disposable station startup', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const saved = await request.put(`${base}/api/content`, { data: {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [{ id: 'scripture', name: 'Scripture', kind: 'scripture', playlistId: 'p_scripture', defaultMode: 'manual' }],
    playlists: [{ id: 'p_scripture', name: 'Scripture archive', items: [] }],
  } });
  assert.equal(saved.status(), 200, await saved.text());
  const workspace = async () => (await request.get(`${base}/api/worship/channels/scripture`)).json();
  const production = async () => (await request.get(`${base}/api/studio`)).json();
  const original = await workspace(), originalStudio = await production();
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/worship/channels/scripture/command') && request.postDataJSON().command?.type === 'take') takes.push(request);
  });
  await page.goto(base); await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  const input = page.getByLabel('Search scripture', { exact: true }), rows = page.locator('.w-verse-result');
  const prepared = page.getByTestId('prepared-cue'), send = page.getByRole('button', { name: 'Send live', exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function search(query, version = 'SPAN') {
    const ready = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/worship/scripture' && url.searchParams.get('q') === query && url.searchParams.get('version') === version;
    });
    await input.fill(query); assert.equal((await ready).status(), 200);
    await until(() => page.locator('.w-search-box .w-spin').count().then(n => n === 0), 'search settled'); await settle();
  }
  async function preview(action, reference, expectedSelection, expectedText) {
    const ready = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/worship/preview'));
    await action(); const response = await ready; assert.equal(response.status(), 200);
    const cue = await response.json();
    assert.deepEqual(cue.selection, expectedSelection); assert.equal(cue.reference, reference);
    if (expectedText) assert.equal(cue.text, expectedText);
    await until(async () => await send.isEnabled() && (await prepared.innerText()).includes(reference), `prepared ${reference}`);
    return cue;
  }
  async function remainsPrivate(label) {
    await settle(); const current = await workspace();
    assert.deepEqual(current.live, original.live, `${label}: live snapshot is unchanged`);
    assert.equal(current.blanked, original.blanked); assert.equal(takes.length, 0, `${label}: no implicit take`);
    assert.deepEqual(await production(), originalStudio, `${label}: Studio is unchanged`);
  }
  const span = { kind: 'scripture', versionId: 'SPAN', book: 43, chapter: 3, verse: 2, endVerse: 4 };
  await search('John 3:3');
  assert.equal(await rows.count(), 1); assert.ok((await rows.first().innerText()).includes('John 3:2–4'));
  await remainsPrivate('Interior reference search');
  await preview(() => rows.first().click(), 'John 3:2–4 · SPAN', span, joined);
  await remainsPrivate('Single click');
  await search('John 3:4');
  await preview(() => input.press('Enter'), 'John 3:2–4 · SPAN', span, joined);
  await remainsPrivate('Enter');
  checks.push('Interior references show the full source range; click and Enter prepare that range without publishing');

  await search('John 3:3-5');
  assert.equal(await rows.count(), 2);
  const passageButton = page.getByRole('button', { name: 'Prepare passage', exact: true });
  await passageButton.waitFor();
  const cue = await preview(() => passageButton.click(), 'John 3:2–5 · SPAN', { ...span, endVerse: 5 }, `2–4 ${joined}\n\n5 Last synthetic paragraph.`);
  assert.equal(cue.text.split(joined).length - 1, 1);
  assert.equal((await prepared.innerText()).split(joined).length - 1, 1);
  await remainsPrivate('Joined passage preparation');
  await page.screenshot({ path: path.join(dir, 'joined-passage.png'), fullPage: true });
  checks.push('A range across joined and single verses offers Prepare passage and displays the joined prose once');

  await page.getByLabel('Bible version', { exact: true }).selectOption('KJV');
  await until(async () => (await workspace()).versionId === 'KJV', 'KJV version selected');
  await search('John 3:16', 'KJV');
  assert.equal(await rows.count(), 1); assert.ok((await rows.first().innerText()).includes('John 3:16'));
  const kjv = await preview(() => input.press('Enter'), 'John 3:16 · KJV', { kind: 'scripture', versionId: 'KJV', book: 43, chapter: 3, verse: 16 });
  assert.match(kjv.text, /^For God so loved the world/); assert.equal(kjv.selection.endVerse, undefined);
  await remainsPrivate('Ordinary KJV preparation');
  checks.push('Ordinary KJV single-verse search and preparation remain unchanged');
  assert.deepEqual(errors, []);
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state, 'offline');
  console.log(JSON.stringify({ checks, takes: takes.length, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-4000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
