import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertLocalPortAvailable, localWatchEnvironment, parseLocalWatchArgs } from '../../scripts/dev-watch.mjs';

test('local Watch launcher uses explicit default ports and supports help without starting services', () => {
  assert.deepEqual(parseLocalWatchArgs([]), { backendPort: 3000, studioPort: 5173, watchPort: 3480, help: false });
  for (const help of ['--help', '-h']) {
    assert.deepEqual(parseLocalWatchArgs([help]), { backendPort: 3000, studioPort: 5173, watchPort: 3480, help: true });
  }
  assert.deepEqual(parseLocalWatchArgs(['--backend-port', '4401', '--studio-port', '4402', '--watch-port', '4403']), {
    backendPort: 4401, studioPort: 4402, watchPort: 4403, help: false,
  });
  assert.deepEqual(parseLocalWatchArgs(['--backend-port', '1', '--studio-port', '65535', '--watch-port', '2']), {
    backendPort: 1, studioPort: 65535, watchPort: 2, help: false,
  });
});

test('local Watch ports reject malformed, missing, unknown and colliding arguments', () => {
  for (const name of ['--backend-port', '--studio-port', '--watch-port']) {
    for (const value of ['0', '-1', '65536', '1.5', '0x1234', 'NaN', 'Infinity', ' 4401', '4401 ', '', '4401extra']) {
      assert.throws(() => parseLocalWatchArgs([name, value]), /port from 1 to 65535/, `${name} ${JSON.stringify(value)}`);
    }
    assert.throws(() => parseLocalWatchArgs([name]), /port from 1 to 65535/);
  }
  for (const args of [['--unknown', '4401'], ['constructor', '4401'], ['toString', '4401'], ['__proto__', '4401'], ['4401'], ['--watch-port=4401'], ['--watch-port', '--help']]) {
    assert.throws(() => parseLocalWatchArgs(args), /port from 1 to 65535/);
  }
  for (const args of [
    ['--backend-port', '5173'],
    ['--studio-port', '3480'],
    ['--watch-port', '3000'],
    ['--backend-port', '4401', '--studio-port', '4401', '--watch-port', '4402'],
  ]) assert.throws(() => parseLocalWatchArgs(args), /must use different ports/);
});

test('local Watch child environment removes outward connectors without changing station paths or caller environment', () => {
  const source = {
    NODE_ENV: 'development', HOST: '0.0.0.0', PORT: '9999', LUMEN_DEV_BACKEND_PORT: '9999',
    LUMEN_DATA_DIR: '/explicit/station-data', LUMEN_STATION_ID: 'existing-station',
    LUMEN_WATCH_RELAY_URL: 'https://watch.example.invalid', LUMEN_WATCH_RELAY_TOKEN: 'private-publishing-token',
    LUMEN_WATCH_RELAY_SLUG: 'existing-service', LUMEN_WATCH_RELAY_ANY_FUTURE_SETTING: 'outward',
    LUMEN_VPS_URL: 'wss://control.example.invalid', LUMEN_VPS_TOKEN: 'private-bridge-token',
    LUMEN_MEDIA_CTRL: 'http://media.example.invalid', LUMEN_RENDERER_URL: 'https://studio.example.invalid',
    PATH: '/existing/path', UNRELATED_SETTING: 'preserved',
  };
  const before = { ...source };
  const result = localWatchEnvironment(source, 4401);
  assert.notEqual(result, source);
  assert.deepEqual(source, before);
  assert.equal(result.NODE_ENV, 'development');
  assert.equal(result.HOST, '127.0.0.1');
  assert.equal(result.PORT, '4401');
  assert.equal(result.LUMEN_DEV_BACKEND_PORT, '4401');
  assert.equal(result.LUMEN_DATA_DIR, source.LUMEN_DATA_DIR);
  assert.equal(result.LUMEN_STATION_ID, source.LUMEN_STATION_ID);
  assert.equal(result.PATH, source.PATH);
  assert.equal(result.UNRELATED_SETTING, source.UNRELATED_SETTING);
  for (const name of Object.keys(source)) if (name.startsWith('LUMEN_WATCH_RELAY_') || ['LUMEN_VPS_URL', 'LUMEN_VPS_TOKEN', 'LUMEN_MEDIA_CTRL', 'LUMEN_RENDERER_URL'].includes(name)) {
    assert.equal(Object.hasOwn(result, name), false, `${name} must not enter a local test child`);
  }
  assert.equal(Object.hasOwn(localWatchEnvironment({}, 4402), 'LUMEN_DATA_DIR'), false, 'Environment helper must not invent another station data path.');
});

test('occupied local ports fail without interrupting their existing service', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('existing service still running'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(await (await fetch(origin)).text(), 'existing service still running');
    await assert.rejects(assertLocalPortAvailable(address.port, 'Watch'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`Watch port ${address.port} is already in use`));
      assert.match(error.message, /no running process was changed/);
      return true;
    });
    assert.equal(server.listening, true);
    assert.equal(await (await fetch(origin)).text(), 'existing service still running');
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await assertLocalPortAvailable(address.port, 'Watch');
});

test('production CLI refuses local Watch before initializing station data or child services', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-local-watch-cli-'));
  const stationData = path.join(directory, 'must-not-be-created');
  const launcher = fileURLToPath(new URL('../../scripts/dev-watch.mjs', import.meta.url));
  try {
    const result = spawnSync(process.execPath, [launcher], {
      cwd: directory, env: { ...process.env, NODE_ENV: 'production', LUMEN_DATA_DIR: stationData },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Local Watch is a development launcher/);
    assert.doesNotMatch(result.stdout, /listening|Local Watch test ready/);
    await assert.rejects(fs.access(stationData), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
