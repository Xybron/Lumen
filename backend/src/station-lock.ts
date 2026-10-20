import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

export class StationInUseError extends Error {
  constructor() { super('This station is already in use, or its runtime lock could not be verified safely. Stop the other Lumen instance first. Confirmed stale runtime locks are recovered automatically; do not remove a lock while an instance is running.'); }
}

const activeDirectories = new Set<string>();
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const ownedFile = (stat: Stats) => stat.isFile() && (process.getuid === undefined || stat.uid === process.getuid());
type Lock = { stat: Stats; bytes: string };

/** Bounded, no-follow reads also keep a replacement inode out of our cleanup. */
async function readLock(filename: string): Promise<Lock | undefined> {
  let file;
  try {
    const before = await fs.lstat(filename);
    if (!ownedFile(before) || before.size > 4096) throw new StationInUseError();
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!ownedFile(stat) || !sameFile(before, stat) || stat.size > 4096) throw new StationInUseError();
    const buffer = Buffer.alloc(4097), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new StationInUseError();
    return { stat, bytes: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw new StationInUseError();
  } finally { await file?.close(); }
}

async function removeIfUnchanged(filename: string, expected: Lock) {
  const current = await readLock(filename);
  if (!current || !sameFile(current.stat, expected.stat) || current.bytes !== expected.bytes) return false;
  await fs.unlink(filename);
  return true;
}

function confirmedDead(lock: Lock) {
  try {
    const value = JSON.parse(lock.bytes);
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== 'string'
      || !/^[a-f0-9]{48}$/.test(value.nonce)) return false;
    try { process.kill(value.pid, 0); }
    catch (error) { return code(error) === 'ESRCH'; }
  } catch { /* Invalid metadata or unknown liveness is never proof of death. */ }
  return false;
}

/** SQLite supplies an OS-released gate, not another PID lock to go stale.
 * Its inode must stay in place, including after release and process crashes. */
async function acquireGate(canonical: string) {
  const filename = path.join(canonical, '.lumen-runtime.lease.sqlite');
  try {
    // Never open/close an existing gate with raw fs APIs: on POSIX that can
    // release another SQLite connection's locks held by this same process.
    const created = await fs.open(filename, 'wx', 0o600);
    await created.close();
  } catch (error) { if (code(error) !== 'EEXIST') throw error; }
  const before = await fs.lstat(filename);
  if (!ownedFile(before) || before.nlink !== 1 || (before.mode & 0o077) !== 0) throw new StationInUseError();
  let gate: Database.Database | undefined;
  try {
    gate = new Database(filename, { timeout: 0, fileMustExist: true });
    gate.exec('BEGIN EXCLUSIVE');
    gate.prepare('SELECT count(*) FROM sqlite_schema').get();
    const current = await fs.lstat(filename);
    if (!ownedFile(current) || !sameFile(before, current)) throw new StationInUseError();
    return gate;
  } catch (error) { gate?.close(); throw error; }
}

function releaseGate(gate: Database.Database | undefined) {
  if (!gate) return;
  try { if (gate.inTransaction) gate.exec('ROLLBACK'); }
  finally { gate.close(); }
}

/** Publish complete metadata without replacing any existing (including legacy)
 * owner. A crash while writing the private temp cannot leave a partial lock. */
async function publishLock(filename: string): Promise<Lock> {
  const nonce = randomBytes(24).toString('hex'), temporary = `${filename}.${nonce}.tmp`;
  const bytes = JSON.stringify({ pid: process.pid, nonce });
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    const stat = await file.stat();
    await fs.link(temporary, filename);
    return { stat, bytes };
  } finally {
    await file.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

/** A station's stores are single-process authorities. Acquire before opening
 * any store. Only a provably dead legacy owner can be recovered automatically. */
export async function acquireStationLock(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const canonical = await fs.realpath(directory), filename = path.join(canonical, '.lumen-runtime.lock');
  if (activeDirectories.has(canonical)) throw new StationInUseError();
  activeDirectories.add(canonical);
  let gate: Database.Database | undefined;
  try {
    gate = await acquireGate(canonical);
    const previous = await readLock(filename);
    if (previous && (!confirmedDead(previous) || !await removeIfUnchanged(filename, previous))) throw new StationInUseError();
    const owned = await publishLock(filename);
    let released = false;
    return { canonical, async release() {
      if (released) return;
      released = true;
      try { await removeIfUnchanged(filename, owned); }
      catch { /* Never remove a lock now owned by someone else. */ }
      finally {
        try { releaseGate(gate); }
        finally { activeDirectories.delete(canonical); }
      }
    } };
  } catch (error) {
    try { releaseGate(gate); }
    finally { activeDirectories.delete(canonical); }
    if (error instanceof StationInUseError || ['EEXIST', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(code(error) ?? '')) throw new StationInUseError();
    throw new Error('The station runtime lease could not be opened safely. Check directory permissions and the runtime lease file.');
  }
}
