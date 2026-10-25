import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(desktop, 'build/resources/runtime-manifest.json'), 'utf8'));
if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Run prepare:bundle on this operating system and architecture before packaging.');
if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Build Windows installers on Windows and Mac installers on macOS.');
const dir = process.argv.slice(2);
if (dir.some(value => value !== '--dir')) throw new Error('Supported option: --dir');
const cli = path.join(desktop, 'node_modules/electron-builder/out/cli/cli.js');
const args = [cli, '--config', 'electron-builder.cjs', process.platform === 'win32' ? '--win' : '--mac', `--${process.arch}`, '--publish', 'never', ...dir];
const child = spawn(process.execPath, args, { cwd: desktop, stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', async code => {
  process.exitCode = code ?? 1;
  if (code !== 0 || dir.includes('--dir')) return;
  try {
    const output = path.join(desktop, 'dist');
    const installers = (await fs.readdir(output)).filter(name => /^Lumen-.+\.(exe|dmg|zip)$/.test(name)).sort();
    if (!installers.length) throw new Error('The packager completed without producing an installer.');
    const sums = [];
    for (const filename of installers) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path.join(output, filename))) hash.update(chunk);
      sums.push(`${hash.digest('hex')}  ${filename}`);
    }
    await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
    console.log('Installer checksums written to desktop/dist/SHA256SUMS.txt');
  } catch (error) { console.error(error); process.exitCode = 1; }
});
