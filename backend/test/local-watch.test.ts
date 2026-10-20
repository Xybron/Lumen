import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { validateLocalWatchConfig, assertLocalWatchPortsAvailable, loopbackPortInUse } from '../src/local-watch-server.js';
import { acquireStationLock } from '../src/station-lock.js';
import { createBroadcastRelay, createWatchRelayFromEnv } from '../src/broadcast-relay.js';
import { createBroadcast } from '../src/broadcast.js';

const settings = () => ({ version: 1, profile: '720p', recordOnStart: false,
  destinations: [{ id: 'youtube', enabled: false }, { id: 'facebook', enabled: false }], watch: { enabled: true } });
async function temporaryConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-local-watch-')), broadcastDirectory = path.join(directory, 'broadcast');
  await fs.mkdir(broadcastDirectory, { mode: 0o700 });
  return { directory, config: { t: 'local-watch-config' as const, relayUrl: 'http://127.0.0.1:3480', token: randomBytes(48).toString('hex'), broadcastDirectory, backendPort: 3479, frontendUrl: 'http://127.0.0.1:5179' } };
}
async function unusedPort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}

test('local Watch accepts only literal loopback IPC origins and an empty private temporary directory', async () => {
  const { directory, config } = await temporaryConfig();
  try {
    assert.deepEqual(await validateLocalWatchConfig(config), config);
    assert.equal((await validateLocalWatchConfig({ ...config, relayUrl: 'http://127.0.0.1' })).relayUrl, 'http://127.0.0.1');
    await assert.rejects(validateLocalWatchConfig({ ...config, relayUrl: 'http://127.0.0.1', frontendUrl: 'http://127.0.0.1:80' }), /separate local ports/);
    for (const relayUrl of ['https://127.0.0.1:3480', 'http://localhost:3480', 'http://127.0.0.2:3480', 'http://10.0.0.1:3480', 'http://user:private@127.0.0.1:3480', 'http://127.0.0.1:3480/path', 'http://127.0.0.1:3480?token=private', 'http://127.0.0.1:65536']) await assert.rejects(validateLocalWatchConfig({ ...config, relayUrl }), /startup message is invalid/);
    await assert.rejects(validateLocalWatchConfig({ ...config, arbitrary: true }), /startup message is invalid/);
    await assert.rejects(validateLocalWatchConfig({ ...config, backendPort: 3480 }), /separate local ports/);
    await assert.rejects(validateLocalWatchConfig({ ...config, broadcastDirectory: path.join(os.tmpdir(), 'broadcast') }), /private temporary/);
    const filename = path.join(config.broadcastDirectory, 'broadcast-private.json'), keyed = { ...settings(), destinations: [{ id: 'youtube', enabled: false, key: 'private-test-key' }, { id: 'facebook', enabled: false }] };
    await fs.writeFile(filename, JSON.stringify(keyed)); const before = await fs.readFile(filename);
    await assert.rejects(validateLocalWatchConfig(config), /empty private temporary/); assert.deepEqual(await fs.readFile(filename), before);
    await fs.unlink(filename); await fs.chmod(config.broadcastDirectory, 0o755);
    await assert.rejects(validateLocalWatchConfig(config), /empty private temporary/);
    const normal = createWatchRelayFromEnv({ LUMEN_WATCH_RELAY_URL: config.relayUrl, LUMEN_WATCH_RELAY_TOKEN: config.token, LUMEN_WATCH_RELAY_SLUG: 'live', LUMEN_ALLOW_LOCAL_WATCH: 'true' });
    assert.equal(normal.configured, false, 'Normal environment configuration never gains a loopback bypass.');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('local Watch clones saved social setup read-only and supports every destination only after explicit start', async () => {
  const { directory, config } = await temporaryConfig();
  const source = path.join(directory, 'saved-private.json'), saved = { ...settings(), profile: '1080p', recordOnStart: true, watch: { enabled: false },
    destinations: [{ id: 'youtube', enabled: true, key: 'fixture-youtube-private' }, { id: 'facebook', enabled: false, key: 'fixture-facebook-private' }] };
  await fs.writeFile(source, JSON.stringify(saved), { mode: 0o640 }); const original = await fs.readFile(source), mode = (await fs.stat(source)).mode;
  const spawned: string[] = [];
  const service = await createBroadcast({ dir: config.broadcastDirectory, localWatch: true, initialConfigPath: source,
    watchRelay: { configured: true, publicUrl: `${config.relayUrl}/watch/live`, async begin() {}, async publish() {}, async finish() {} },
    spawn(_file, args, options) {
      spawned.push(args.includes('-rtmp_tcurl') ? 'social' : args.at(-1) === 'pipe:1' ? 'encoder' : 'watch');
      return spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], options);
    } });
  try {
    assert.equal(service.snapshot().mode, 'local-watch'); assert.equal(service.snapshot().preflight.ready, true);
    assert.equal(service.snapshot().config.profile, '1080p'); assert.equal(service.snapshot().config.recordOnStart, true); assert.equal(service.snapshot().session, null);
    assert.deepEqual(service.snapshot().config.destinations, [{ id: 'youtube', enabled: true, configured: true }, { id: 'facebook', enabled: false, configured: true }]);
    const filename = path.join(config.broadcastDirectory, 'broadcast-private.json'); assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), { ...saved, watch: { enabled: true } });
    await service.configure({ destinations: [{ id: 'youtube', enabled: true, streamKey: 'fixture-new-youtube' }, { id: 'facebook', enabled: false, clearKey: true }] });
    await service.configure({ destinations: [{ id: 'facebook', enabled: true, streamKey: 'fixture-new-facebook' }] });
    assert.equal(spawned.length, 0, 'Restored enabled states and Save setup never start a public stream.');
    assert.doesNotMatch(JSON.stringify(service.snapshot()), /fixture-youtube-private|fixture-facebook-private|fixture-new-youtube|fixture-new-facebook/);
    assert.deepEqual(await fs.readFile(source), original); assert.equal((await fs.stat(source)).mode, mode);
    await service.start(); const deadline = Date.now() + 3000;
    while (Date.now() < deadline && spawned.length < 4) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(spawned.filter(kind => kind === 'encoder').length, 1); assert.equal(spawned.filter(kind => kind === 'social').length, 2); assert.equal(spawned.filter(kind => kind === 'watch').length, 1);
    await service.stop(); assert.deepEqual(await fs.readFile(source), original);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('an invalid saved setup fails closed without overwriting it or falling back to empty keys', async () => {
  const { directory, config } = await temporaryConfig();
  try {
    const filename = path.join(directory, 'saved-private.json');
    await fs.writeFile(filename, '{private-invalid-fixture-key', { mode: 0o600 });
    const before = await fs.readFile(filename);
    await assert.rejects(createBroadcast({ dir: config.broadcastDirectory, localWatch: true, initialConfigPath: filename }), error => (error as { status?: number }).status === 503 && !String(error).includes('private-invalid-fixture-key'));
    assert.deepEqual(await fs.readFile(filename), before);
    assert.deepEqual(await fs.readdir(config.broadcastDirectory), []);
    await assert.rejects(createBroadcast({ dir: config.broadcastDirectory, initialConfigPath: filename }), { status: 422 });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a station with no saved stream setup gets normal safe defaults plus local Watch', async () => {
  const { directory, config } = await temporaryConfig();
  const service = await createBroadcast({ dir: config.broadcastDirectory, localWatch: true, initialConfigPath: path.join(directory, 'missing-private.json') });
  try {
    const snapshot = service.snapshot(); assert.equal(snapshot.config.profile, '720p'); assert.equal(snapshot.config.recordOnStart, true);
    assert.equal(snapshot.config.watch.enabled, true); assert.ok(snapshot.config.destinations.every(item => !item.enabled && !item.configured)); assert.equal(snapshot.session, null);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('constructor misuse cannot select saved settings as the writable local workspace', async () => {
  const { directory, config } = await temporaryConfig(), savedDirectory = path.join(directory, 'saved'); await fs.mkdir(savedDirectory, { mode: 0o755 });
  const filename = path.join(savedDirectory, 'broadcast-private.json'); await fs.writeFile(filename, JSON.stringify(settings()), { mode: 0o640 });
  const before = await fs.readFile(filename), fileMode = (await fs.stat(filename)).mode, dirMode = (await fs.stat(savedDirectory)).mode;
  try {
    await assert.rejects(createBroadcast({ dir: savedDirectory, localWatch: true, initialConfigPath: filename }), { status: 422 });
    const alias = path.join(directory, 'alias'); await fs.symlink(savedDirectory, alias);
    await assert.rejects(createBroadcast({ dir: alias, localWatch: true, initialConfigPath: filename }), { status: 422 });
    assert.deepEqual(await fs.readFile(filename), before); assert.equal((await fs.stat(filename)).mode, fileMode); assert.equal((await fs.stat(savedDirectory)).mode, dirMode);
    const previous = process.env.LUMEN_DATA_DIR; process.env.LUMEN_DATA_DIR = directory;
    try {
      const { createProduction } = await import('../src/production.js');
      await assert.rejects(createProduction({ backendUrl: 'http://127.0.0.1:1' }, undefined, { localWatch: true }), { status: 422 });
      await assert.rejects(createProduction({ backendUrl: 'http://127.0.0.1:1' }, undefined, { localWatch: true, broadcastDirectory: path.join(directory, 'broadcast') }), { status: 422 });
      await assert.rejects(fs.access(path.join(directory, 'production.json'))); await assert.rejects(fs.access(path.join(directory, 'lumen.db')));
    } finally { if (previous === undefined) delete process.env.LUMEN_DATA_DIR; else process.env.LUMEN_DATA_DIR = previous; }
    assert.deepEqual(await fs.readdir(config.broadcastDirectory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('station lock is exclusive across aliases, conservative for malformed locks, and releases only its owner', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-station-lock-')), alias = path.join(directory, 'alias'), station = path.join(directory, 'station');
  await fs.mkdir(station); await fs.symlink(station, alias); const filename = path.join(station, '.lumen-runtime.lock');
  try {
    const owner = await acquireStationLock(station); assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    await assert.rejects(acquireStationLock(alias), /already in use/); await owner.release(); await owner.release();
    const second = await acquireStationLock(alias); await fs.unlink(filename); await fs.writeFile(filename, 'replacement-lock', { mode: 0o600 });
    await second.release(); assert.equal(await fs.readFile(filename, 'utf8'), 'replacement-lock');
    await assert.rejects(acquireStationLock(station), /already in use/); assert.equal(await fs.readFile(filename, 'utf8'), 'replacement-lock');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('local startup rejects duplicate ports before opening station stores', async () => {
  const { directory, config } = await temporaryConfig();
  try {
    const checked: number[] = [];
    await assertLocalWatchPortsAvailable(config, directory, directory, async port => { checked.push(port); return false; }); assert.deepEqual(checked, [config.backendPort, 3000]);
    checked.length = 0;
    await assertLocalWatchPortsAvailable(config, directory, path.join(directory, 'other'), async port => { checked.push(port); return false; }); assert.deepEqual(checked, [config.backendPort]);
    await assert.rejects(assertLocalWatchPortsAvailable(config, directory, directory, async port => port === 3000), /already running/);
    const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    try { assert.equal(await loopbackPortInUse(address.port), true); } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    assert.equal(await loopbackPortInUse(address.port), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('dedicated local child requires IPC, starts with isolated Watch settings and releases the lock on shutdown', { timeout: 20_000 }, async () => {
  const { directory, config } = await temporaryConfig(), station = path.join(directory, 'station'); await fs.mkdir(station);
  const sourceDirectory = path.join(station, 'broadcast'); await fs.mkdir(sourceDirectory, { mode: 0o700 });
  const sourceFile = path.join(sourceDirectory, 'broadcast-private.json'), saved = { ...settings(), profile: '1080p', recordOnStart: true, watch: { enabled: false }, destinations: [{ id: 'youtube', enabled: true, key: 'fixture-saved-youtube' }, { id: 'facebook', enabled: true, key: 'fixture-saved-facebook' }] };
  await fs.writeFile(sourceFile, JSON.stringify(saved), { mode: 0o600 }); const sourceBefore = await fs.readFile(sourceFile);
  const entry = fileURLToPath(new URL('../src/local-watch-server.ts', import.meta.url));
  const environment = { ...process.env, NODE_ENV: 'development', LUMEN_DATA_DIR: station, LUMEN_VPS_URL: '', LUMEN_VPS_TOKEN: '', LUMEN_MEDIA_CTRL: '', LUMEN_RENDERER_URL: '', LUMEN_WATCH_RELAY_URL: '', LUMEN_WATCH_RELAY_TOKEN: '', LUMEN_WATCH_RELAY_SLUG: '' };
  const noIpc = spawn(process.execPath, ['--import', 'tsx', entry], { env: environment, stdio: 'ignore' }); assert.equal(await new Promise(resolve => noIpc.once('close', resolve)), 1);
  await assert.rejects(fs.access(path.join(station, 'lumen.db')));
  const backendPort = await unusedPort(), relayPort = await unusedPort(), frontendPort = await unusedPort();
  const child = fork(entry, [], { execArgv: ['--import', 'tsx'], env: environment, silent: true }); let output = '';
  child.stdout?.on('data', bytes => { output = (output + bytes).slice(-8000); }); child.stderr?.on('data', bytes => { output = (output + bytes).slice(-8000); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.on('message', value => { const message = value as Record<string, unknown>; if (message.t === 'local-watch-ready') resolve(message); else if (message.t === 'local-watch-error') reject(new Error(String(message.message))); });
      child.once('exit', () => reject(new Error('The local fixture exited before ready.')));
    });
    child.send({ ...config, backendPort, relayUrl: `http://127.0.0.1:${relayPort}`, frontendUrl: `http://127.0.0.1:${frontendPort}` });
    const startup = await ready; assert.equal(startup.backendUrl, `http://127.0.0.1:${backendPort}`); assert.equal(startup.watchUrl, `http://127.0.0.1:${relayPort}/watch/live`);
    const status = await (await fetch(`http://127.0.0.1:${backendPort}/api/studio/status`)).json(); assert.equal(status.state, 'offline'); assert.equal(status.recording, null);
    assert.ok(await fs.stat(path.join(station, '.lumen-runtime.lock'))); assert.deepEqual(await fs.readFile(sourceFile), sourceBefore);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.broadcastDirectory, 'broadcast-private.json'), 'utf8')), { ...saved, watch: { enabled: true } });
    const duplicate = fork(entry, [], { execArgv: ['--import', 'tsx'], env: environment, silent: true }); duplicate.stdout?.resume(); duplicate.stderr?.resume();
    const secondConfig = await temporaryConfig();
    const duplicateExit = new Promise<number | null>(resolve => duplicate.once('exit', resolve));
    const duplicateMessage = new Promise<Record<string, unknown>>(resolve => duplicate.once('message', value => resolve(value as Record<string, unknown>)));
    duplicate.send({ ...secondConfig.config, backendPort: await unusedPort(), relayUrl: `http://127.0.0.1:${relayPort}`, frontendUrl: `http://127.0.0.1:${frontendPort}` });
    assert.equal(await duplicateExit, 1, 'A second backend on another port cannot share the same station stores.');
    assert.match(String((await duplicateMessage).message), /This station is already in use.*runtime lock/);
    assert.deepEqual(await fs.readdir(secondConfig.config.broadcastDirectory), [], 'No saved keys are copied before acquiring the station lock.'); await fs.rm(secondConfig.directory, { recursive: true, force: true });
    assert.equal((await fetch(`http://127.0.0.1:${backendPort}/api/studio/status`)).status, 200, 'Refusing the second backend preserves the first.');
    const before = await fs.readFile(path.join(station, 'production.json')); child.send({ t: 'local-watch-stop' }); assert.equal(await exited, 0);
    await assert.rejects(fs.access(path.join(station, '.lumen-runtime.lock'))); assert.deepEqual(await fs.readFile(path.join(station, 'production.json')), before);
    assert.deepEqual(await fs.readFile(sourceFile), sourceBefore); assert.doesNotMatch(output, new RegExp(config.token)); assert.doesNotMatch(output, /fixture-saved-youtube|fixture-saved-facebook/);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); await exited; await fs.rm(directory, { recursive: true, force: true }); }
});
