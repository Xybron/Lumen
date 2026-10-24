// Local, private test credentials only. This does NOT create remote users,
// change Auth settings or handle a service-role key. Provision these accounts
// through Supabase's official Auth user-management UI/Admin API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = path.join(root, '.team-local');
const filename = path.join(directory, 'test-accounts.json');
const verify = process.argv.length === 3 && process.argv[2] === '--verify';
if (process.argv.length > 2 && !verify) throw new Error('Usage: node backend/test/team-real-accounts-setup.mjs [--verify]');
const info = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Use a real isolated test directory, not a link.');
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
await fs.chmod(directory, 0o700);
const existing = await fs.lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
if (existing) {
  if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077)) throw new Error('Existing test credentials must be a private regular file.');
  console.log('Private test-account file already exists; it was not overwritten.');
} else {
  const runId = randomUUID();
  const data = { version: 1, projectRef: 'xfppsgiothkvhndmbixx', runId, createdAt: new Date().toISOString(),
    users: ['owner', 'editor'].map((role, index) => ({ role, email: `lumen-qa-${index + 1}-${runId.slice(0, 8)}@example.invalid`, password: randomBytes(36).toString('base64url'), id: null })) };
  await fs.writeFile(filename, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Generated two private dedicated test-account credentials; no users created yet and no passwords printed.');
}
if (verify) {
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (data.version !== 1 || data.projectRef !== 'xfppsgiothkvhndmbixx' || data.users?.length !== 2 || !data.users.every(user => /^lumen-qa-[12]-[a-f0-9]{8}@example\.invalid$/.test(user.email) && typeof user.password === 'string' && user.password.length >= 40)) throw new Error('Private test-account file does not match this LAB test.');
  const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
  const { createClient } = require('@supabase/supabase-js');
  for (const user of data.users) {
    const client = createClient('https://xfppsgiothkvhndmbixx.supabase.co', 'sb_publishable_4jSgOWLWJviBajnzSGg_OA_LxsZXa9a', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const result = await client.auth.signInWithPassword({ email: user.email, password: user.password });
    if (result.error || !result.data.user?.email_confirmed_at) throw new Error('A dedicated test account could not sign in as a confirmed LAB user. No credentials were printed.');
    user.id = result.data.user.id;
    await client.auth.signOut({ scope: 'local' });
  }
  await fs.writeFile(filename, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  console.log('Both dedicated accounts completed real LAB password sign-in. Account IDs saved privately; verification-only sessions signed out.');
}
