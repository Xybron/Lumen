// Real click/double-click regression on a disposable station. No engine, media
// devices, recordings, or operator data are used. Scripture owns content only;
// even when it is part of Program, publishing must not take or route a scene.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-scripture-doubleclick-'));
const port = Number(process.env.LUMEN_SCRIPTURE_DOUBLECLICK_TEST_PORT ?? 3444);
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
  // Meaningful non-default audio, Program and pinned-output state makes a stray
  // auto-take, mixer mutation, or route write observable by deep equality.
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
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/worship/preview')) previews.push(request);
    if (request.url().endsWith('/api/worship/channels/scripture/command') && request.postDataJSON().command?.type === 'take') takes.push(request);
  });
  await page.goto(base); await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const send = page.getByRole('button', { name: 'Send live', exact: true });
  const dock = page.getByRole('navigation', { name: 'Channel toolbar', exact: true });
  const row = verse => page.locator('.w-verse-result').nth(verse - 1);
  async function chapter() {
    await page.getByLabel('Search scripture', { exact: true }).fill('John 3');
    await until(() => page.locator('.w-verse-result').count().then(value => value === 36), 'all John 3 results');
  }
  async function prepared(verse) {
    await until(async () => await send.isEnabled() && (await page.getByTestId('prepared-cue').textContent()).includes(`John 3:${verse} · KJV`), `prepared exact verse ${verse}`);
  }
  async function live(verse, waitForProof = true) {
    await until(async () => { const next = await workspace(); return !next.blanked && next.live?.selection.verse === verse; }, `channel live exact verse ${verse}`);
    if (waitForProof) await until(() => send.isEnabled(), 'publication finishes');
    await settle();
  }
  async function noLatePublication(label, before, takeCount) {
    await settle(); await page.waitForTimeout(160);
    assert.deepEqual(await workspace(), before, `${label}: late preparation cannot mutate channel live state`);
    assert.equal(takes.length, takeCount, `${label}: no deferred take request escapes`);
  }
  async function switchChannel(kind) {
    const expand = dock.getByRole('button', { name: 'Expand toolbar', exact: true }); if (await expand.isVisible()) await expand.click();
    await dock.getByRole('button', { name: `${kind === 'scripture' ? 'Scripture' : 'Lyrics'} — ${kind}`, exact: true }).click();
    await page.getByRole('heading', { name: kind === 'scripture' ? 'Find a passage' : 'Find a song', exact: true }).waitFor();
  }
  async function holdPreviews() {
    const held = [];
    const handler = async route => { held.push(route); };
    await page.route('**/api/worship/preview', handler);
    return {
      held,
      async ready() { await until(() => held.length > 0, 'held preparation request'); await settle(); },
      async release() { for (const route of [...held].reverse()) await route.continue().catch(() => {}); await page.unroute('**/api/worship/preview', handler); },
      async fail() { for (const route of [...held].reverse()) await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable test preparation' }) }).catch(() => {}); await page.unroute('**/api/worship/preview', handler); },
    };
  }
  await chapter();
  const beforeSingle = await workspace(), singleCount = takes.length;
  await row(17).click(); await prepared(17);
  assert.deepEqual(await workspace(), beforeSingle, 'Single-click prepares without changing live content');
  assert.equal(takes.length, singleCount);
  // This is an actual browser double-click, not a synthetic dblclick-only event:
  // both native click events must happen, but only one publication may result.
  await page.evaluate(() => {
    window.__scriptureClickTrace = [];
    for (const type of ['click', 'dblclick']) document.addEventListener(type, event => {
      if (event.target.closest('.w-verse-result')) window.__scriptureClickTrace.push({ type, detail: event.detail });
    }, true);
  });
  const doubleCount = takes.length, doublePreviews = previews.length;
  await row(18).dblclick(); await live(18);
  assert.deepEqual(await page.evaluate(() => window.__scriptureClickTrace), [{ type: 'click', detail: 1 }, { type: 'click', detail: 2 }, { type: 'dblclick', detail: 2 }]);
  assert.equal(takes.length, doubleCount + 1, 'Two clicks plus dblclick send exactly one take');
  assert.equal(previews.length, doublePreviews + 1, 'The second native click does not trigger redundant preparation');
  assert.deepEqual(takes.at(-1).postDataJSON().command.selection, selection(18), 'Double-click sends the clicked verse, never the older prepared one');
  checks.push('Single-click prepares only; a real double-click publishes the exact clicked verse once');

  // A double-click is an explicit content publication: the backend resolves its
  // exact selection directly. A slow private proof must neither delay that
  // publication nor let shortcuts resend the old prepared selection.
  const delayed = await holdPreviews(), delayedCount = takes.length;
  await row(19).dblclick(); await delayed.ready();
  await live(19, false);
  assert.equal(await send.isDisabled(), true);
  for (const chord of ['Control+Enter', 'Meta+Enter']) await page.keyboard.press(chord);
  assert.equal(takes.length, delayedCount + 1);
  const beforeDelayRelease = await workspace();
  await delayed.release(); await live(19);
  await noLatePublication('Delayed private proof', beforeDelayRelease, delayedCount + 1);
  checks.push('Double-click publishes its exact verse immediately even when the private proof is delayed');

  const failed = await holdPreviews(), failedCount = takes.length;
  await row(20).dblclick(); await failed.ready(); await live(20, false);
  const beforeFailureRelease = await workspace();
  await failed.fail();
  await until(() => page.getByTestId('prepared-cue').getAttribute('aria-busy').then(value => value === 'false'), 'failed preparation settles');
  assert.equal(await send.isDisabled(), true);
  await noLatePublication('Failed private proof', beforeFailureRelease, failedCount + 1);
  checks.push('A failed private proof cannot replace the deliberately published exact verse or cause another Take');

  const superseded = await holdPreviews(), supersededCount = takes.length;
  await row(21).dblclick(); await superseded.ready(); await live(21, false);
  const beforeSupersedeRelease = await workspace(), requestsBeforeNew = superseded.held.length;
  await row(22).click(); await until(() => superseded.held.length > requestsBeforeNew, 'new single-click supersedes pending double-click');
  await superseded.release(); await prepared(22);
  await noLatePublication('New single-click supersedes an older proof', beforeSupersedeRelease, supersededCount + 1);
  checks.push('Out-of-order private proofs cannot change live content after a newer single-click');

  const cleared = await holdPreviews();
  await row(23).dblclick(); await cleared.ready(); await live(23, false);
  await page.getByRole('button', { name: 'Clear live content', exact: true }).click();
  await until(async () => (await workspace()).blanked, 'manual clear takes precedence');
  const beforeClearRelease = await workspace(), clearCount = takes.length;
  await cleared.release();
  await noLatePublication('Manual clear wins over late private proof', beforeClearRelease, clearCount);
  checks.push('A deliberate clear cannot be undone by a late private proof');

  const switched = await holdPreviews(), switchedCount = takes.length;
  await row(24).dblclick(); await switched.ready(); await live(24, false);
  const beforeSwitchRelease = await workspace();
  await switchChannel('lyrics'); await switched.release();
  await noLatePublication('Leaving Scripture cannot cause deferred publication', beforeSwitchRelease, switchedCount + 1);
  await switchChannel('scripture'); await chapter();
  checks.push('Changing channels preserves the explicit publication and late proof responses never publish again');

  // Second real authenticated author takes ownership while a private proof is
  // in flight. Subsequent double-clicks must be read-only; the old private proof
  // cannot publish after ownership changes.
  const created = await request.post(`${base}/api/users`, { data: { username: 'other-scripture', password: 'test-password', displayName: 'Other Scripture operator' } });
  assert.equal(created.status(), 200, await created.text());
  const otherUser = (await created.json()).user;
  assert.equal((await request.post(`${base}/api/users/${otherUser.id}/grants`, { data: { channelId: 'scripture', role: 'author' } })).status(), 200);
  const other = await browser.newContext();
  assert.equal((await other.request.post(`${base}/api/auth/login`, { data: { username: 'other-scripture', password: 'test-password' } })).status(), 200);
  const otherPage = await other.newPage(); await otherPage.goto(base); await otherPage.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  const ownership = await holdPreviews(), ownershipCount = takes.length;
  await row(25).dblclick(); await ownership.ready(); await live(25, false);
  const beforeOwnershipRelease = await workspace();
  await otherPage.evaluate(id => new Promise(resolve => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    window.__testTakeoverSocket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'takeover', channel: 'scripture' }));
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.t === 'presence' && message.owners.scripture === id) resolve(true); };
  }), otherUser.id);
  await page.getByText('Another team member controls this channel.', { exact: false }).waitFor();
  await row(26).dblclick(); await settle();
  await ownership.release();
  await noLatePublication('Another operator owns Scripture', beforeOwnershipRelease, ownershipCount + 1);
  // Reclaim using the same normal relay protocol, then test every existing
  // explicit Send live path while the selection button remains focused.
  const admin = (await (await request.get(`${base}/api/auth/me`)).json()).user;
  await page.evaluate(id => new Promise(resolve => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    window.__testTakeoverSocket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'takeover', channel: 'scripture' }));
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.t === 'presence' && message.owners.scripture === id) resolve(true); };
  }), admin.id);
  await until(() => page.locator('.w-ownership').count().then(count => count === 0), 'original operator regains control');
  await other.close();
  checks.push('A real team-member takeover blocks new double-click publications and late private proofs cannot take control');

  for (const [index, chord] of [null, 'Control+Enter', 'Meta+Enter'].entries()) {
    const verse = 26 + index, count = takes.length;
    await row(verse).click(); await prepared(verse);
    assert.ok(await row(verse).evaluate(element => element === document.activeElement), 'Selection stays focused for Send live shortcut regression');
    if (chord) await page.keyboard.press(chord); else await send.click();
    await live(verse); assert.equal(takes.length, count + 1, `${chord ?? 'Send live button'} remains a single deliberate publication`);
  }
  // Button remains disabled while a real publication is pending; shortcuts and
  // even a new double-click on another verse must not queue a second Take.
  const pendingTakes = [];
  const holdTake = async route => { if (route.request().postDataJSON().command?.type === 'take') pendingTakes.push(route); else await route.continue(); };
  await page.route('**/api/worship/channels/scripture/command', holdTake);
  const pendingCount = takes.length;
  await row(29).dblclick(); await until(() => pendingTakes.length === 1, 'publication held for duplicate guard');
  await page.keyboard.press('Control+Enter'); await page.keyboard.press('Meta+Enter'); await settle();
  await row(30).dblclick();
  await until(() => page.getByTestId('prepared-cue').textContent().then(value => value.includes('John 3:30 · KJV')), 'a second double-click may prepare but cannot publish while Take is pending');
  assert.equal(takes.length, pendingCount + 1, 'Existing shortcuts do not duplicate an in-flight double-click publication');
  assert.equal(pendingTakes.length, 1, 'A second double-click cannot queue another publication while one is pending');
  await pendingTakes[0].continue(); await page.unroute('**/api/worship/channels/scripture/command', holdTake); await live(29);
  checks.push('Send live, both keyboard chords, and pending-publication duplicate protection remain intact');

  // An already explicit double-click need not wait on a round trip before the
  // operator returns to Studio. Leaving the view must not cancel that intended
  // write, and completing it must not take any Studio scene automatically.
  pendingTakes.length = 0;
  await page.route('**/api/worship/channels/scripture/command', holdTake);
  const navigationTakes = takes.length;
  await row(31).dblclick(); await until(() => pendingTakes.length === 1, 'hold accepted publication before immediate Studio navigation');
  const expand = dock.getByRole('button', { name: 'Expand toolbar', exact: true }); if (await expand.isVisible()) await expand.click();
  await dock.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  await pendingTakes[0].continue(); await page.unroute('**/api/worship/channels/scripture/command', holdTake);
  await until(async () => (await workspace()).live?.selection.verse === 31, 'explicit channel publication completes after entering Studio');
  assert.equal(takes.length, navigationTakes + 1);
  checks.push('Immediate return to Studio does not cancel the explicit channel send or trigger scene switching');
  await switchChannel('scripture');
  await page.getByTestId('live-cue').getByText('John 3:31 · KJV', { exact: true }).waitFor();

  assert.deepEqual(await production(), initialStudio, 'Every content-only operation preserves Program, Preview, layers, audio and output routing byte-for-byte');
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state, 'offline', 'Content publishing never starts the engine');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(dir, 'scripture-doubleclick.png'), fullPage: true });
  console.log(JSON.stringify({ checks, takes: takes.length, previews: previews.length, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(logs.slice(-7000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
