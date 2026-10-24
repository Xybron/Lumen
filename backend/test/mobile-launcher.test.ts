import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mobileAddresses, parseMobileArgs, readMobileSettings, setupMobile } from '../../scripts/mobile-local.mjs';

test('mobile launcher is opt-in with explicit private LAN address and separate port', () => {
  assert.deepEqual(parseMobileArgs([]), { mode: 'start', address: null, port: 4433, help: false });
  assert.deepEqual(parseMobileArgs(['setup', '--address', '192.168.1.7', '--port', '4444']), { mode: 'setup', address: '192.168.1.7', port: 4444, help: false });
  for (const address of ['127.0.0.1', '0.0.0.0', '1.2.3.4', '192.168.1.999', '192.168.001.1', '192.168.1.1.attacker.test', '::1', 'localhost']) assert.throws(() => parseMobileArgs(['setup', '--address', address]));
  for (const port of ['0', '80', '65536', '3000', '5173', '4e3', '4444oops', '']) assert.throws(() => parseMobileArgs(['setup', '--port', port]));
  for (const args of [['--unknown', '1'], ['__proto__', '1'], ['--address'], ['--port'], ['setup', '--port=4444']]) assert.throws(() => parseMobileArgs(args));
});

test('mobile CLI help and production refusal do not create private settings or start listeners', async () => {
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-mobile-cli-'));
  try {
    const script = fileURLToPath(new URL('../../scripts/mobile-local.mjs', import.meta.url));
    const help = spawnSync(process.execPath, [script, '--help'], { cwd: owned, encoding: 'utf8', timeout: 10000 });
    assert.equal(help.status, 0); assert.match(help.stdout, /never installs trust or changes firewall/i);
    const production = spawnSync(process.execPath, [script, 'start'], { cwd: owned, env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(production.status, 1); assert.match(production.stderr, /development-only/);
    assert.deepEqual(await fs.readdir(owned), []);
  } finally { await fs.rm(owned, { recursive: true, force: true }); }
});

test('mobile TLS setup makes a scoped certificate, protects keys and never overwrites an existing trust anchor', { timeout: 30000 }, async t => {
  const address = mobileAddresses()[0];
  if (!address) { t.skip('No private LAN interface is connected.'); return; }
  const tool = process.env.LUMEN_OPENSSL_PATH ?? 'openssl';
  if (spawnSync(tool, ['version'], { timeout: 3000 }).status !== 0) { t.skip('OpenSSL is required for local certificate generation.'); return; }
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-mobile-tls-'));
  try {
    const settings = await setupMobile({ address, port: 4433 }, owned);
    const loaded = await readMobileSettings(owned);
    assert.equal(loaded.origin, `https://${address}:4433`);
    assert.equal(new X509Certificate(await fs.readFile(loaded.cert)).checkIP(address), address);
    assert.equal(new X509Certificate(await fs.readFile(loaded.ca)).fingerprint256, settings.fingerprint);
    const before = await fs.readFile(loaded.key);
    await assert.rejects(setupMobile({ address, port: 4433 }, owned), /already exists/);
    assert.deepEqual(await fs.readFile(loaded.key), before);
    if (process.platform !== 'win32') {
      for (const file of ['settings.json', 'tls/server-key.pem', 'tls/ca-key.pem']) assert.equal((await fs.stat(path.join(owned, file))).mode & 0o077, 0);
      await fs.chmod(loaded.key, 0o644);
      await assert.rejects(readMobileSettings(owned), /private files/);
    }
  } finally { await fs.rm(owned, { recursive: true, force: true }); }
});

test('mobile setup refuses disconnected/public IPs before creating files', async () => {
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-mobile-refuse-'));
  try {
    const absent = path.join(owned, 'not-created');
    await assert.rejects(setupMobile({ address: '8.8.8.8', port: 4433 }, absent), /private address/);
    await assert.rejects(fs.access(absent), { code: 'ENOENT' });
  } finally { await fs.rm(owned, { recursive: true, force: true }); }
});
