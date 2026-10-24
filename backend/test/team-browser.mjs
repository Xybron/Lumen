// Browser fixtures verify local SQLite/outbox/UI behaviour, not live LAB Auth
// or logical replication. No fake account/row is ever sent to LAB.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.LUMEN_TEAM_TEST_URL ?? 'http://127.0.0.1:5373';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Use an explicitly local isolated team test server.');
const browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const uuid = () => crypto.randomUUID();
const account = { id: uuid(), email: 'browser-fixture@example.invalid', aud: 'authenticated', role: 'authenticated', email_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} };
const viewer = { ...account, id: uuid(), email: 'viewer-fixture@example.invalid' };
const teamId = uuid(), resources = new Map(), calls = [];
const viewerTeam = uuid();
let offline = false;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: account.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), session_id: uuid() })}.fixture-only-not-a-valid-signature`;
const viewerJwt = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: viewer.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), session_id: uuid() })}.fixture-only-not-a-valid-signature`;
const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
const errors = [];
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  // HTTP interception does not cover WebSockets. Keep fixture JWTs away from
  // the real Realtime service as well as the Auth/Data APIs.
  await context.routeWebSocket(/xfppsgiothkvhndmbixx\.supabase\.co/, socket => socket.close());
  await context.route('https://xfppsgiothkvhndmbixx.supabase.co/**', async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (offline) return route.abort('internetdisconnected');
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value), headers: { 'Access-Control-Allow-Origin': '*' } });
    if (url.pathname === '/auth/v1/token') {
      const isViewer = route.request().postDataJSON().email === viewer.email;
      return json({ access_token: isViewer ? viewerJwt : jwt, refresh_token: 'fixture-only-refresh', token_type: 'bearer', expires_in: 3600, user: isViewer ? viewer : account });
    }
    if (url.pathname === '/auth/v1/logout') return json({});
    const isViewer = route.request().headers().authorization === `Bearer ${viewerJwt}`;
    const who = isViewer ? viewer : account, selectedTeam = isViewer ? viewerTeam : teamId;
    if (url.pathname === '/auth/v1/user') return json(who);
    if (url.pathname === '/rest/v1/lumen_teams') return json([{ id: selectedTeam, name: isViewer ? 'Viewer fixture team' : 'Browser fixture team' }]);
    if (url.pathname === '/rest/v1/lumen_memberships') return json([{ id: uuid(), team_id: selectedTeam, user_id: who.id, role: isViewer ? 'viewer' : 'owner' }]);
    if (url.pathname === '/rest/v1/lumen_profiles') return json([{ id: who.id, display_name: isViewer ? 'Fixture viewer' : 'Fixture operator' }]);
    if (url.pathname === '/rest/v1/lumen_resources') return json([...resources.values()].filter(row => row.team_id === selectedTeam).sort((a, b) => a.id.localeCompare(b.id)));
    if (url.pathname === '/rest/v1/rpc/lumen_save_resource') {
      const data = route.request().postDataJSON(); calls.push(data);
      const previous = resources.get(data.p_id);
      if ((previous?.revision ?? 0) !== data.p_base_revision) return json({ status: 'conflict', resource: previous });
      const resource = { id: data.p_id, team_id: data.p_team_id, kind: data.p_kind, name: data.p_name, document: data.p_document, revision: data.p_base_revision + 1, updated_at: new Date().toISOString() };
      resources.set(resource.id, resource); return json({ status: 'saved', resource });
    }
    throw new Error(`Unexpected cloud fixture request: ${method} ${url.pathname}`);
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/team`);
  await page.getByLabel('Email', { exact: true }).waitFor();
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill('test-fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Ready for the next service.' }).waitFor();
  console.log('Fixture sign-in and SQLite initialization passed.');
  const invoke = (method, argument) => page.evaluate(async ({ method, argument }) => { const { useTeamStore } = await import('/src/stores/team.ts'); return useTeamStore()[method](argument); }, { method, argument });
  const state = () => page.evaluate(async () => { const { useTeamStore } = await import('/src/stores/team.ts'); const team = useTeamStore(); return { pending: team.pendingCount, resources: JSON.parse(JSON.stringify(team.resources)), conflicts: JSON.parse(JSON.stringify(team.conflicts)), replicationConnected: team.replicationConnected }; });
  const id = uuid();
  offline = true;
  await invoke('saveResource', { id, kind: 'scripture', name: 'Offline prepared verses', document: { schemaVersion: 1, items: [{ type: 'scripture', body: 'A local preparation draft.' }] }, revision: 0 });
  assert.equal((await state()).pending, 1);
  await assert.rejects(invoke('saveResource', { id, kind: 'scripture', name: 'Stale same-device edit', document: { schemaVersion: 1, items: [] }, revision: 0 }), /newer edit on this device/);
  assert.equal((await state()).pending, 1, 'A stale browser tab cannot silently append over an unseen queued revision');
  await page.reload();
  await until(async () => { const value = await state(); return value.pending === 1 && value.resources.length === 1; }, 'offline SQLite restore');
  assert.equal((await state()).resources[0].name, 'Offline prepared verses', 'SQLite retains the outbox across an offline-cloud reload');
  // Two rapid saves in the same millisecond must maintain their revision chain.
  await invoke('saveResource', { id, kind: 'scripture', name: 'Offline second edit', document: { schemaVersion: 1, items: [{ type: 'scripture', body: 'Second local edit.' }] }, revision: 1 });
  await invoke('saveResource', { id, kind: 'scripture', name: 'Offline third edit', document: { schemaVersion: 1, items: [{ type: 'scripture', body: 'Third local edit.' }] }, revision: 2 });
  assert.equal((await state()).pending, 3);
  offline = false;
  await invoke('refresh');
  assert.equal((await state()).pending, 0);
  assert.equal(resources.get(id).name, 'Offline third edit');
  assert.deepEqual(calls.slice(0, 3).map(call => call.p_base_revision), [0, 1, 2]);
  // Another editor wins on the server: stale local draft must never overwrite it.
  resources.set(id, { ...resources.get(id), name: 'Teammate revision', revision: 4 });
  await invoke('saveResource', { id, kind: 'scripture', name: 'My stale offline edit', document: { schemaVersion: 1, items: [{ body: 'Retain my work.' }] }, revision: 3 });
  await until(async () => (await state()).conflicts.length === 1, 'revision conflict');
  assert.equal(resources.get(id).name, 'Teammate revision');
  assert.equal((await state()).pending, 1);
  assert.equal((await state()).replicationConnected, false, 'A working REST fallback is never called a PowerSync connection');
  const conflictId = (await state()).conflicts[0].id;
  await page.evaluate(async id => { const { useTeamStore } = await import('/src/stores/team.ts'); await useTeamStore().resolveConflict(id, 'local'); }, conflictId);
  await invoke('refresh');
  assert.equal(resources.size, 2, 'Keep my edit creates a new UUID instead of clobbering another operator');
  assert.equal(resources.get(id).name, 'Teammate revision');
  assert.equal((await state()).conflicts.length, 0);
  // A provisioned station must not transfer drafts in either direction through
  // a cloud workspace selector. This is fixture metadata, never a real binding.
  const otherWorkspace = uuid();
  await context.route(`${base}/api/workspace`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    id: otherWorkspace, createdAt: new Date().toISOString(), mode: 'provisioned', configured: true,
    message: 'Fixture-only provisioned station for another workspace.',
  }) }));
  const writesBefore = calls.length;
  await assert.rejects(invoke('applyToStation', (await state()).resources[0]), /different workspace/);
  await assert.rejects(invoke('captureLocalDrafts'), /different workspace/);
  assert.equal(calls.length, writesBefore, 'A station belonging to another tenant cannot upload to the selected workspace.');
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const preferences = page.getByRole('dialog', { name: 'Team preferences', exact: true });
  assert.equal(await preferences.getByLabel('Workspace ID', { exact: true }).inputValue(), teamId);
  await preferences.getByRole('button', { name: 'Copy workspace ID', exact: true }).waitFor();
  await preferences.getByText(/different workspace/).waitFor();
  await page.screenshot({ path: '/private/tmp/lumen-workspace-identity-browser.png', fullPage: true });
  await preferences.getByRole('button', { name: 'Close', exact: true }).click();
  console.log('Workspace identity UI and cross-workspace station import/export rejection passed.');
  // Switching accounts on one device must not reveal or upload another user's
  // durable outbox. The fake viewer's team is distinct and read-only.
  offline = true;
  const retainedId = uuid();
  await invoke('saveResource', { id: retainedId, kind: 'lyrics', name: 'Private account A queued edit', document: { schemaVersion: 1, items: [] }, revision: 0 });
  await invoke('signOut').catch(() => {}); // Offline local logout still clears visible data.
  offline = false;
  await page.evaluate(async ({ email }) => { const { useTeamStore } = await import('/src/stores/team.ts'); await useTeamStore().signIn(email, 'fixture-password'); }, viewer);
  assert.equal((await state()).pending, 0); assert.deepEqual((await state()).resources, []);
  await assert.rejects(invoke('saveResource', { kind: 'scene', name: 'Viewer cannot write', document: { schemaVersion: 1 }, revision: 0 }), /owner or editor/);
  assert.equal(resources.has(retainedId), false, 'A viewer login cannot upload account A’s private outbox');
  await invoke('signOut');
  await page.evaluate(async ({ email }) => { const { useTeamStore } = await import('/src/stores/team.ts'); await useTeamStore().signIn(email, 'fixture-password'); }, account);
  await invoke('refresh');
  assert.equal(resources.get(retainedId)?.team_id, teamId, 'Returning to A resumes only A’s retained queue');
  await page.screenshot({ path: '/private/tmp/lumen-team-offline-browser.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: isolated browser fixture sign-in, actual persisted PowerSync SQLite, offline-cloud reload, ordered upload, CAS conflict, keep-as-copy, account isolation, viewer restrictions and cross-workspace station transfer guards. Live LAB Auth and source replication are NOT covered by this fixture.');
} finally { await context.close(); await browser.close(); }
