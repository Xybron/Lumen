// Opt-in real LAB accounts + isolated local Program/Watch media checks.
// No existing station configuration, account profiles or shared teams are edited.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createWorkspaceWatchHarness } from './workspace-watch-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFrontend = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { createClient } = requireFrontend('@supabase/supabase-js');
const directory = path.join(root, '.team-local');
const parent = await fs.lstat(directory);
assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), 'The QA directory must be a real local directory.');
async function privateJson(filename) {
  const info = await fs.lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size < 100000 && !(info.mode & 0o077), 'Only private regular QA files are accepted.');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
const credentials = await privateJson(path.join(directory, 'test-accounts.json'));
assert.equal(credentials.version, 1); assert.equal(credentials.projectRef, 'xfppsgiothkvhndmbixx');
assert.match(credentials.runId, /^[a-zA-Z0-9_-]{8,80}$/);
assert.equal(credentials.users.length, 2);
const users = ['owner', 'editor'].map(role => credentials.users.find(user => user.role === role));
assert.ok(users.every(user => user && /^[a-f0-9-]{36}$/.test(user.id) && user.password.length >= 24));
assert.notEqual(users[0].id, users[1].id);
const secrets = new Set(users.map(user => user.password));
function safeError(cause) {
  let value = cause instanceof Error ? cause.message : String(cause);
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_.-]{25,}/g, '[redacted JWT]').replace(/#key=[^\s"']+/gi, '#key=[redacted]').replace(/\b[a-f0-9]{64,}\b/gi, '[redacted key]').slice(0, 1800);
}
const reportPath = path.join(directory, `real-workspace-isolation-${credentials.runId}.json`);
const previous = await privateJson(reportPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (previous) { assert.equal(previous.runId, credentials.runId); assert.equal(previous.projectRef, credentials.projectRef); }
const report = { version: 1, runId: credentials.runId, projectRef: credentials.projectRef, startedAt: new Date().toISOString(), workspaces: previous?.workspaces ?? [null, null], checks: [], realtime: [], browserErrors: [] };
const protectedFiles = ['content.json', 'production.json', 'workspace.json', 'broadcast/broadcast-private.json', 'outputs/links-private.json'];
const tracked = ['data', '.team-local/station'].flatMap(base => protectedFiles.map(file => `${base}/${file}`));
async function hashes() {
  return Object.fromEntries(await Promise.all(tracked.map(async file => {
    const bytes = await fs.readFile(path.join(root, file)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    return [file, bytes ? createHash('sha256').update(bytes).digest('hex') : null];
  })));
}
const before = await hashes();
async function persist() { await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await fs.chmod(reportPath, 0o600); }
function check(label) { report.checks.push(label); console.log(`PASS: ${label}`); }
async function until(fn, label, timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error(`Timed out: ${label}`);
}
function unwrap(result) { if (result.error) throw new Error(`LAB request rejected (${result.error.code ?? result.status}): ${safeError(result.error.message)}`); return result.data; }
const clients = [], contexts = [];
let browser, watch, stage = 'configuration';
async function resource(index, id) { return unwrap(await clients[index].from('lumen_resources').select('*').eq('id', id)).at(0); }
async function joinRoom(client, workspaceId) {
  const channel = client.channel(`lumen-team:${workspaceId}`, { config: { private: true, broadcast: { ack: true, self: false }, presence: { key: randomUUID() } } });
  let timer;
  const result = await new Promise(resolve => {
    timer = setTimeout(() => resolve({ status: 'TEST_TIMEOUT' }), 25000);
    channel.subscribe((status, error) => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) resolve({ status, message: error ? safeError(error) : undefined });
    });
  });
  clearTimeout(timer);
  return { channel, ...result };
}
async function uiLogin(page, index, base) {
  await page.goto(`${base}/team`);
  const email = page.getByLabel('Email', { exact: true });
  if (await email.isVisible().catch(() => false)) {
    await email.fill(users[index].email);
    await page.getByLabel('Password', { exact: true }).fill(users[index].password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } else {
    // Account initialization may still be displaying its loading screen.
    await until(async () => await email.isVisible().catch(() => false) || await page.getByLabel('Team workspace', { exact: true }).isVisible().catch(() => false), 'team login ready');
    if (await email.isVisible()) {
      await email.fill(users[index].email); await page.getByLabel('Password', { exact: true }).fill(users[index].password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    }
  }
  const selection = page.getByLabel('Team workspace', { exact: true });
  await selection.waitFor(); await selection.selectOption(report.workspaces[index].id);
  await until(async () => await selection.inputValue() === report.workspaces[index].id && await page.locator('.team-resource').filter({ hasText: report.workspaces[index].draftName }).count() === 1, 'own workspace draft visible');
}
try {
  const configuration = await fetch('http://127.0.0.1:5373/api/team/config', { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  assert.equal(configuration.enabled, true); assert.equal(configuration.isolated, true); assert.equal(configuration.projectRef, credentials.projectRef);
  stage = 'two real account sessions';
  for (const user of users) {
    const client = createClient(configuration.supabaseUrl, configuration.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, options) => fetch(input, { ...options, signal: options?.signal ?? AbortSignal.timeout(12000) }) } });
    clients.push(client);
    const result = unwrap(await client.auth.signInWithPassword({ email: user.email, password: user.password }));
    secrets.add(result.session.access_token); secrets.add(result.session.refresh_token);
    assert.equal(result.user.id, user.id); assert.ok(result.user.email_confirmed_at);
    assert.equal(unwrap(await client.auth.getUser()).user.id, user.id);
    await client.realtime.setAuth(result.session.access_token);
  }
  check('Both dedicated accounts authenticate against real LAB Auth, without service-role access.');
  stage = 'exclusive QA workspaces';
  for (let index = 0; index < 2; index++) {
    const client = clients[index], name = `Workspace isolation ${index === 0 ? 'A' : 'B'} ${credentials.runId.slice(0, 12)}`;
    let team = unwrap(await client.from('lumen_teams').select('*').eq('name', name).eq('created_by', users[index].id)).at(0);
    if (!team) team = unwrap(await client.rpc('lumen_create_team', { p_name: name }));
    assert.equal(team.name, name); assert.equal(team.created_by, users[index].id);
    if (report.workspaces[index]?.id) assert.equal(team.id, report.workspaces[index].id);
    const entry = report.workspaces[index] = { id: team.id, name, draftId: report.workspaces[index]?.draftId ?? randomUUID(), draftName: `Private ${index === 0 ? 'A' : 'B'} draft ${credentials.runId.slice(0, 12)}` };
    await persist(); // Retain newly created QA IDs before any later failure/retry.
    const members = unwrap(await client.from('lumen_memberships').select('user_id,role').eq('team_id', team.id));
    assert.deepEqual(members, [{ user_id: users[index].id, role: 'owner' }]);
    let draft = await resource(index, entry.draftId);
    if (!draft) {
      const result = unwrap(await client.rpc('lumen_save_resource', { p_id: entry.draftId, p_team_id: team.id, p_kind: 'presentation', p_name: entry.draftName,
        p_document: { schemaVersion: 1, items: [{ id: randomUUID(), type: 'text', title: `Workspace ${index + 1} only`, body: `Private QA content ${index + 1}` }] }, p_base_revision: 0, p_operation_id: randomUUID() }));
      assert.equal(result.status, 'saved'); draft = result.resource;
    }
    assert.equal(draft.team_id, team.id); assert.equal(draft.name, entry.draftName);
  }
  assert.notEqual(report.workspaces[0].id, report.workspaces[1].id);
  check('Each account owns a separate QA workspace and private draft; earlier shared memberships and profiles are untouched.');
  stage = 'real row-level isolation';
  for (let index = 0; index < 2; index++) {
    const other = report.workspaces[1 - index], own = report.workspaces[index], client = clients[index];
    for (const [table, column] of [['lumen_teams', 'id'], ['lumen_memberships', 'team_id'], ['lumen_resources', 'team_id']]) {
      assert.deepEqual(unwrap(await client.from(table).select('*').eq(column, other.id)), [], `${table}: foreign rows must be invisible.`);
    }
    const prior = await resource(1 - index, other.draftId), ownPrior = await resource(index, own.draftId);
    for (const [id, baseRevision] of [[other.draftId, prior.revision], [randomUUID(), 0], [own.draftId, ownPrior.revision]]) {
      const denied = await client.rpc('lumen_save_resource', { p_id: id, p_team_id: other.id, p_kind: 'presentation', p_name: 'Forbidden cross-workspace edit', p_document: { schemaVersion: 1, items: [] }, p_base_revision: baseRevision, p_operation_id: randomUUID() });
      assert.equal(denied.error?.code, '42501', 'Foreign create/edit/move must be denied by actual RLS/RPC authority.');
    }
    const retarget = await client.rpc('lumen_save_resource', { p_id: other.draftId, p_team_id: own.id, p_kind: 'presentation', p_name: 'Forbidden UUID retarget', p_document: { schemaVersion: 1, items: [] }, p_base_revision: prior.revision, p_operation_id: randomUUID() });
    assert.equal(retarget.error?.code, '42501', 'An authorized workspace must not permit capturing another workspace’s existing resource ID.');
    for (const [name, args] of [['lumen_create_invite', { p_team_id: other.id, p_role: 'editor' }], ['lumen_set_member_role', { p_team_id: other.id, p_user_id: users[index].id, p_role: 'owner' }]]) {
      assert.equal((await client.rpc(name, args)).error?.code, '42501');
    }
    assert.deepEqual(await resource(1 - index, other.draftId), prior); assert.deepEqual(await resource(index, own.draftId), ownPrior);
  }
  check('Foreign teams, memberships and drafts are hidden; cross-workspace create/edit/move, invitation and role changes are rejected without mutation.');
  stage = 'private Realtime authorization';
  for (let index = 0; index < 2; index++) {
    const own = await joinRoom(clients[index], report.workspaces[index].id);
    report.realtime.push({ account: index + 1, scope: 'own', status: own.status });
    assert.equal(own.status, 'SUBSCRIBED', 'Own private activity room must work.');
    assert.equal(await own.channel.track({ userId: users[index].id, name: `QA ${index + 1}` }), 'ok');
    const foreign = await joinRoom(clients[index], report.workspaces[1 - index].id);
    report.realtime.push({ account: index + 1, scope: 'foreign', status: foreign.status, message: foreign.message });
    await clients[index].removeChannel(foreign.channel);
    assert.equal(foreign.status, 'CHANNEL_ERROR', 'A timeout is not proof: foreign private activity must be explicitly rejected.');
    assert.match(foreign.message ?? '', /authoriz|permission|forbidden|not allowed|not have/i);
    await clients[index].removeChannel(own.channel);
  }
  check('Both own private Realtime rooms accept presence; both foreign workspace rooms explicitly reject access.');
  stage = 'disposable bound stations and separate browser accounts';
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  watch = await createWorkspaceWatchHarness({ workspaceIds: report.workspaces.map(item => item.id), browser });
  for (const station of watch.stations) secrets.add(new URL(station.privateUrl).hash.slice(5));
  const pages = [];
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } }); contexts.push(context);
    const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(25000);
    page.on('pageerror', error => report.browserErrors.push(safeError(error)));
    await uiLogin(page, index, watch.stations[index].base);
    const options = await page.getByLabel('Team workspace', { exact: true }).locator('option').evaluateAll(elements => elements.map(element => element.value));
    assert.ok(options.includes(report.workspaces[index].id)); assert.ok(!options.includes(report.workspaces[1 - index].id));
    assert.equal(await page.locator('.team-resource').filter({ hasText: report.workspaces[1 - index].draftName }).count(), 0);
    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Team preferences' });
    assert.equal(await dialog.getByLabel('Workspace ID', { exact: true }).inputValue(), report.workspaces[index].id);
    await dialog.getByText('Station provisioned for this workspace', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.team-resource').filter({ hasText: report.workspaces[index].draftName }).click();
    await page.mouse.move(600, 300);
  }
  for (const page of pages) assert.equal(await page.locator('.team-remote-cursor').count(), 0);
  check('Real UI sign-ins use separate browser storage, show only authorized workspaces/drafts, and match their provisioned station identities.');
  stage = 'offline outbox remains in own workspace';
  const unchangedB = await resource(1, report.workspaces[1].draftId);
  await contexts[0].setOffline(true);
  assert.equal(await pages[0].evaluate(() => navigator.onLine), false);
  const offlineText = `Workspace A offline edit ${report.startedAt}`;
  await pages[0].getByRole('complementary', { name: 'Draft properties' }).getByLabel('Content', { exact: true }).fill(offlineText);
  await pages[0].getByRole('button', { name: 'Save draft', exact: true }).click();
  await pages[0].locator('.team-pending').waitFor();
  assert.notEqual((await resource(0, report.workspaces[0].draftId)).document.items[0].body, offlineText);
  await contexts[0].setOffline(false);
  await until(async () => (await resource(0, report.workspaces[0].draftId)).document.items[0].body === offlineText && await pages[0].locator('.team-pending').count() === 0, 'A durable edit acknowledged in A only', 50000);
  assert.deepEqual(await resource(1, report.workspaces[1].draftId), unchangedB);
  assert.equal(await pages[1].locator('.team-resource').filter({ hasText: report.workspaces[0].draftName }).count(), 0);
  await pages[0].reload();
  await uiLogin(pages[0], 0, watch.stations[0].base);
  await pages[0].locator('.team-resource').filter({ hasText: report.workspaces[0].draftName }).click();
  assert.equal(await pages[0].getByRole('complementary', { name: 'Draft properties' }).getByLabel('Content', { exact: true }).inputValue(), offlineText);
  check('An offline edit queues durably, syncs back to workspace A after reconnect and survives reload; workspace B stays unchanged.');
  stage = 'wrong station import and export guards';
  const snapshot = await watch.stations[1].request.get(`${watch.stations[1].base}/api/studio`).then(response => response.json());
  const page = await contexts[0].newPage(); page.setDefaultTimeout(25000);
  await uiLogin(page, 0, watch.stations[1].base);
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Team preferences' });
  await dialog.getByText('Station belongs to a different workspace', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.team-resource').filter({ hasText: report.workspaces[0].draftName }).click();
  for (const name of ['Use on this station', 'Copy selected station drafts']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'This station belongs to a different workspace.' }).waitFor();
  }
  assert.deepEqual(await watch.stations[1].request.get(`${watch.stations[1].base}/api/studio`).then(response => response.json()), snapshot);
  assert.deepEqual(await resource(1, report.workspaces[1].draftId), unchangedB);
  await page.close();
  check('Workspace A cannot copy drafts to or from a workspace B station; its scene, Program and Main audio remain unchanged.');
  stage = 'real Program and Main audio over tenant Watch';
  for (const label of await watch.runChecks()) check(label);
  for (let index = 0; index < 2; index++) {
    await pages[index].screenshot({ path: `/private/tmp/lumen-real-workspace-account-${index + 1}.png`, fullPage: true, mask: [pages[index].locator('[data-team-private]'), pages[index].locator('input[type=password]')] });
  }
  assert.deepEqual(report.browserErrors, []);
  stage = 'station preservation';
  assert.deepEqual(await hashes(), before);
  report.stationFilesUnchanged = true; report.protectedFiles = tracked;
  check('Existing station scenes/content, saved stream keys, Main audio, workspace identity and saved output-link files are byte-for-byte unchanged.');
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); await persist();
  console.log(`Real workspace isolation passed. Sanitized private report: ${reportPath}`);
  console.log('Public Watch is intentionally public. VPS deployment and PowerSync source replication are not claimed by these local tests.');
} catch (error) {
  report.status = 'failed'; report.failedStage = stage; report.message = safeError(error); report.finishedAt = new Date().toISOString();
  report.stationFilesUnchanged = JSON.stringify(await hashes()) === JSON.stringify(before);
  await persist(); console.error(`Workspace isolation failed at ${stage}: ${report.message}`); process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await watch?.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const client of clients) { await client.removeAllChannels().catch(() => {}); await client.auth.signOut({ scope: 'local' }).catch(() => {}); }
}
