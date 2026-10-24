import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStationWorkspaceAllowsImport, checkStationWorkspaceImport, loadStationWorkspace, parseStationWorkspace, type StationWorkspace } from '../../frontend/src/lib/team/workspace.js';

const teamA = '11111111-1111-4111-8111-111111111111', teamB = '22222222-2222-4222-8222-222222222222';
const metadata = (patch: Partial<StationWorkspace> = {}): StationWorkspace => ({
  id: teamA, createdAt: '2026-10-20T12:00:00.000Z', mode: 'provisioned', configured: true,
  message: 'Station belongs to its provisioned workspace.', ...patch,
});
const reply = (value: unknown): typeof fetch => async () => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('matching provisioned workspace permits an explicit draft import without exposing unrelated metadata', () => {
  const value = { ...metadata(), unexpectedSecret: 'must-not-be-copied' };
  assert.deepEqual(assertStationWorkspaceAllowsImport(value, teamA), metadata());
  assert.equal('unexpectedSecret' in parseStationWorkspace(value), false);
});

test('a provisioned station rejects a different cloud workspace instead of following the selected browser team', () => {
  assert.throws(() => assertStationWorkspaceAllowsImport(metadata(), teamB), /different workspace/);
  assert.throws(() => assertStationWorkspaceAllowsImport(metadata(), 'not-a-workspace'), /active account or workspace changed/);
});

test('an unprovisioned local station still permits the existing explicit import flow without auto-binding', () => {
  const local = metadata({ mode: 'local', configured: false });
  assert.deepEqual(assertStationWorkspaceAllowsImport(local, teamB), local);
  assert.equal(local.id, teamA, 'A cloud selection never changes the station identity.');
  assert.equal(local.configured, false);
});

test('invalid, contradictory or unavailable station metadata fails closed', () => {
  for (const value of [null, [], {}, metadata({ id: 'team-name' }),
    metadata({ id: '../other-station' }), metadata({ createdAt: 'not-a-date' }),
    metadata({ mode: 'local', configured: true }), metadata({ mode: 'provisioned', configured: false }),
    { ...metadata(), configured: 'true' }, { ...metadata(), mode: 'unknown' }, { ...metadata(), message: undefined }, metadata({ message: 'x'.repeat(501) })]) {
    assert.throws(() => parseStationWorkspace(value), /could not be verified/);
  }
  assert.throws(() => parseStationWorkspace(metadata({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() })), /could not be verified/);
});

test('each import reads authoritative no-store metadata with credentials and a bounded request', async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => { calls.push({ input, init }); return new Response(JSON.stringify(metadata())); };
  await checkStationWorkspaceImport(teamA, () => true, fetcher);
  await checkStationWorkspaceImport(teamA, () => true, fetcher);
  assert.equal(calls.length, 2, 'Import authority is never a cached UI result.');
  for (const call of calls) {
    assert.equal(call.input, '/api/workspace'); assert.equal(call.init?.cache, 'no-store'); assert.equal(call.init?.credentials, 'include');
    assert.ok(call.init?.signal instanceof AbortSignal);
    assert.equal(call.init?.method, undefined, 'Metadata checks never write or bind a workspace.');
    assert.equal(call.init?.body, undefined);
  }
});

test('network errors, missing endpoints and invalid JSON cannot become an unbound-station fallback', async () => {
  const unavailable: typeof fetch[] = [async () => { throw new Error('private transport information'); },
    async () => new Response('unavailable', { status: 404 }), async () => new Response('denied', { status: 401 }),
    async () => new Response('not JSON'), reply({})];
  for (const fetcher of unavailable) {
    await assert.rejects(loadStationWorkspace(fetcher), error => error instanceof Error && /could not be verified/.test(error.message) && !error.message.includes('private transport'));
  }
});

test('workspace changes while metadata is pending cancel the former workspace import without local mutation', async () => {
  let selected = teamA, localImports = 0;
  const fetcher: typeof fetch = async () => { selected = teamB; return new Response(JSON.stringify(metadata())); };
  await assert.rejects(async () => { await checkStationWorkspaceImport(teamA, () => selected === teamA, fetcher); localImports++; }, /active account or workspace changed/);
  assert.equal(localImports, 0);
});

test('account changes during response decoding and already-stale requests cannot import', async () => {
  let current = true, calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++; return { ok: true, async json() { current = false; return metadata(); } } as Response;
  };
  await assert.rejects(checkStationWorkspaceImport(teamA, () => current, fetcher), /active account or workspace changed/);
  assert.equal(calls, 1);
  await assert.rejects(checkStationWorkspaceImport(teamA, () => false, fetcher), /active account or workspace changed/);
  assert.equal(calls, 1, 'A stale selection never starts another metadata request.');
});

test('export uses the same workspace gate and cannot enqueue a cloud save for a different station workspace', async () => {
  let uploads = 0;
  await assert.rejects(async () => {
    await checkStationWorkspaceImport(teamB, () => true, reply(metadata()));
    uploads++;
  }, /different workspace/);
  assert.equal(uploads, 0);
});

test('an earlier matching check cannot authorize a later transfer after authoritative station metadata changes', async () => {
  let requests = 0, transfers = 0;
  const fetcher: typeof fetch = async () => new Response(JSON.stringify(metadata({ id: ++requests === 1 ? teamA : teamB })));
  await checkStationWorkspaceImport(teamA, () => true, fetcher);
  await assert.rejects(async () => {
    await checkStationWorkspaceImport(teamA, () => true, fetcher);
    transfers++;
  }, /different workspace/);
  assert.equal(requests, 2); assert.equal(transfers, 0);
});
