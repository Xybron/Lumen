import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createEvaluationSecrets, evaluationDirectory } from './setup.mjs';

test('evaluation credentials are strong, private, independently generated and never overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-powersync-test-'));
  try {
    const { environmentPath, privateKeyPath } = await createEvaluationSecrets(directory);
    const environment = Object.fromEntries((await readFile(environmentPath, 'utf8')).split('\n')
      .filter(line => line && !line.startsWith('#')).map(line => line.split(/=(.*)/s).slice(0, 2)));
    const passwords = ['PS_DB_ADMIN_PASSWORD', 'PS_REPLICATION_PASSWORD', 'PS_STORAGE_PASSWORD'].map(key => environment[key]);
    assert(passwords.every(value => /^[\w-]{43}$/.test(value)));
    assert.equal(new Set(passwords).size, 3);
    const privateKey = await readFile(privateKeyPath, 'utf8');
    const publicKey = createPublicKey({ key: { kty: 'RSA', n: environment.PS_JWK_N, e: 'AQAB' }, format: 'jwk' });
    const message = Buffer.from('local-evaluation');
    assert(verify('RSA-SHA256', message, publicKey, sign('RSA-SHA256', message, privateKey)));
    if (process.platform !== 'win32') {
      assert.equal((await stat(environmentPath)).mode & 0o777, 0o600);
      assert.equal((await stat(privateKeyPath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, '.runtime'))).mode & 0o777, 0o700);
    }
    await assert.rejects(createEvaluationSecrets(directory), /Refusing to overwrite/);
    assert.equal(await readFile(privateKeyPath, 'utf8'), privateKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('evaluation refuses redirected credential directories', async context => {
  if (process.platform === 'win32') {
    context.skip('Symlink creation may require elevated permissions on Windows.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'lumen-powersync-symlink-'));
  const target = await mkdtemp(join(tmpdir(), 'lumen-powersync-target-'));
  try {
    await symlink(target, join(directory, '.runtime'), 'dir');
    await assert.rejects(createEvaluationSecrets(directory), /not a symlink/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('scaffold keeps pinned images, a loopback-only API and an owner-filtered sample', async () => {
  const compose = await readFile(join(evaluationDirectory, 'compose.yaml'), 'utf8');
  const service = await readFile(join(evaluationDirectory, 'service.yaml'), 'utf8');
  const streams = await readFile(join(evaluationDirectory, 'sync-config.yaml'), 'utf8');
  assert.equal((compose.match(/image: .*@sha256:[a-f0-9]{64}/g) ?? []).length, 2);
  assert.match(compose, /127\.0\.0\.1:8188:8080/);
  assert.match(compose, /internal: true/);
  assert(!compose.includes('supabase.co'));
  assert(!compose.includes('../../data'));
  assert(!compose.includes(':latest'));
  assert.match(service, /audience: \[lumen-local-evaluation\]/);
  assert.match(service, /disable_telemetry_sharing: true/);
  assert.match(streams, /WHERE owner_id = auth\.user_id\(\)/);
  assert(!streams.includes('SELECT *'));
});

test('Docker Compose accepts the isolated manifest without displaying credentials', async context => {
  const installed = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (installed.error?.code === 'ENOENT' || installed.status !== 0) {
    context.skip('Docker Compose is not installed; no runtime test was attempted.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'lumen-powersync-compose-'));
  try {
    const { environmentPath } = await createEvaluationSecrets(directory);
    const result = spawnSync('docker', ['compose', '--env-file', environmentPath, '-f', join(evaluationDirectory, 'compose.yaml'), 'config', '--quiet'], { encoding: 'utf8', timeout: 15_000 });
    // config --quiet validates locally, without connecting to the Docker daemon.
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
