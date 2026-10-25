// Build-time app-local deployment from a licensed Visual Studio installation.
// Microsoft documents the redist directory and local deployment here:
// https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution
// https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
// https://learn.microsoft.com/en-us/cpp/windows/deployment-in-visual-cpp
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const getEnv = (env, name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const exists = filename => fs.access(filename).then(() => true, () => false);
const versionOrder = (a, b) => b.localeCompare(a, 'en', { numeric: true });

export async function findWindowsCrt({ env = process.env, run = execute } = {}) {
  const candidates = [];
  const explicit = getEnv(env, 'VCToolsRedistDir');
  if (explicit) candidates.push({ redist: path.resolve(explicit), installation: getEnv(env, 'VSINSTALLDIR') });
  const installations = [];
  const configured = getEnv(env, 'VSINSTALLDIR');
  if (configured) installations.push(path.resolve(configured));
  const programFiles = getEnv(env, 'ProgramFiles(x86)');
  if (programFiles) {
    const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (await exists(vswhere)) {
      const { stdout } = await run(vswhere, ['-latest', '-products', '*', '-version', '[17.0,18.0)', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath', '-utf8'], { windowsHide: true, encoding: 'utf8' });
      installations.push(...stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
    }
  }
  for (const installation of [...new Set(installations)]) {
    const redistRoot = path.join(installation, 'VC', 'Redist', 'MSVC');
    let versions;
    try { versions = (await fs.readdir(redistRoot)).filter(name => name === 'v143' || /^14\.\d+(?:\.\d+)*$/.test(name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    versions.sort((a, b) => a === 'v143' ? -1 : b === 'v143' ? 1 : versionOrder(a, b));
    for (const version of versions) candidates.push({ redist: path.join(redistRoot, version), installation });
  }
  for (const candidate of candidates) {
    const directory = path.join(candidate.redist, 'x64', 'Microsoft.VC143.CRT');
    if (!await exists(directory)) continue;
    const canonical = await fs.realpath(directory);
    if (canonical.split(/[\\/]/).some(part => /^debug_nonredist$/i.test(part))) continue;
    if (!/^Microsoft\.VC143\.CRT$/i.test(path.basename(canonical)) || path.basename(path.dirname(canonical)).toLowerCase() !== 'x64') continue;
    return { directory: canonical, redist: await fs.realpath(candidate.redist), installation: candidate.installation };
  }
  throw new Error('The Windows build machine needs the Visual Studio 2022 x64 VC143 redistributable files. Install the C++ build tools or set VCToolsRedistDir to their VC/Redist/MSVC version directory. Lumen will bundle these DLLs; the laptop does not need a separate VC runtime installer.');
}

export async function assertX64Pe(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(64);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length || header.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Not a Windows DLL: ${path.basename(filename)}`);
    const offset = header.readUInt32LE(0x3c);
    if (offset < 64 || offset > size - 26) throw new Error(`Invalid Windows DLL header: ${path.basename(filename)}`);
    const pe = Buffer.alloc(26);
    await file.read(pe, 0, pe.length, offset);
    if (pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664 || pe.readUInt16LE(24) !== 0x20b) throw new Error(`Expected an x64 Windows DLL: ${path.basename(filename)}`);
  } finally { await file.close(); }
}

export async function copyWindowsCrt(source, resourcesDir) {
  const entries = await fs.readdir(source.directory, { withFileTypes: true });
  const files = entries.filter(entry => /\.dll$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const required of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
    if (!files.some(entry => entry.name.toLowerCase() === required)) throw new Error(`The Visual Studio runtime is incomplete: missing ${required}.`);
  }
  const manifest = [];
  for (const file of files) {
    if (!file.isFile() || /(?:vcruntime|msvcp|concrt|vccorlib)\d+d\.dll$/i.test(file.name)) throw new Error(`Refusing a non-release runtime library: ${file.name}`);
    const filename = path.join(source.directory, file.name);
    await assertX64Pe(filename);
    const bytes = await fs.readFile(filename);
    manifest.push({ file: file.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const destination = path.join(resourcesDir, 'runtime');
  await fs.mkdir(destination, { recursive: true });
  for (const file of files) await fs.copyFile(path.join(source.directory, file.name), path.join(destination, file.name));
  const notices = [
    [source.directory, 'CRT'], [source.redist, 'Redist'],
    ...(source.installation ? [[source.installation, 'VisualStudio']] : []),
  ];
  const copiedNotices = [];
  for (const [directory, label] of notices) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^(?:license|licence|eula|redist|thirdparty(?:notices)?)(?:[._-].*)?\.(?:txt|rtf|html|htm)$/i.test(entry.name)) continue;
      const noticeDir = path.join(destination, 'licenses', 'microsoft-vc');
      await fs.mkdir(noticeDir, { recursive: true });
      const name = `${label}-${entry.name}`;
      await fs.copyFile(path.join(directory, entry.name), path.join(noticeDir, name));
      copiedNotices.push(`licenses/microsoft-vc/${name}`);
    }
  }
  await fs.writeFile(path.join(destination, 'MICROSOFT-VC-RUNTIME.json'), JSON.stringify({
    component: 'Microsoft Visual C++ 2022 Redistributable (x64)',
    source: `VC/Redist/MSVC/${path.basename(source.redist)}/x64/Microsoft.VC143.CRT`,
    files: manifest, suppliedNotices: copiedNotices,
  }, null, 2) + '\n');
  await fs.writeFile(path.join(destination, 'MICROSOFT-VC-RUNTIME-NOTICE.txt'), [
    'Microsoft Visual C++ 2022 Runtime, x64',
    'Copyright Microsoft Corporation. All rights reserved.',
    '',
    'These unmodified release DLLs accompany Lumen as application-local runtime dependencies.',
    'They were copied from the licensed build machine’s Visual Studio VC/Redist directory.',
    'Redistribution is subject to the Microsoft Software License Terms for that Visual Studio installation.',
    'Applicable installed license/redist notice files, when supplied, are retained under licenses/microsoft-vc/.',
    'The DLL inventory and SHA-256 hashes are in MICROSOFT-VC-RUNTIME.json.',
    '',
    'Microsoft distributable-code list:',
    'https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution',
    'Microsoft runtime deployment documentation:',
    'https://learn.microsoft.com/en-us/cpp/windows/deployment-in-visual-cpp',
    'Microsoft Visual Studio license directory:',
    'https://visualstudio.microsoft.com/license-terms/',
    '',
    'The runtime is installed beside the bundled node.exe, not into Windows system folders.',
    'Application-local DLL updates are delivered by rebuilding and updating Lumen.',
    'Windows 10/11 supplies the Universal C Runtime as an operating-system component.',
    '',
  ].join('\n'));
  return manifest;
}

export async function prepareWindowsCrt(resourcesDir) {
  if (process.platform !== 'win32') return [];
  if (process.arch !== 'x64') throw new Error('The Windows desktop runtime currently requires x64.');
  const files = await copyWindowsCrt(await findWindowsCrt(), resourcesDir);
  console.log(`Bundled ${files.length} Microsoft Visual C++ runtime DLLs beside node.exe.`);
  return files;
}
