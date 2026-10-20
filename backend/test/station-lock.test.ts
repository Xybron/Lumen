import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { acquireStationLock, StationInUseError } from '../src/station-lock.js';

const nonce = () => randomBytes(24).toString('hex');
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-station-lease-test-'));
  const sentinels = new Map([
    ['production.json', Buffer.from(JSON.stringify({ scenes: ['unchanged'], program: 'camera', mainAudioSourceId: 'preacher', masterMuted: false }))],
    ['broadcast-private.json', Buffer.from(JSON.stringify({ key: 'fixture-not-a-real-key', enabled: false }))],
  ]);
  for (const [filename, bytes] of sentinels) await fs.writeFile(path.join(directory, filename), bytes, { mode: 0o600 });
  return { directory, filename: path.join(directory, '.lumen-runtime.lock'), async unchanged() {
    for (const [filename, bytes] of sentinels) { assert.deepEqual(await fs.readFile(path.join(directory, filename)), bytes); assert.equal((await fs.stat(path.join(directory, filename))).mode & 0o777, 0o600); }
  } };
}
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
  assert.ok(child.pid); assert.throws(() => process.kill(child.pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH'); return child.pid!;
}
const deadline = <T>(promise: Promise<T>, milliseconds = 10000) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('The disposable lease fixture timed out.')), milliseconds);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

test('a live lease and legacy live PID can never be evicted or rewrite station settings', async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof acquireStationLock>> | undefined;
  try {
    owner = await acquireStationLock(f.directory); const original = await fs.readFile(f.filename);
    await assert.rejects(acquireStationLock(f.directory), StationInUseError); assert.deepEqual(await fs.readFile(f.filename), original); await f.unchanged();
    await owner.release(); owner = undefined;
    const legacy = Buffer.from(JSON.stringify({ pid: process.pid, nonce: nonce() })); await fs.writeFile(f.filename, legacy, { mode: 0o600 });
    await assert.rejects(acquireStationLock(f.directory), StationInUseError); assert.deepEqual(await fs.readFile(f.filename), legacy); await f.unchanged();
  } finally { await owner?.release(); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('a valid legacy lock with a confirmed dead PID is recovered automatically', async () => {
  const f = await fixture(), pid = await deadPid(), oldNonce = nonce(); let owner: Awaited<ReturnType<typeof acquireStationLock>> | undefined;
  try {
    await fs.writeFile(f.filename, JSON.stringify({ pid, nonce: oldNonce }), { mode: 0o600 }); owner = await acquireStationLock(f.directory);
    const current = JSON.parse(await fs.readFile(f.filename, 'utf8')); assert.equal(current.pid, process.pid); assert.notEqual(current.nonce, oldNonce);
    assert.equal((await fs.stat(f.filename)).mode & 0o777, 0o600); await f.unchanged();
    await owner.release(); owner = undefined; await assert.rejects(fs.access(f.filename));
  } finally { await owner?.release(); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('malformed metadata and lock symlinks remain conservatively blocked without touching their targets', async () => {
  const f = await fixture(), pid = await deadPid();
  try {
    for (const bytes of ['not-json', '{}', 'null', JSON.stringify({ pid: String(pid), nonce: nonce() }), JSON.stringify({ pid: 0, nonce: nonce() }), JSON.stringify({ pid, nonce: '' }), 'x'.repeat(16385)]) {
      await fs.writeFile(f.filename, bytes, { mode: 0o600 }); await assert.rejects(acquireStationLock(f.directory), StationInUseError); assert.equal(await fs.readFile(f.filename, 'utf8'), bytes);
    }
    await fs.unlink(f.filename); const target = path.join(f.directory, 'operator-lock-notes.json'), bytes = JSON.stringify({ pid, nonce: nonce() });
    await fs.writeFile(target, bytes, { mode: 0o600 }); await fs.symlink(target, f.filename);
    await assert.rejects(acquireStationLock(f.directory), StationInUseError); assert.equal(await fs.readFile(target, 'utf8'), bytes); assert.equal((await fs.lstat(f.filename)).isSymbolicLink(), true); await f.unchanged();
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('EPERM and unknown PID probe failures never count as confirmed death', async () => {
  const f = await fixture(), pid = await deadPid(), originalKill = process.kill;
  try {
    for (const code of ['EPERM', 'EACCES', 'EIO']) {
      const bytes = JSON.stringify({ pid, nonce: nonce() }); await fs.writeFile(f.filename, bytes, { mode: 0o600 });
      process.kill = ((candidate: number, signal?: NodeJS.Signals | number) => {
        if (candidate === pid) throw Object.assign(new Error('Fixture liveness is unknown.'), { code });
        return originalKill(candidate, signal);
      }) as typeof process.kill;
      try { await assert.rejects(acquireStationLock(f.directory), StationInUseError); } finally { process.kill = originalKill; }
      assert.equal(await fs.readFile(f.filename, 'utf8'), bytes); await f.unchanged();
    }
  } finally { process.kill = originalKill; await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('release is idempotent with a missing path and cannot unlink a replacement owner', async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof acquireStationLock>> | undefined;
  try {
    owner = await acquireStationLock(f.directory); await fs.unlink(f.filename); await owner.release(); await owner.release(); owner = undefined;
    owner = await acquireStationLock(f.directory); const replacement = JSON.stringify({ pid: process.pid, nonce: nonce() });
    // Replacing bytes in the same inode must be protected by the nonce too.
    await fs.writeFile(f.filename, replacement); await owner.release(); await owner.release(); owner = undefined;
    assert.equal(await fs.readFile(f.filename, 'utf8'), replacement); await assert.rejects(acquireStationLock(f.directory), StationInUseError); await f.unchanged();
  } finally { await owner?.release(); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('the persistent OS lease gate refuses symlinks without touching their target', async () => {
  const f = await fixture(), gate = path.join(f.directory, '.lumen-runtime.lease.sqlite'), target = path.join(f.directory, 'operator-notes.txt');
  const bytes = Buffer.from('User-owned notes must never be opened as the SQLite lease.');
  try {
    await fs.writeFile(target, bytes, { mode: 0o600 }); await fs.symlink(target, gate);
    await assert.rejects(acquireStationLock(f.directory)); assert.equal((await fs.lstat(gate)).isSymbolicLink(), true);
    assert.deepEqual(await fs.readFile(target), bytes); await assert.rejects(fs.access(f.filename)); await f.unchanged();
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

function leaseChild(directory: string) {
  const source = `import {acquireStationLock} from ${JSON.stringify(new URL('../src/station-lock.ts', import.meta.url).href)};
const send=value=>new Promise((resolve,reject)=>process.send(value,error=>error?reject(error):resolve()));
const wait=()=>new Promise(resolve=>process.once('message',resolve));
await send({t:'ready'});await wait();let owner;
try{owner=await acquireStationLock(process.argv[1]);}catch(error){await send({t:'blocked',name:error.name});process.exit(0);}
await send({t:'acquired'});await wait();await owner.release();await send({t:'released'});process.exit(0);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const messages: Array<Record<string, unknown>> = [], waiters: Array<() => void> = [];
  child.on('message', value => { messages.push(value as Record<string, unknown>); for (const resolve of waiters.splice(0)) resolve(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  return { child, exited, async next() {
    if (!messages.length) await deadline(new Promise<void>(resolve => waiters.push(resolve)));
    const message = messages.shift(); assert.ok(message); return message;
  } };
}
async function stopChildren(children: Array<{ child: ChildProcess; exited: Promise<number | null> }>) {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(children.map(item => item.exited));
}

test('failed same-process acquisition cannot release the first OS lease to a cross-process contender', { timeout: 15000 }, async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof acquireStationLock>> | undefined;
  const children: ReturnType<typeof leaseChild>[] = [];
  try {
    owner = await acquireStationLock(f.directory); await assert.rejects(acquireStationLock(f.directory), StationInUseError);
    const gate = path.join(f.directory, '.lumen-runtime.lease.sqlite'); assert.equal((await fs.stat(gate)).mode & 0o777, 0o600);
    // Remove only our own disposable metadata to prove the still-held OS lease,
    // not a live PID string, is what blocks a separate process.
    await fs.unlink(f.filename); const contender = leaseChild(f.directory); children.push(contender);
    assert.equal((await contender.next()).t, 'ready'); contender.child.send({ t: 'acquire' }); assert.equal((await contender.next()).t, 'blocked'); assert.equal(await contender.exited, 0);
    await assert.rejects(fs.access(f.filename)); await owner.release(); owner = undefined;
    assert.ok((await fs.stat(gate)).isFile(), 'The lease database remains persistent after release.');
    owner = await acquireStationLock(f.directory); await owner.release(); owner = undefined; await f.unchanged();
  } finally { await owner?.release(); await stopChildren(children); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('concurrent real processes recover one stale lock with exactly one winner', { timeout: 20000 }, async () => {
  const f = await fixture(), pid = await deadPid(), children: ReturnType<typeof leaseChild>[] = [];
  try {
    await fs.writeFile(f.filename, JSON.stringify({ pid, nonce: nonce() }), { mode: 0o600 });
    for (let index = 0; index < 6; index++) children.push(leaseChild(f.directory));
    const ready = await Promise.all(children.map(item => item.next())); assert.ok(ready.every(item => item.t === 'ready'));
    for (const item of children) item.child.send({ t: 'acquire' });
    const results = await Promise.all(children.map(item => item.next())), winners = results.flatMap((item, index) => item.t === 'acquired' ? [index] : []);
    assert.equal(winners.length, 1); assert.equal(results.filter(item => item.t === 'blocked').length, 5);
    assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8')).pid, children[winners[0]].child.pid); await f.unchanged();
    children[winners[0]].child.send({ t: 'release' }); assert.equal((await children[winners[0]].next()).t, 'released');
    assert.ok((await Promise.all(children.map(item => item.exited))).every(code => code === 0)); await assert.rejects(fs.access(f.filename));
  } finally { await stopChildren(children); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('an abruptly killed lease holder releases its OS lease and the next startup recovers safely', { timeout: 15000 }, async () => {
  const f = await fixture(), child = leaseChild(f.directory); let owner: Awaited<ReturnType<typeof acquireStationLock>> | undefined;
  try {
    assert.equal((await child.next()).t, 'ready'); child.child.send({ t: 'acquire' }); assert.equal((await child.next()).t, 'acquired');
    const crashedPid = child.child.pid; child.child.kill('SIGKILL'); await child.exited;
    assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8')).pid, crashedPid);
    owner = await acquireStationLock(f.directory); assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8')).pid, process.pid); await f.unchanged();
  } finally { await owner?.release(); await stopChildren([child]); await fs.rm(f.directory, { recursive: true, force: true }); }
});
