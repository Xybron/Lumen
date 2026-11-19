import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const version = '26.8.3';
const distributions = {
  'darwin-arm64': { folder: 'mac/aarch64', file: `LibreOffice_${version}_MacOS_aarch64.dmg`, sha256: 'de943203795e5057785f65515063e2db5eb60b0bb6d8e2534fec59e5cc5fb988' },
  'darwin-x64': { folder: 'mac/x86_64', file: `LibreOffice_${version}_MacOS_x86-64.dmg`, sha256: 'bb3c35d628780510915ad9e759d7ed898094d7985d01b2181bd1d4ecd94fd159' },
  'win32-x64': { folder: 'win/x86_64', file: `LibreOffice_${version}_Win_x86-64.msi`, sha256: '0e6918c273eabbdbbd800ee0dacbbf130a14c13c2e4cec861b06dd59e015bf94' },
};
async function hash(file) { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); }
function run(executable, args) { return new Promise((resolve, reject) => { const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited with ${code}`))); }); }

/** Stage only the document converter. Existing station data and other runtime
 * folders are never read or replaced. Release checksums are pinned from the
 * Document Foundation's official *.sha256 files. */
export async function prepareDocuments(resources, cache) {
  const target = distributions[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('Document conversion packaging supports macOS arm64/x64 and Windows x64.');
  const directory = path.join(resources, 'documents'), manifestFile = path.join(directory, 'converter.json');
  const relative = process.platform === 'darwin' ? 'documents/LibreOffice.app/Contents/MacOS/soffice' : 'documents/LibreOffice/program/soffice.com';
  const previous = await fs.readFile(manifestFile, 'utf8').then(JSON.parse, () => null);
  if (previous?.sha256 === target.sha256 && previous?.platform === process.platform && previous?.arch === process.arch
    && await fs.stat(path.join(resources, relative)).then(value => value.isFile(), () => false)) return { sofficeRelativePath: relative };
  await fs.mkdir(cache, { recursive: true }); await fs.mkdir(resources, { recursive: true });
  const archive = path.join(cache, target.file);
  if (!await fs.stat(archive).then(() => true, () => false) || await hash(archive) !== target.sha256) {
    const response = await fetch(`https://download.documentfoundation.org/libreoffice/stable/${version}/${target.folder}/${target.file}`, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`LibreOffice download failed (${response.status}).`);
    const partial = `${archive}.partial`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      if (await hash(partial) !== target.sha256) throw new Error('LibreOffice download checksum mismatch.');
      await fs.rename(partial, archive);
    } catch (error) { await fs.rm(partial, { force: true }); throw error; }
  }
  const staging = await fs.mkdtemp(path.join(resources, 'documents-prepare-'));
  try {
    if (process.platform === 'darwin') {
      const mount = await fs.mkdtemp(path.join(cache, 'libreoffice-mount-'));
      try {
        await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, archive]);
        try { await fs.cp(path.join(mount, 'LibreOffice.app'), path.join(staging, 'LibreOffice.app'), { recursive: true, verbatimSymlinks: true }); }
        finally { await run('hdiutil', ['detach', mount]); }
      } finally { await fs.rm(mount, { recursive: true, force: true }); }
    } else {
      const extracted = path.join(staging, 'extracted'); await fs.mkdir(extracted);
      // Administrative extraction writes a private runtime; it does not install
      // Office, add shortcuts, or change the operator's file associations.
      await run('msiexec.exe', ['/a', archive, '/qn', `TARGETDIR=${extracted}`]);
      const entries = await fs.readdir(extracted, { withFileTypes: true });
      let folder = entries.find(entry => entry.isDirectory() && /^LibreOffice/i.test(entry.name));
      if (!folder) throw new Error('The LibreOffice archive has an unexpected layout.');
      await fs.rename(path.join(extracted, folder.name), path.join(staging, 'LibreOffice'));
      await fs.rm(extracted, { recursive: true, force: true });
    }
    await fs.writeFile(path.join(staging, 'converter.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch, sha256: target.sha256, source: `https://download.documentfoundation.org/libreoffice/stable/${version}/${target.folder}/${target.file}` }, null, 2));
    await fs.writeFile(path.join(staging, 'THIRD-PARTY-NOTICES.txt'), [
      `LibreOffice ${version} — The Document Foundation`,
      'Unmodified official distribution. Included license, copyright and notices are retained in LibreOffice.app/Contents/Resources or LibreOffice/.',
      'Source code: https://download.documentfoundation.org/libreoffice/src/26.8.3/',
      'Licenses: https://www.libreoffice.org/about-us/licenses/',
      'LibreOffice is a registered trademark of The Document Foundation. Lumen is an independent application.',
      'PDF.js and @napi-rs/canvas are included with their licenses in lumen/backend/node_modules/.', '',
    ].join('\n'));
    // Only this helper's generated runtime directory may be replaced.
    await fs.rm(directory, { recursive: true, force: true }); await fs.rename(staging, directory);
    await run(path.join(resources, relative), ['--version']);
    return { sofficeRelativePath: relative };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await prepareDocuments(path.join(desktop, 'build/resources'), path.join(desktop, 'build/cache')), null, 2));
}
