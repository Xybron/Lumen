// Local developer updater. Station data and media are never installation targets.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pruneAppBackups } from './update-retention.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const backups = path.join(root, 'desktop/backups'), installed = '/Applications/Lumen.app';
const pending = path.join(backups, 'pending-update.json');
const verify = app => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
if (process.platform !== 'darwin') throw Error('This updater is for macOS.');
await fs.mkdir(backups, { recursive: true });
if (process.argv[2] === '--confirm-working') {
  const record = JSON.parse(await fs.readFile(pending, 'utf8'));
  verify(installed); verify(path.join(backups, record.backup));
  // Only invoke after launching the new app and checking Studio and Notes.
  const removed = await pruneAppBackups(backups, record.backup);
  await fs.writeFile(path.join(backups, 'last-update.json'), JSON.stringify({ ...record, confirmedAt: new Date().toISOString(), removed }, null, 2));
  await fs.unlink(pending);
  console.log('Confirmed update; retained one working app backup:', record.backup);
} else {
  if (!process.argv[2]) throw Error('Usage: node desktop/scripts/update-mac.mjs /path/to/Lumen.app | --confirm-working');
  try { await fs.access(pending); throw Error('Confirm the previous update works before installing another build.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const source = await fs.realpath(process.argv[2]);
  if (source === await fs.realpath(installed) || path.basename(source) !== 'Lumen.app') throw Error('Choose a separate staged Lumen.app.');
  verify(source); verify(installed);
  if (execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some(line => line.startsWith(installed + '/Contents/MacOS/Lumen'))) throw Error('Quit Lumen before installing.');
  const stamp = new Date().toISOString().replace(/:/g, '-'), backup = `Lumen-before-${stamp}.app`, stage = `/Applications/.Lumen-update-${stamp}.app`;
  // Native APFS clone avoids copying gigabytes of unchanged runtime files.
  try { execFileSync('/bin/cp', ['-cR', source, stage]); verify(stage); }
  catch (e) { await fs.rm(stage, { recursive: true, force: true }); throw e; }
  await fs.writeFile(pending, JSON.stringify({ backup, installedAt: new Date().toISOString(), source }, null, 2));
  await fs.rename(installed, path.join(backups, backup));
  try { await fs.rename(stage, installed); verify(installed); }
  catch (e) {
    await fs.rm(installed, { recursive: true, force: true });
    await fs.rename(path.join(backups, backup), installed);
    await fs.rm(stage, { recursive: true, force: true }); await fs.unlink(pending); throw e;
  }
  console.log('Installed. Launch and check Studio and Notes, then run with --confirm-working. Previous backups remain until confirmation.');
}
