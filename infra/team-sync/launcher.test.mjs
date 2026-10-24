import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalConfig, parseTeamSyncArgs, sanitizeDockerEnvironment, validatePrivateConfig, LAB_HOST, LAB_JWKS, PS_IMAGE } from '../../scripts/team-sync.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = () => ({ version: 1, sourcePassword: 'a'.repeat(43), sourceCaPem: '-----BEGIN CERTIFICATE-----\nY2VydA==\n-----END CERTIFICATE-----\n', sourceRoleVerified: true, bucketAdminPassword: 'b'.repeat(43), bucketPassword: 'c'.repeat(43) });

test('CLI rejects remote/docker overrides and unknown commands', () => {
  for (const name of ['setup', 'doctor', 'rules', 'check', 'up', 'status', 'down', 'help']) assert.equal(parseTeamSyncArgs([name]), name);
  for (const args of [[], ['up', '--volumes'], ['down', '-f', 'other.yaml'], ['logs'], ['reset']]) assert.throws(() => parseTeamSyncArgs(args));
});

test('inherited Compose, PowerSync and Docker overrides cannot change the stack', () => {
  assert.deepEqual(sanitizeDockerEnvironment({ PATH: '/test', COMPOSE_FILE: 'other.yaml', COMPOSE_PROJECT_NAME: 'prod', DOCKER_HOST: 'tcp://remote:2375', DOCKER_CONTEXT: 'remote', PS_SOURCE_PASSWORD: 'secret' }), { PATH: '/test' });
});

test('config refuses empty source credentials, unverified grants, invalid CA and injected endpoints', () => {
  assert.equal(validatePrivateConfig(fixture()).version, 1);
  for (const changes of [{ sourcePassword: '' }, { sourceRoleVerified: false }, { sourceCaPem: '' }, { sourcePassword: 'secret\n'.repeat(10) }, { bucketPassword: 'b'.repeat(43) }, { sourceHost: 'evil.example' }, { version: 2 }]) assert.throws(() => validatePrivateConfig({ ...fixture(), ...changes }));
});

test('setup generates private distinct bucket passwords, no source credential, and never overwrites', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-team-sync-test-'));
  try {
    const runtime = path.join(temporary, '.runtime');
    const filename = await createLocalConfig(runtime), original = await fs.readFile(filename, 'utf8');
    const data = JSON.parse(original);
    assert.equal(data.sourcePassword, '');
    assert.equal(data.sourceRoleVerified, false);
    assert.match(data.bucketPassword, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(data.bucketAdminPassword, data.bucketPassword);
    if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    await assert.rejects(createLocalConfig(runtime), /already exists/);
    assert.equal(await fs.readFile(filename, 'utf8'), original);
    const link = path.join(temporary, 'link');
    await fs.symlink(runtime, link, 'dir');
    await assert.rejects(createLocalConfig(link), /symlink/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('compose and service are loopback-only, pinned, bounded and never mount station data', async () => {
  const compose = await fs.readFile(path.join(directory, 'compose.yaml'), 'utf8');
  const service = await fs.readFile(path.join(directory, 'service.yaml'), 'utf8');
  assert.ok(compose.includes(PS_IMAGE));
  assert.match(compose, /postgres:17\.11-alpine@sha256:[a-f0-9]{64}/);
  assert.match(compose, /127\.0\.0\.1:8189:8080/);
  assert.equal((compose.match(/ports:/g) ?? []).length, 1);
  assert.match(compose, /mem_limit: 768m/);
  assert.match(compose, /enable_ipv6: true/);
  assert.doesNotMatch(compose, /privileged: true|network_mode: host|\.\.\/\.\.\/data|docker\.sock|\/var\/run/);
  assert.match(service, /sslmode: verify-full/);
  assert.ok(service.includes(LAB_HOST));
  assert.ok(service.includes(LAB_JWKS));
  assert.match(service, /username: lumen_sync_replica/);
  assert.match(service, /audience: \[authenticated\]/);
  assert.doesNotMatch(service, /api_tokens|supabase_jwt_secret|service_role/);
});

test('every stream is filtered through an authenticated membership and includes no private tables', async () => {
  const config = await fs.readFile(path.join(directory, 'sync-config.yaml'), 'utf8');
  assert.equal((config.match(/auto_subscribe: true/g) ?? []).length, 5);
  assert.equal((config.match(/user_id = auth\.user_id\(\)/g) ?? []).length, 5);
  assert.doesNotMatch(config, /SELECT \*|subscription\.parameter|auth\.parameter|auth\.(sessions|users)|lumen_invites|lumen_operations|stream_key|main_audio/);
  for (const table of ['lumen_teams', 'lumen_memberships', 'lumen_profiles', 'lumen_resources']) assert.ok(config.includes(`public.${table}`));
});
