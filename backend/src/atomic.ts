import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BACKUPS_DIR, CONTENT_FILE } from './paths.js';

const MAX_BACKUPS = 10;

// Atomic write: write to a UNIQUE .tmp, fsync, rename. POSIX guarantees rename
// atomicity on the same filesystem, so a crash mid-write never leaves a
// half-written file. The per-write unique suffix prevents two concurrent writers
// from clobbering each other's temp file (which could surface as ENOENT/tearing).
export async function atomicWriteJson(target: string, data: unknown): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const json = JSON.stringify(data, null, 2);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, target);
}

// Snapshot the live content.json before mutating, then prune to MAX_BACKUPS.
export async function backupContent(): Promise<void> {
  try {
    const raw = await fs.readFile(CONTENT_FILE, 'utf8');
    await fs.mkdir(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(BACKUPS_DIR, `content.${stamp}.json`), raw, 'utf8');
    const entries = (await fs.readdir(BACKUPS_DIR))
      .filter((f) => f.startsWith('content.') && f.endsWith('.json'))
      .sort();
    const excess = entries.length - MAX_BACKUPS;
    for (let i = 0; i < excess; i++) {
      await fs.unlink(path.join(BACKUPS_DIR, entries[i]));
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
