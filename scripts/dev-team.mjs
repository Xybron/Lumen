import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertLocalPortAvailable } from './dev-watch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url));
const frontendRequire = createRequire(new URL('../frontend/package.json', import.meta.url));
export function teamEnvironment(source = process.env) {
  if (source.NODE_ENV === 'production') throw new Error('Team rehearsal is local development only.');
  const environment = { ...source };
  // Never inherit another station/data directory, remote bridge or publishing credentials.
  for (const key of Object.keys(environment)) if (/^(?:LUMEN_|VITE_|SUPABASE_|POWERSYNC_)/.test(key)) delete environment[key];
  return { ...environment, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3300', LUMEN_DEV_BACKEND_PORT: '3300',
    LUMEN_TEAM_LOCAL_TEST: 'true', LUMEN_DATA_DIR: path.join(root, '.team-local', 'station'),
    LUMEN_DEV_VITE_CACHE_DIR: path.join(root, '.team-local', 'vite-cache') };
}
export async function runTeamDevelopment() {
  const environment = teamEnvironment();
  await assertLocalPortAvailable(3300, 'Team backend'); await assertLocalPortAvailable(5373, 'Team workspace');
  for (const directory of [path.join(root, '.team-local'), environment.LUMEN_DATA_DIR]) {
    const info = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('The isolated team directory must be a real directory, not a link or file. Existing data was left unchanged.');
  }
  await fs.mkdir(environment.LUMEN_DATA_DIR, { recursive: true, mode: 0o700 });
  const tsx = backendRequire.resolve('tsx');
  const vite = path.join(path.dirname(frontendRequire.resolve('vite/package.json')), 'bin', 'vite.js');
  const children = [
    spawn(process.execPath, ['--import', tsx, path.join(root, 'backend/src/server.ts')], { cwd: root, env: environment, stdio: 'inherit' }),
    spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5373', '--strictPort'], { cwd: path.join(root, 'frontend'), env: environment, stdio: 'inherit' }),
  ];
  let closing = false;
  const close = () => { if (closing) return; closing = true; for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); };
  for (const child of children) { child.once('error', close); child.once('exit', close); }
  process.once('SIGINT', close); process.once('SIGTERM', close);
  console.log('\nTeam rehearsal: http://127.0.0.1:5373/team\nIsolated local station: .team-local/station (no production data copied).\nSign in with LAB accounts; use separate browser profiles for different users.\nLocal station control still uses its separate local login. Cloud roles grant no live control.\nPowerSync: npm run team:sync -- setup, then npm run team:sync -- doctor.\nNo stream or recording starts automatically. Ctrl+C stops only these two processes.\n');
  await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) { console.error('Usage: npm run dev:team (uses isolated ports 3300 and 5373).'); process.exitCode = 1; }
  else await runTeamDevelopment().catch(error => { console.error(`[team] ${error.message}`); process.exitCode = 1; });
}
