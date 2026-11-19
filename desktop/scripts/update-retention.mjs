import fs from 'node:fs/promises';
import path from 'node:path';
const appName = /^Lumen-before-\d{4}-\d{2}-\d{2}T[\d.-]+Z\.app$/;
export async function pruneAppBackups(directory, keep) {
  if (!appName.test(keep)) throw Error('Invalid retained backup name.');
  const retained = await fs.lstat(path.join(directory, keep));
  if (!retained.isDirectory() || retained.isSymbolicLink()) throw Error('Retained backup must be a real app directory.');
  const removed = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    // Never traverse links or delete notes, station snapshots, media, archives,
    // or arbitrary directories just because they happen to live here.
    if (entry.name === keep || !appName.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    await fs.rm(path.join(directory, entry.name), { recursive: true }); removed.push(entry.name);
  }
  return removed;
}
