import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

async function latestModified(directory) {
  let latest = (await fs.stat(directory)).mtimeMs;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? await latestModified(filename) : (await fs.stat(filename)).mtimeMs);
  }
  return latest;
}

/** Reuse verified native resources without changing their originals. The source
 * shell loads desktop/app directly; only built application assets are overlaid. */
export async function prepareSourceSmokeRuntime(root) {
  const original = path.join(root, 'desktop/build/resources');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const sourceLock = await fs.readFile(path.join(root, 'backend/package-lock.json'));
  const bundledLock = await fs.readFile(path.join(original, 'lumen/backend/package-lock.json'));
  assert.equal(digest(sourceLock), digest(bundledLock), 'Bundled dependencies differ from the current backend lockfile; prepare matching native resources first.');
  const sharedModified = await latestModified(path.join(root, 'shared'));
  for (const [name, entry] of [['backend', 'server.js'], ['frontend', 'index.html']]) {
    const built = await fs.stat(path.join(root, name, 'dist', entry));
    let changed = Math.max(sharedModified, await latestModified(path.join(root, name, 'src')));
    const inputs = ['tsconfig.json', 'package.json', 'package-lock.json'];
    if (name === 'frontend') {
      changed = Math.max(changed, await latestModified(path.join(root, name, 'public')));
      inputs.push('index.html', 'vite.config.ts');
    }
    for (const file of inputs) changed = Math.max(changed, (await fs.stat(path.join(root, name, file))).mtimeMs);
    assert.ok(built.mtimeMs >= changed, `Build current ${name} source before source smoke testing: npm run build`);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-desktop-source-'));
  const resources = path.join(directory, 'resources');
  // COPYFILE_FICLONE uses copy-on-write where supported and falls back to a copy.
  // Preserve relative framework symlinks inside the cloned runtime tree.
  await fs.cp(original, resources, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  for (const name of ['backend', 'frontend']) {
    const target = path.join(resources, 'lumen', name, 'dist');
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(path.join(root, name, 'dist'), target, { recursive: true, filter: filename => !filename.endsWith('.map') });
  }
  const shared = path.join(resources, 'lumen/shared');
  await fs.rm(shared, { recursive: true, force: true });
  await fs.mkdir(shared, { recursive: true });
  for (const file of await fs.readdir(path.join(root, 'shared'))) {
    if (file.endsWith('.js') || file === 'package.json') await fs.copyFile(path.join(root, 'shared', file), path.join(shared, file));
  }
  return { resources, sourceLockSha256: digest(sourceLock) };
}
