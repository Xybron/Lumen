'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { isLocalUrl, isExternalUrl, isPreviewUrl, canGrantPermission, childEnvironment, resourcePath, runtimePaths, availablePort } = require('../app/runtime.cjs');

const origin = 'http://127.0.0.1:43117';
test('desktop permissions and windows stay on the exact station origin', () => {
  assert.equal(isLocalUrl(`${origin}/studio/output/program`, origin), true);
  for (const value of ['http://localhost:43117', 'http://127.0.0.1:3000', 'https://127.0.0.1:43117', `${origin}@evil.example`, 'file:///tmp/a', `${origin.replace('http://', 'http://user@')}/studio`]) assert.equal(isLocalUrl(value, origin), false, value);
  assert.equal(canGrantPermission('media', origin, `${origin}/studio`, origin), true);
  assert.equal(canGrantPermission('media', 'https://example.com', origin, origin), false);
  assert.equal(canGrantPermission('media', origin, 'https://example.com', origin), false);
  assert.equal(canGrantPermission('geolocation', origin, origin, origin), false);
  assert.equal(isPreviewUrl(`blob:${origin}/id`, origin), true);
  assert.equal(isPreviewUrl('blob:https://example.com/id', origin), false);
  assert.equal(isExternalUrl('https://example.com/help'), true);
  for (const value of ['file:///tmp/test', 'javascript:alert(1)', 'shell:explorer', 'https://user:password@example.com']) assert.equal(isExternalUrl(value), false);
});

test('bundled backend cannot inherit development stations, services or Node injection', () => {
  const env = childEnvironment({ PATH: 'safe-path', HOME: '/user', LUMEN_DATA_DIR: '/development', LUMEN_TEAM_ENABLED: 'true', VPS_TOKEN: 'private', MEDIA_ENGINE_URL: 'remote', NODE_OPTIONS: '--require bad', NODE_PATH: '/foreign', ELECTRON_RUN_AS_NODE: '1' }, { LUMEN_DATA_DIR: '/desktop', PORT: '43117' });
  assert.deepEqual(env, { PATH: 'safe-path', HOME: '/user', LUMEN_DATA_DIR: '/desktop', PORT: '43117' });
});

test('manifest paths reject absolute paths and traversal on either platform', () => {
  assert.equal(resourcePath('/app/resources', 'runtime/node'), path.resolve('/app/resources/runtime/node'));
  for (const relative of ['/usr/bin/node', '../node', 'runtime/../../node', 'C:\\node.exe', '\\\\server\\node.exe', 'runtime\\node.exe', '', 'runtime//node']) assert.throws(() => resourcePath('/app/resources', relative));
});

test('runtime validation requires matching platform and contained runtime binaries', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-runtime-test-'));
  try {
    await fs.mkdir(path.join(directory, 'runtime'));
    await fs.writeFile(path.join(directory, 'runtime', 'binary'), 'fixture');
    const manifest = { schemaVersion: 1, platform: process.platform, arch: process.arch, nodeRelativePath: 'runtime/binary', chromiumRelativePath: 'runtime/binary', ffmpegRelativePath: 'runtime/binary', whisperRelativePath: 'runtime/binary', modelRelativePath: 'runtime/binary' };
    const save = value => fs.writeFile(path.join(directory, 'runtime-manifest.json'), JSON.stringify(value));
    await save(manifest);
    assert.equal((await runtimePaths(directory)).node, path.join(await fs.realpath(directory), 'runtime', 'binary'));
    await save({ ...manifest, platform: 'not-this-platform' });
    await assert.rejects(runtimePaths(directory), /does not match/);
    await save({ ...manifest, nodeRelativePath: '../outside' });
    await assert.rejects(runtimePaths(directory), /invalid path/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a running service on the preferred port is preserved and another port is selected', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const occupied = server.address().port;
    const selected = await availablePort(occupied);
    assert.notEqual(selected, occupied);
    assert.ok(selected > 0 && selected <= 65535);
    assert.equal(server.listening, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
