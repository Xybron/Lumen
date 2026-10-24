// Explicitly opt-in REAL LAB account test. This never mocks Auth, REST or
// Realtime. Run only after provisioning dedicated test users in the ignored
// private credentials file; no service-role key is needed by this browser test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const privateDirectory = path.join(root, '.team-local');
const credentialsPath = path.join(privateDirectory, 'test-accounts.json');
const base = process.env.LUMEN_TEAM_TEST_URL ?? 'http://127.0.0.1:5373';
if (base !== 'http://127.0.0.1:5373') throw new Error('This real-account test is restricted to the isolated Team workspace on loopback5373.');

async function privateFile(filename, maximum = 65536) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Test credentials/report must be a private regular file (mode600), never a symlink.');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
const parent = await fs.lstat(privateDirectory);
if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('The local test directory must be a real directory.');
const credentials = await privateFile(credentialsPath);
if (credentials.version !== 1 || credentials.projectRef !== 'xfppsgiothkvhndmbixx' || !/^[a-zA-Z0-9_-]{8,80}$/.test(credentials.runId) || !Array.isArray(credentials.users) || credentials.users.length !== 2) throw new Error('Invalid dedicated LAB test-account file.');
const users = ['owner', 'editor'].map(role => credentials.users.find(user => user.role === role));
if (users.some(user => !user || !/^[a-f0-9-]{36}$/.test(user.id) || typeof user.email !== 'string' || !user.email.includes('@') || typeof user.password !== 'string' || user.password.length < 24) || users[0].id === users[1].id) throw new Error('Provide two distinct real dedicated test users with independently generated strong passwords.');
const secretValues = new Set(users.map(user => user.password));
function safeMessage(cause) {
  let message = cause instanceof Error ? cause.message : String(cause);
  for (const secret of secretValues) if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_.-]{25,}/g, '[redacted JWT]').replace(/\b[a-f0-9]{64}\b/gi, '[redacted code]').slice(0, 1600);
}
const reportPath = path.join(privateDirectory, `real-team-report-${credentials.runId}.json`);
const previous = await privateFile(reportPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (previous && (previous.runId !== credentials.runId || previous.projectRef !== credentials.projectRef)) throw new Error('A test report belongs to another run; it was not overwritten.');
const emptyCounts = () => ({ joins: 0, sentPresence: 0, sentBroadcast: 0, receivedPresence: 0, receivedBroadcast: 0, socketCloses: 0 });
const report = { version: 1, runId: credentials.runId, projectRef: credentials.projectRef, startedAt: new Date().toISOString(), teamId: previous?.teamId ?? null, draftId: previous?.draftId ?? null, surfaceDraftId: previous?.surfaceDraftId ?? null, checks: [], realtime: [], realtimeCounts: { owner: emptyCounts(), editor: emptyCounts() }, realtimeErrors: [], httpFailures: [], browserErrors: [] };
const trackedFiles = ['data/content.json', 'data/production.json', 'data/broadcast/broadcast-private.json'];
async function stationHashes() {
  return Object.fromEntries(await Promise.all(trackedFiles.map(async filename => {
    const bytes = await fs.readFile(path.join(root, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    return [filename, bytes ? createHash('sha256').update(bytes).digest('hex') : null];
  })));
}
const before = await stationHashes();
async function persist() { await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await fs.chmod(reportPath, 0o600); }
const check = label => { report.checks.push(label); console.log(`PASS: ${label}`); };
async function until(fn, label, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Timed out: ${label}`);
}
async function uiState(page) {
  return page.evaluate(async () => {
    const { useTeamStore } = await import('/src/stores/team.ts'); const team = useTeamStore();
    return { ready: team.ready, userId: team.user?.id ?? null, profileName: team.profileName, teamId: team.teamId, role: team.role, pending: team.pendingCount,
      resources: team.resources.map(row => ({ id: row.id, name: row.name, revision: row.revision, document: row.document })),
      members: team.members.map(member => ({ id: member.user_id, name: member.name, role: member.role })),
      peers: team.peers.map(peer => ({ userId: peer.userId, name: peer.name, surface: peer.surface, x: peer.x, y: peer.y })), focus: team.focusMode, error: team.error };
  });
}
async function closeDialog(page) { const dialog = page.getByRole('dialog'); if (await dialog.count()) await dialog.getByRole('button', { name: 'Close', exact: true }).click(); }
async function setProfile(page, name) {
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Team preferences' });
  await dialog.getByLabel('Display name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await until(async () => (await uiState(page)).profileName === name && !(await dialog.getByRole('button', { name: 'Save name', exact: true }).isDisabled()), 'profile saved');
  await closeDialog(page);
}
function monitor(page, side) {
  page.on('pageerror', cause => { report.browserErrors.push({ side, message: safeMessage(cause) }); });
  page.on('response', response => {
    try {
      const url = new URL(response.url());
      if (url.hostname === 'xfppsgiothkvhndmbixx.supabase.co' && response.status() >= 400 && report.httpFailures.length < 30) report.httpFailures.push({ side, path: url.pathname, status: response.status() });
    } catch { /* No raw URLs or tokens enter reports. */ }
  });
  page.on('websocket', socket => {
    if (!socket.url().startsWith('wss://xfppsgiothkvhndmbixx.supabase.co/')) return;
    socket.on('close', () => { report.realtimeCounts[side].socketCloses++; });
    const frame = (direction, payload) => {
      try {
        let value;
        if (typeof payload !== 'string' && (payload[0] === 3 || payload[0] === 4)) {
          // Protocol2.0 can encode Broadcast as a binary frame. Read only its
          // topic header, never the arbitrary user payload or authentication.
          const sent = payload[0] === 3, start = sent ? 7 + payload[1] + payload[2] : 5;
          const size = payload[sent ? 3 : 1];
          value = { topic: payload.subarray(start, start + size).toString('utf8'), event: 'broadcast' };
        } else {
          const raw = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
          value = Array.isArray(raw) ? { topic: raw[2], event: raw[3], payload: raw[4] } : raw;
        }
        const privateTopic = typeof value.topic === 'string' && /^realtime:lumen-team:[a-f0-9-]{36}$/.test(value.topic);
        if (privateTopic) {
          const counts = report.realtimeCounts[side];
          if (direction === 'sent' && value.event === 'phx_join') counts.joins++;
          if (direction === 'sent' && value.event === 'presence') counts.sentPresence++;
          if (direction === 'sent' && value.event === 'broadcast') counts.sentBroadcast++;
          if (direction === 'received' && ['presence_state', 'presence_diff'].includes(value.event)) counts.receivedPresence++;
          if (direction === 'received' && value.event === 'broadcast') counts.receivedBroadcast++;
        }
        if (!['phx_reply', 'system', 'presence_state', 'presence_diff', 'postgres_changes', 'presence', 'broadcast'].includes(value.event)) return;
        const topic = typeof value.topic === 'string' && /^realtime:lumen-team:[a-f0-9-]{36}$/.test(value.topic) ? value.topic : 'other';
        const metadata = { side, direction, topic, event: value.event, status: ['ok', 'error'].includes(value.payload?.status) ? value.payload.status : undefined };
        if (value.event === 'system' || metadata.status === 'error') {
          const reason = value.payload?.message ?? value.payload?.response?.reason;
          if (typeof reason === 'string') metadata.reason = safeMessage(reason);
          if (metadata.status === 'error') report.realtimeErrors.push(metadata);
        }
        if (direction === 'received' && (value.event === 'presence_state' || value.event === 'presence_diff')) {
          const groups = value.event === 'presence_state' ? value.payload : value.payload?.joins;
          metadata.presence = Object.values(groups ?? {}).flatMap(group => (group?.metas ?? []).map(entry => ({ userId: entry.userId, surface: entry.surface, x: entry.x, y: entry.y })));
        }
        if (value.event === 'presence' && ['track', 'untrack'].includes(value.payload?.event)) metadata.operation = value.payload.event;
        // Counts and errors are not capped: a long stress run must still catch
        // late rate-limit failures without recording every cursor frame body.
        if (report.realtime.length < 160 && value.event !== 'broadcast') report.realtime.push(metadata);
      } catch { /* Never write frame bodies: join frames can contain JWTs. */ }
    };
    socket.on('framesent', ({ payload }) => frame('sent', payload));
    socket.on('framereceived', ({ payload }) => frame('received', payload));
  });
}
const cursorCount = page => page.locator('.team-remote-cursor').count();
async function bothCursors(a, b, label = 'two-way cursor activity', timeout = 35000) {
  await until(async () => await cursorCount(a) > 0 && await cursorCount(b) > 0, label, timeout);
}
function noRateLimitErrors() {
  assert.deepEqual(report.realtimeErrors.filter(item => /rate.?limit|too.?many|ClientPresenceRateLimitReached/i.test(item.reason ?? '')), [], 'Realtime must not hit its Presence or Broadcast rate limit');
}
let browser, contexts = [], pages = [], stage = 'configuration';
try {
  const response = await fetch(`${base}/api/team/config`, { signal: AbortSignal.timeout(5000) });
  const configuration = await response.json();
  assert.equal(configuration.enabled, true); assert.equal(configuration.isolated, true); assert.equal(configuration.projectRef, credentials.projectRef);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  contexts = await Promise.all(users.map(() => browser.newContext({ viewport: { width: 1440, height: 960 } })));
  pages = await Promise.all(contexts.map(context => context.newPage())); const [a, b] = pages;
  pages.forEach((page, index) => { page.setDefaultTimeout(20000); monitor(page, index === 0 ? 'owner' : 'editor'); });
  stage = 'real Auth sign-in';
  await Promise.all(pages.map(async (page, index) => {
    await page.goto(`${base}/team`);
    await page.getByLabel('Email', { exact: true }).fill(users[index].email);
    await page.getByLabel('Password', { exact: true }).fill(users[index].password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await until(async () => { const value = await uiState(page); return value.ready && value.userId === users[index].id; }, `real ${users[index].role} Auth session`);
  }));
  check('two real LAB accounts sign in through the UI in separate browser contexts');
  stage = 'team creation';
  const run = credentials.runId.slice(0, 12), teamName = `Local collaboration test ${run}`;
  const createdTeam = !report.teamId;
  if (report.teamId) {
    await a.getByLabel('Team workspace', { exact: true }).selectOption(report.teamId);
    await until(async () => (await uiState(a)).teamId === report.teamId, 'existing test team selection');
  } else {
    const ownerState = await uiState(a);
    if (ownerState.teamId) {
      await a.getByRole('button', { name: 'Switch / join', exact: true }).click();
      await a.getByRole('dialog', { name: 'Team workspaces' }).getByLabel('New team name', { exact: true }).fill(teamName);
      await a.getByRole('dialog', { name: 'Team workspaces' }).getByRole('button', { name: 'Create team', exact: true }).click();
    } else {
      await a.getByLabel('Team name', { exact: true }).fill(teamName);
      await a.getByRole('button', { name: 'Create team', exact: true }).click();
    }
    await until(async () => { const state = await uiState(a); return state.teamId !== null && state.teamId !== ownerState.teamId; }, 'team creation');
    report.teamId = (await uiState(a)).teamId; await persist();
  }
  assert.equal((await uiState(a)).role, 'owner');
  await setProfile(a, `Local Test Owner ${run}`);
  check(createdTeam ? 'owner creates a private test team with a real membership' : 'owner reopens the existing private test team with its real membership');
  stage = 'invitation and join';
  const joinedByInvitation = (await uiState(b)).teamId !== report.teamId;
  if (joinedByInvitation) {
    await a.getByRole('button', { name: 'Workspace settings', exact: true }).click();
    await a.getByRole('dialog', { name: 'Team preferences' }).getByRole('button', { name: 'Invite a teammate', exact: true }).click();
    const invitationDialog = a.getByRole('dialog', { name: `Invite to ${teamName}` });
    await invitationDialog.getByRole('combobox').selectOption('editor');
    await invitationDialog.getByRole('button', { name: 'Generate invitation', exact: true }).click();
    const code = invitationDialog.getByLabel('Invitation code', { exact: true });
    await code.waitFor(); const token = await code.inputValue(); secretValues.add(token);
    assert.match(token, /^[a-f0-9]{64}$/);
    const editorState = await uiState(b);
    if (editorState.teamId) await b.getByRole('button', { name: 'Switch / join', exact: true }).click();
    const joinSurface = editorState.teamId ? b.getByRole('dialog', { name: 'Team workspaces' }) : b;
    await joinSurface.getByLabel('Invitation code', { exact: true }).fill(token);
    await joinSurface.getByRole('button', { name: 'Join team', exact: true }).click();
    await until(async () => (await uiState(b)).teamId === report.teamId && (await uiState(b)).role === 'editor', 'editor joins invitation');
    await closeDialog(a);
  }
  await setProfile(b, `Local Test Editor ${run}`);
  check(joinedByInvitation ? 'an editor invitation joins the second real account to the same team' : 'the previously invited editor retains access to the shared test team');
  stage = 'shared draft creation';
  const draftName = `Shared real-account draft ${run}`, textA = `Prepared by the owner ${run}`, textB = `Updated by the editor ${run} · ${report.startedAt}`;
  if (report.draftId && (await uiState(a)).resources.some(row => row.id === report.draftId)) {
    await a.locator('.team-resource').filter({ hasText: draftName }).click();
  } else {
    await a.locator('.team-new-drafts').getByRole('button', { name: 'Presentation', exact: true }).click();
    await a.getByLabel('Draft name', { exact: true }).fill(draftName);
    await a.getByRole('button', { name: 'Add content', exact: true }).click();
    const properties = a.getByRole('complementary', { name: 'Draft properties' });
    await properties.getByLabel('Title', { exact: true }).fill('A shared preparation');
    await properties.getByLabel('Content', { exact: true }).fill(textA);
    await a.getByRole('button', { name: 'Save draft', exact: true }).click();
    await until(async () => { const state = await uiState(a); return state.pending === 0 && state.resources.some(row => row.name === draftName); }, 'owner draft acknowledgement');
    report.draftId = (await uiState(a)).resources.find(row => row.name === draftName).id; await persist();
  }
  await until(async () => (await uiState(b)).resources.some(row => row.id === report.draftId), 'draft appears for invited editor without reload');
  await b.locator('.team-resource').filter({ hasText: draftName }).click();
  const propertiesB = b.getByRole('complementary', { name: 'Draft properties' });
  await propertiesB.getByLabel('Content', { exact: true }).fill(textB);
  await b.getByRole('button', { name: 'Save draft', exact: true }).click();
  await until(async () => { const state = await uiState(b); return state.pending === 0 && state.resources.find(row => row.id === report.draftId)?.document.items?.[0]?.body === textB; }, 'editor draft acknowledgement');
  await until(async () => (await a.getByRole('complementary', { name: 'Draft properties' }).getByLabel('Content', { exact: true }).inputValue()) === textB, 'editor change reaches owner without reload');
  check('shared draft propagates from owner to editor and editor changes return without reload');
  stage = 'cursor presence';
  await until(async () => (await uiState(a)).members.some(member => member.id === users[1].id), 'owner learns joined member');
  await until(async () => new URL(a.url()).searchParams.get('resource') === report.draftId && new URL(b.url()).searchParams.get('resource') === report.draftId, 'both users view the same shared draft');
  assert.equal(await a.evaluate(() => document.hidden), false); assert.equal(await b.evaluate(() => document.hidden), false);
  await a.mouse.move(600, 240); await b.mouse.move(760, 260);
  await bothCursors(a, b, 'two-way real cursor activity', 45000);
  assert.match(await a.locator('.team-remote-cursor').innerText(), /Local Test Editor/);
  assert.match(await b.locator('.team-remote-cursor').innerText(), /Local Test Owner/);
  check('private Realtime activity renders both real users’ cursors on the same draft');
  stage = 'sustained cursor transport';
  const stressBaseline = structuredClone(report.realtimeCounts), stressStarted = Date.now();
  let movement = 0;
  while (Date.now() - stressStarted < 36000) {
    await a.mouse.move(520 + movement % 240, 300 + movement % 160);
    await b.mouse.move(650 + movement % 200, 310 + movement % 150);
    if (movement % 20 === 0) { await bothCursors(a, b, 'cursors stay active during sustained movement', 5000); noRateLimitErrors(); }
    movement++;
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  for (const side of ['owner', 'editor']) {
    const counts = report.realtimeCounts[side], initial = stressBaseline[side];
    assert.equal(counts.sentPresence - initial.sentPresence, 0, `${side}: mouse movement and keepalive never call Presence.track/untrack`);
    assert.ok(counts.sentBroadcast - initial.sentBroadcast > 10, `${side}: cursor movement is sent over Broadcast`);
    assert.ok(counts.receivedBroadcast - initial.receivedBroadcast > 10, `${side}: receives live Broadcast updates from its teammate`);
  }
  await bothCursors(a, b, 'cursors remain connected beyond the former30-second rate-limit window');
  noRateLimitErrors();
  check('36 seconds of sustained movement uses Broadcast, with no Presence updates or rate-limit disconnection');
  stage = 'Focus mode';
  const focus = b.locator('.team-presence-bar > button');
  const focusBaseline = structuredClone(report.realtimeCounts);
  for (let attempt = 0; attempt < 6; attempt++) {
    await focus.click();
    assert.equal(await focus.getAttribute('aria-pressed'), 'true');
    await until(async () => await cursorCount(b) === 0 && await cursorCount(a) === 0, 'Focus mode hides activity locally and remotely');
    await focus.click();
    assert.equal(await focus.getAttribute('aria-pressed'), 'false');
    // No mouse movement is needed to resume. A Focus toggle must not spend
    // another pair of rate-limited Presence track/untrack operations.
    await bothCursors(a, b, 'activity resumes after Focus mode');
    noRateLimitErrors();
  }
  for (const side of ['owner', 'editor']) assert.equal(report.realtimeCounts[side].sentPresence - focusBaseline[side].sentPresence, 0, `${side}: repeated Focus toggles use no Presence updates`);
  check('six Focus mode cycles hide and restore cursor activity without Presence churn');
  stage = 'keyboard-only surface changes';
  const surfaceDraftName = `Activity surface check ${run}`;
  if (!report.surfaceDraftId || !(await uiState(a)).resources.some(row => row.id === report.surfaceDraftId)) {
    await a.locator('.team-new-drafts').getByRole('button', { name: 'Presentation', exact: true }).click();
    await a.getByLabel('Draft name', { exact: true }).fill(surfaceDraftName);
    await a.getByRole('button', { name: 'Save draft', exact: true }).click();
    await until(async () => { const state = await uiState(a); return state.pending === 0 && state.resources.some(row => row.name === surfaceDraftName); }, 'surface test draft acknowledgement');
    report.surfaceDraftId = (await uiState(a)).resources.find(row => row.name === surfaceDraftName).id;
    await persist();
  } else {
    const resource = a.locator('.team-resource').filter({ hasText: surfaceDraftName });
    await resource.focus(); await resource.press('Enter');
  }
  await until(async () => (await uiState(b)).resources.some(row => row.id === report.surfaceDraftId), 'surface test draft appears for editor');
  const secondResource = b.locator('.team-resource').filter({ hasText: surfaceDraftName });
  await secondResource.focus(); await secondResource.press('Enter');
  await until(async () => (await uiState(a)).peers.some(peer => peer.userId === users[1].id && peer.surface === `team:${report.surfaceDraftId}`), 'keyboard-only selection publishes the new activity surface');
  await bothCursors(a, b, 'cursors follow matching draft selection without moving the pointer');
  for (const page of pages) {
    const resource = page.locator('.team-resource').filter({ hasText: draftName });
    await resource.focus(); await resource.press('Enter');
  }
  await bothCursors(a, b, 'cursors follow keyboard-only return to original draft');
  check('keyboard-only draft navigation updates activity location without pointer movement');
  stage = 'network interruption and recovery';
  const editorJoins = report.realtimeCounts.editor.joins;
  await contexts[1].setOffline(true);
  assert.equal(await b.evaluate(() => navigator.onLine), false);
  await until(async () => await cursorCount(a) === 0, 'disconnected editor cursor expires on the owner view', 25000);
  const offlineText = `Saved while offline ${run} · ${report.startedAt}`;
  await propertiesB.getByLabel('Content', { exact: true }).fill(offlineText);
  await b.getByRole('button', { name: 'Save draft', exact: true }).click();
  await until(async () => (await uiState(b)).pending > 0, 'offline edit is retained in the durable outbox');
  await contexts[1].setOffline(false);
  await until(async () => (await uiState(b)).pending === 0 && (await a.getByRole('complementary', { name: 'Draft properties' }).getByLabel('Content', { exact: true }).inputValue()) === offlineText, 'queued edit reaches the owner after reconnect', 45000);
  await bothCursors(a, b, 'cursor activity recovers automatically after reconnect', 45000);
  assert.ok(report.realtimeCounts.editor.joins > editorJoins, 'editor rejoins its private Realtime channel');
  const afterReconnect = `Owner after reconnect ${run} · ${report.startedAt}`;
  await a.getByRole('complementary', { name: 'Draft properties' }).getByLabel('Content', { exact: true }).fill(afterReconnect);
  await a.getByRole('button', { name: 'Save draft', exact: true }).click();
  await until(async () => (await propertiesB.getByLabel('Content', { exact: true }).inputValue()) === afterReconnect, 'fresh shared edit still reaches editor after reconnect');
  noRateLimitErrors();
  check('network reconnect restores cursors, flushes an offline edit and continues shared-draft updates without reload');
  assert.deepEqual(await stationHashes(), before);
  check('production scene, Main audio and saved-key file hashes are unchanged');
  assert.deepEqual(report.browserErrors, []);
  for (let index = 0; index < pages.length; index++) await pages[index].screenshot({ path: `/private/tmp/lumen-real-team-${index === 0 ? 'owner' : 'editor'}.png`, fullPage: true, mask: [pages[index].locator('[data-team-private]'), pages[index].locator('input[type=password]')] });
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); await persist();
  console.log(`REAL account collaboration checks passed. Sanitized report: ${reportPath}`);
  console.log('PowerSync source replication and email deliverability are not covered by this test.');
} catch (cause) {
  report.status = 'failed'; report.failedStage = stage; report.message = safeMessage(cause); report.finishedAt = new Date().toISOString();
  report.activity = await Promise.all(pages.map(async page => { const state = await uiState(page).catch(() => null); return state && { userId: state.userId, teamId: state.teamId, role: state.role, members: state.members, peers: state.peers, focus: state.focus, error: safeMessage(state.error) }; }));
  report.stationFilesUnchanged = JSON.stringify(await stationHashes()) === JSON.stringify(before);
  for (let index = 0; index < pages.length; index++) await pages[index].screenshot({ path: `/private/tmp/lumen-real-team-${index === 0 ? 'owner' : 'editor'}-failure.png`, fullPage: true, mask: [pages[index].locator('[data-team-private]'), pages[index].locator('input[type=password]')] }).catch(() => {});
  await persist(); console.error(`Real-account test failed at ${stage}: ${report.message}`); process.exitCode = 1;
} finally { for (const context of contexts) await context.close().catch(() => {}); await browser?.close().catch(() => {}); }
