import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configuredWorkspaceId, resolveStationWorkspace, WorkspaceIdentityError } from '../src/workspace.js';

const ALPHA = '11111111-1111-4111-8111-111111111111', BETA = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-10-20T12:00:00.000Z';
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-workspace-test-'));
  const sentinels = new Map([
    ['content.json', Buffer.from('{"channels":["unchanged scripture"]}')],
    ['production.json', Buffer.from('{"scenes":["original camera"],"mainAudioSourceId":"preacher","masterMuted":false}')],
    ['broadcast-private.json', Buffer.from('{"key":"fixture-only-not-a-real-key"}')],
  ]);
  for (const [name, bytes] of sentinels) await fs.writeFile(path.join(directory, name), bytes, { mode: 0o600 });
  return { directory, filename: path.join(directory, 'workspace.json'), async unchanged() {
    for (const [name, bytes] of sentinels) assert.deepEqual(await fs.readFile(path.join(directory, name)), bytes);
  } };
}

test('independent offline stations get distinct stable namespaces without changing scenes, keys or Main audio', async () => {
  const a = await fixture(), b = await fixture();
  try {
    const first = await resolveStationWorkspace(a.directory, {}), second = await resolveStationWorkspace(b.directory, {});
    assert.notEqual(first.id, second.id); assert.equal(first.mode, 'local'); assert.equal(first.configured, false);
    assert.match(first.id, /^[0-9a-f-]{36}$/); assert.match(first.message, /Selecting a cloud team never reassigns/);
    assert.equal((await fs.stat(a.filename)).mode & 0o777, 0o600);
    const bytes = await fs.readFile(a.filename);
    assert.deepEqual(await resolveStationWorkspace(a.directory, {}), first); assert.deepEqual(await fs.readFile(a.filename), bytes);
    assert.deepEqual(Object.keys(JSON.parse(bytes.toString())).sort(), ['createdAt', 'id', 'mode', 'version']);
    await a.unchanged(); await b.unchanged();
  } finally { await fs.rm(a.directory, { recursive: true, force: true }); await fs.rm(b.directory, { recursive: true, force: true }); }
});

test('server provisioning uses the existing cloud workspace UUID but grants no authority from the ID', async () => {
  const a = await fixture();
  try {
    const identity = await resolveStationWorkspace(a.directory, { LUMEN_WORKSPACE_ID: ALPHA });
    assert.equal(identity.id, ALPHA); assert.equal(identity.mode, 'provisioned'); assert.equal(identity.configured, true);
    assert.match(identity.message, /does not grant access/);
    const bytes = await fs.readFile(a.filename);
    assert.deepEqual(await resolveStationWorkspace(a.directory, { LUMEN_WORKSPACE_ID: ALPHA }), identity);
    await assert.rejects(resolveStationWorkspace(a.directory, {}), /cannot downgrade it to a local station/);
    assert.deepEqual(await fs.readFile(a.filename), bytes); await a.unchanged();
  } finally { await fs.rm(a.directory, { recursive: true, force: true }); }
});

test('an existing data directory can never be silently rebound to another workspace', async () => {
  const a = await fixture();
  try {
    await resolveStationWorkspace(a.directory, { LUMEN_WORKSPACE_ID: ALPHA }); const bytes = await fs.readFile(a.filename);
    await assert.rejects(resolveStationWorkspace(a.directory, { LUMEN_WORKSPACE_ID: BETA }), /belongs to a different workspace/);
    assert.deepEqual(await fs.readFile(a.filename), bytes); await a.unchanged();
    assert.equal((await fs.readdir(a.directory)).some(name => name.endsWith('.tmp')), false);
  } finally { await fs.rm(a.directory, { recursive: true, force: true }); }
});

test('existing local identity cannot be implicitly promoted or rewritten by a server environment change', async () => {
  const a = await fixture();
  try {
    const identity = await resolveStationWorkspace(a.directory, {}), bytes = await fs.readFile(a.filename);
    await assert.rejects(resolveStationWorkspace(a.directory, { LUMEN_WORKSPACE_ID: identity.id }), /not a provisioned workspace directory/);
    assert.deepEqual(await fs.readFile(a.filename), bytes); await a.unchanged();
  } finally { await fs.rm(a.directory, { recursive: true, force: true }); }
});

test('invalid server workspace IDs fail before creating any identity or station directory', async () => {
  const a = await fixture(), nested = path.join(a.directory, 'not-created');
  try {
    assert.equal(configuredWorkspaceId({}), undefined); assert.equal(configuredWorkspaceId({ LUMEN_WORKSPACE_ID: ALPHA }), ALPHA);
    for (const value of ['', 'my-church', ALPHA.toUpperCase().replace('11111111', 'AAAAAAAA'), ` ${ALPHA}`, '../another-tenant', `${ALPHA}/live`]) {
      await assert.rejects(resolveStationWorkspace(nested, { LUMEN_WORKSPACE_ID: value }), WorkspaceIdentityError);
      await assert.rejects(fs.access(nested), { code: 'ENOENT' });
    }
    await a.unchanged();
  } finally { await fs.rm(a.directory, { recursive: true, force: true }); }
});

test('corrupt, oversized and unexpected identity fields remain blocked without repair or overwrite', async () => {
  const a = await fixture();
  try {
    for (const bytes of ['not-json', 'null', '{}', '[]', 'x'.repeat(2049), JSON.stringify({ version: 2, id: ALPHA, createdAt, mode: 'local' }),
      JSON.stringify({ version: 1, id: ALPHA, createdAt: 'yesterday', mode: 'local' }), JSON.stringify({ version: 1, id: 'church', createdAt, mode: 'local' }),
      JSON.stringify({ version: 1, id: ALPHA, createdAt, admin: true, mode: 'local' }), JSON.stringify({ version: 1, id: ALPHA, createdAt: '2026-10-20', mode: 'local' }),
      JSON.stringify({ version: 1, id: ALPHA, createdAt }), JSON.stringify({ version: 1, id: ALPHA, createdAt, mode: 'admin' })]) {
      await fs.writeFile(a.filename, bytes, { mode: 0o600 }); await assert.rejects(resolveStationWorkspace(a.directory, {}), WorkspaceIdentityError);
      assert.equal(await fs.readFile(a.filename, 'utf8'), bytes);
    }
    await a.unchanged();
  } finally { await fs.rm(a.directory, { recursive: true, force: true }); }
});

test('identity symlinks, hard links, directories and unsafe permissions never get followed, changed or replaced', async () => {
  const a = await fixture(), target = path.join(a.directory, 'private-existing.json'), bytes = JSON.stringify({ version: 1, id: ALPHA, createdAt, mode: 'local' });
  try {
    await fs.writeFile(target, bytes, { mode: 0o600 }); await fs.symlink(target, a.filename);
    await assert.rejects(resolveStationWorkspace(a.directory, {}), WorkspaceIdentityError);
    assert.equal((await fs.lstat(a.filename)).isSymbolicLink(), true); assert.equal(await fs.readFile(target, 'utf8'), bytes);
    await fs.unlink(a.filename); await fs.link(target, a.filename);
    await assert.rejects(resolveStationWorkspace(a.directory, {}), WorkspaceIdentityError); assert.equal(await fs.readFile(target, 'utf8'), bytes);
    await fs.unlink(a.filename); await fs.mkdir(a.filename);
    await assert.rejects(resolveStationWorkspace(a.directory, {}), WorkspaceIdentityError); assert.equal((await fs.stat(a.filename)).isDirectory(), true);
    await fs.rmdir(a.filename); await fs.writeFile(a.filename, bytes, { mode: 0o644 });
    if (process.platform !== 'win32') { await assert.rejects(resolveStationWorkspace(a.directory, {}), WorkspaceIdentityError); assert.equal((await fs.stat(a.filename)).mode & 0o777, 0o644); }
    assert.equal(await fs.readFile(a.filename, 'utf8'), bytes); await a.unchanged();
  } finally { await fs.rm(a.directory, { recursive: true, force: true }); }
});

test('server startup refuses a provisioned workspace mismatch before opening auth or production stores', { timeout: 15000 }, async () => {
  const a = await fixture(), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    await resolveStationWorkspace(a.directory, { LUMEN_WORKSPACE_ID: ALPHA }); const before = await fs.readFile(a.filename);
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^(?:LUMEN_|VITE_|SUPABASE_|POWERSYNC_)/.test(name)) delete env[name];
    Object.assign(env, { LUMEN_DATA_DIR: a.directory, LUMEN_WORKSPACE_ID: BETA, HOST: '127.0.0.1', PORT: '39491', NODE_ENV: 'test' });
    const child = spawn(process.execPath, ['--import', path.join(root, 'backend/node_modules/tsx/dist/loader.mjs'), path.join(root, 'backend/src/server.ts')], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', bytes => { error += bytes.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(exit, 1); assert.match(error, /belongs to a different workspace/);
    for (const file of ['lumen.db', 'production-backups', 'worship.db', 'workspace.json.tmp']) await assert.rejects(fs.access(path.join(a.directory, file)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(a.filename), before); await a.unchanged();
    await assert.rejects(fs.access(path.join(a.directory, '.lumen-runtime.lock')), { code: 'ENOENT' });
  } finally { await fs.rm(a.directory, { recursive: true, force: true }); }
});
