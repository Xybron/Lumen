import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = path.join(root, 'supabase/migrations');
const migration = fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('_lumen_team_collaboration.sql'))!), 'utf8');

test('team schema keeps public entry points invoker-only and requires real sessions', () => {
  const publicFunctions = migration.matchAll(/create function public\.(lumen_\w+)\([\s\S]*?\$\$;/g);
  let count = 0;
  for (const [definition, name] of publicFunctions) {
    assert.match(definition, /security invoker/, name);
    assert.doesNotMatch(definition, /security definer/, name);
    count++;
  }
  assert.equal(count, 6);
  assert.match(migration, /auth\.sessions s join auth\.users u/);
  assert.match(migration, /s\.id::text = \(\(select auth\.jwt\(\)\)->>'session_id'\)/);
  assert.match(migration, /u\.email_confirmed_at is not null or u\.phone_confirmed_at is not null/);
  assert.match(migration, /grant select on public\.lumen_profiles, public\.lumen_teams, public\.lumen_memberships, public\.lumen_resources to authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|all) on public\.lumen_/i);
});

test('all shared tables have RLS, bounded drafts, revision checks and private one-use invitations', () => {
  for (const name of ['profiles','teams','memberships','resources']) {
    assert.match(migration, new RegExp(`alter table public\\.lumen_${name} enable row level security`));
  }
  assert.match(migration, /octet_length\(p_document::text\) > 524288/);
  assert.match(migration, /v_resource\.revision <> p_base_revision/);
  assert.match(migration, /v_operation\.request_hash <> v_hash/);
  assert.match(migration, /expires_at <= now\(\) or v_invite\.used_at is not null/);
  assert.match(migration, /sha256\(convert_to\(v_token, 'UTF8'\)\)/);
  assert.match(migration, /'streamkey'.*'password'/);
  assert.match(migration, /'mainaudio','mainaudiosourceid'/);
  assert.match(migration, /'src','url','sourceid','sources','audio'/);
  assert.match(migration, /lumen-team:/);
});

// Explicit opt-in: never start Docker during ordinary application/unit tests.
// Uses a new network-isolated container, tmpfs and no station files or ports.
test('team schema SQL: tenant isolation, roles, idempotency, conflicts, private presence and session revocation', {
  skip: process.env.LUMEN_TEST_SCHEMA_DOCKER !== '1', timeout: 60000,
}, async () => {
  const name = `lumen-team-schema-${randomUUID()}`;
  const image = 'postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
  const docker = (args: string[], input?: string) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 20000 });
  let created = false;
  try {
    const launched = docker(['run', '--rm', '-d', '--name', name, '--network', 'none', '--memory', '256m', '--cpus', '0.5', '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
    assert.equal(launched.status, 0, launched.stderr);
    created = true;
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(ready, 'Disposable PostgreSQL did not start');
    const fixture = fs.readFileSync(path.join(root, 'supabase/tests/team-schema-fixture.sql'), 'utf8');
    const assertions = fs.readFileSync(path.join(root, 'supabase/tests/team-schema-assertions.sql'), 'utf8');
    const result = docker(['exec','-i',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'], `${fixture}\n${migration}\n${assertions}`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Team schema integration assertions passed/);
  } finally {
    if (created) {
      const stopped = docker(['rm','--force',name]);
      assert.equal(stopped.status, 0, `Could not remove owned disposable test container ${name}: ${stopped.stderr}`);
    }
  }
});
