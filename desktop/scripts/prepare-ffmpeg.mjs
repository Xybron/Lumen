// Build-time dependency preparation. All codec libraries are static; the
// installed application needs no compiler, package manager or system FFmpeg.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const sourceCatalog = [
  { id: 'ffmpeg', file: 'ffmpeg-7.1.5.tar.xz', url: 'https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz', sha256: 'de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f' },
  { id: 'x264', file: 'x264-0480cb05.tar.gz', url: 'https://github.com/mirror/x264/archive/0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee.tar.gz', sha256: 'd0967a1348c85dfde363bb52610403be898171493100561efa0dd05d5fd1ae50' },
  { id: 'vpx', file: 'libvpx-1.15.2.tar.gz', url: 'https://github.com/webmproject/libvpx/archive/refs/tags/v1.15.2.tar.gz', sha256: '26fcd3db88045dee380e581862a6ef106f49b74b6396ee95c2993a260b4636aa' },
  { id: 'opus', file: 'opus-1.5.2.tar.gz', url: 'https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz', sha256: '65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1' },
  { id: 'lame', file: 'lame-3.100.tar.gz', url: 'https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz', sha256: 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e' },
  { id: 'pkgconf', file: 'pkgconf-2.4.3.tar.xz', url: 'https://distfiles.ariadne.space/pkgconf/pkgconf-2.4.3.tar.xz', sha256: '51203d99ed573fa7344bf07ca626f10c7cc094e0846ac4aa0023bd0c83c25a41' },
  { id: 'nasm', file: 'nasm-2.16.03.tar.xz', url: 'https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/nasm-2.16.03.tar.xz', sha256: '1412a1c760bbd05db026b6c0d1657affd6631cd0a63cddb6f73cc6d4aa616148' },
  // macOS supplies libz as an operating-system library. Windows gets a static
  // build instead of depending on an MSYS2 DLL on the installed machine.
  { id: 'zlib', platforms: ['win32'], file: 'zlib-1.3.2.tar.xz', url: 'https://zlib.net/zlib-1.3.2.tar.xz', sha256: 'd7a0654783a4da529d1bb793b7ad9c3318020af77667bcae35f95d0e42a792f3' },
];
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const exists = file => fs.access(file).then(() => true, () => false);
async function hash(file) { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); }
async function download(source, directory) {
  const target = path.join(directory, source.file);
  if (await exists(target) && await hash(target) === source.sha256) return target;
  console.log(`Downloading FFmpeg source dependency: ${source.file}`);
  const response = await fetch(source.url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`Cannot download ${source.file}: HTTP ${response.status}`);
  const partial = `${target}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if (await hash(partial) !== source.sha256) throw new Error(`Source SHA-256 mismatch: ${source.file}`);
    await fs.rename(partial, target);
  } catch (error) { await fs.rm(partial, { force: true }); throw error; }
  return target;
}
async function run(command, args, options = {}, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true, ...options });
    let output = ''; if (capture) { child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; }); }
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}\n${output}`)));
  });
}
async function verify(binary) {
  const version = await run(binary, ['-hide_banner', '-version'], {}, true);
  if (version.includes('--enable-nonfree')) throw new Error('This FFmpeg binary enables nonfree components and cannot be included in a distributable installer.');
  const encoders = await run(binary, ['-hide_banner', '-encoders'], {}, true);
  for (const encoder of ['libx264', 'libvpx-vp9', 'libopus', 'libmp3lame', 'aac', 'pcm_s16le', 'png']) {
    if (!new RegExp(`\\b${encoder}\\b`).test(encoders)) throw new Error(`Bundled FFmpeg is missing ${encoder}.`);
  }
  const protocols = await run(binary, ['-hide_banner', '-protocols'], {}, true);
  if (!/\brtmps\b/.test(protocols)) throw new Error('Bundled FFmpeg must support RTMPS streaming.');
  return version;
}

export async function prepareFfmpeg(resources, cache) {
  const packageDir = path.join(resources, 'lumen/backend/node_modules/ffmpeg-static');
  const destination = path.join(packageDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const notices = path.join(resources, 'ffmpeg-source');
  await fs.mkdir(notices, { recursive: true });
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Unsupported desktop FFmpeg platform.');
  const sources = sourceCatalog.filter(source => !source.platforms || source.platforms.includes(process.platform));
  const windows = process.platform === 'win32';
  const msys = windows ? path.resolve(process.env.LUMEN_MSYS2_ROOT || 'C:\\msys64') : null;
  const bash = windows ? path.join(msys, 'usr/bin/bash.exe') : null;
  if (windows && (!await exists(bash) || !await exists(path.join(msys, 'mingw64/bin/gcc.exe')))) {
    throw new Error('Install MSYS2 and run "pacman -S --needed base-devel mingw-w64-x86_64-toolchain" in its MINGW64 terminal. Set LUMEN_MSYS2_ROOT if it is not installed in C:\\msys64. These are build-machine tools only.');
  }
  if (windows && (!await exists(path.join(msys, 'usr/bin/perl.exe')) || !await exists(path.join(msys, 'usr/bin/diff.exe')))) {
    throw new Error('Install MSYS2 Perl and diffutils in its MINGW64 terminal: pacman -S --needed perl diffutils. libvpx needs both build tools.');
  }
  const msysEnv = windows ? { ...process.env, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1', MSYS2_PATH_TYPE: 'inherit' } : null;
  const posixPath = async value => windows ? (await run(bash, ['-lc', `cygpath -u ${shellQuote(value)}`], { env: msysEnv }, true)).trim() : value;
  const downloads = path.join(cache, 'ffmpeg-sources'); await fs.mkdir(downloads, { recursive: true });
  const archives = new Map();
  for (const source of sources) archives.set(source.id, await download(source, downloads));
  const revision = windows ? 'static-v4' : 'static-v3';
  // Keep Windows compiler flags in a short MSYS path even when the checkout
  // lives in a Windows user directory containing spaces.
  const work = windows ? path.join(msys, 'var/tmp', `lumen-ffmpeg-${revision}-${process.arch}`) : path.join(cache, `ffmpeg-${revision}-${process.arch}`);
  const prefix = path.join(work, 'prefix');
  const binary = path.join(prefix, windows ? 'bin/ffmpeg.exe' : 'bin/ffmpeg');
  const completed = path.join(work, 'complete.json');
  const signature = createHash('sha256').update(JSON.stringify({ revision, platform: process.platform, arch: process.arch, sources })).digest('hex');
  let cached;
  try { cached = JSON.parse(await fs.readFile(completed, 'utf8')); } catch { /* First build. */ }
  if (cached?.signature !== signature || !await exists(binary) || cached.binarySha256 !== await hash(binary)) {
    await fs.rm(work, { recursive: true, force: true }); await fs.mkdir(prefix, { recursive: true });
    const trees = new Map();
    for (const source of sources) {
      const dir = path.join(work, source.id); await fs.mkdir(dir, { recursive: true });
      if (windows) await run(bash, ['-lc', `tar -xf ${shellQuote(await posixPath(archives.get(source.id)))} -C ${shellQuote(await posixPath(dir))} --strip-components=1`], { env: msysEnv });
      else await run('tar', ['-xf', archives.get(source.id), '-C', dir, '--strip-components=1']);
      trees.set(source.id, dir);
    }
    const buildPrefix = await posixPath(prefix);
    const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: '12.0', PATH: `${path.join(prefix, 'bin')}${path.delimiter}${process.env.PATH}`, PKG_CONFIG_PATH: '', PKG_CONFIG_LIBDIR: path.join(prefix, 'lib/pkgconfig'), CFLAGS: '-O2', CXXFLAGS: '-O2', LDFLAGS: `-L${path.join(prefix, 'lib')}` };
    const jobs = String(Math.max(1, Math.min(6, os.availableParallelism())));
    async function buildRun(id, command, args) {
      if (!windows) return run(command, args, { cwd: trees.get(id), env });
      const script = [
        'set -eu', `cd ${shellQuote(await posixPath(trees.get(id)))}`,
        `export PATH=${shellQuote(`${buildPrefix}/bin`)}:/mingw64/bin:/usr/bin:$PATH`,
        `export PKG_CONFIG_PATH='' PKG_CONFIG_LIBDIR=${shellQuote(`${buildPrefix}/lib/pkgconfig`)}`,
        // pkgconf's Windows headers otherwise declare imports from a DLL even
        // though this recipe deliberately builds and links libpkgconf static.
        `export CFLAGS=${shellQuote(id === 'pkgconf' ? '-O2 -DPKGCONFIG_IS_STATIC' : '-O2')} CXXFLAGS='-O2' LDFLAGS=${shellQuote(`-L${buildPrefix}/lib -static-libgcc -static`)}`,
        `exec ${[command, ...args].map(shellQuote).join(' ')}`,
      ].join('\n');
      return run(bash, ['-lc', script], { env: msysEnv });
    }
    async function build(id, flags) {
      console.log(`Building static FFmpeg dependency: ${id}`);
      await buildRun(id, './configure', [`--prefix=${buildPrefix}`, ...flags]);
      await buildRun(id, 'make', ['-j', jobs]);
      await buildRun(id, 'make', ['install']);
    }
    const host = windows ? ['--host=x86_64-w64-mingw32'] : [];
    await build('pkgconf', ['--disable-shared', '--enable-static', ...host]);
    if (windows) await build('zlib', ['--static']);
    if (process.arch === 'x64') await build('nasm', host);
    await build('x264', ['--enable-static', '--disable-cli', '--disable-opencl', '--enable-pic', ...host]);
    await build('vpx', ['--enable-static', '--disable-shared', '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--enable-pic', '--disable-vp9-highbitdepth', `--target=${windows ? 'x86_64-win64-gcc' : `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-darwin20-gcc`}`]);
    await build('opus', ['--enable-static', '--disable-shared', '--disable-doc', '--disable-extra-programs', ...host]);
    await build('lame', ['--enable-static', '--disable-shared', '--disable-frontend', '--disable-dependency-tracking', ...host]);
    await build('ffmpeg', [
      '--enable-static', '--disable-shared', '--disable-autodetect', '--disable-doc', '--disable-debug', '--disable-ffplay', '--disable-ffprobe',
      '--enable-gpl', '--enable-libx264', '--enable-libvpx', '--enable-libopus', '--enable-libmp3lame', '--enable-zlib',
      ...(windows ? ['--target-os=mingw32', '--arch=x86_64', '--enable-schannel'] : ['--enable-securetransport', '--enable-videotoolbox', '--enable-audiotoolbox']),
      '--pkg-config-flags=--static', `--pkg-config=${buildPrefix}/bin/pkgconf${windows ? '.exe' : ''}`,
      `--extra-cflags=-I${buildPrefix}/include`, `--extra-ldflags=-L${buildPrefix}/lib${windows ? ' -static-libgcc -static' : ''}`,
    ]);
    const linkage = windows ? await run(path.join(msys, 'mingw64/bin/objdump.exe'), ['-p', binary], {}, true) : await run('otool', ['-L', binary], {}, true);
    const systemDlls = /^(?:api-ms-win-|ext-ms-win-)|^(?:advapi32|avicap32|avrt|bcrypt|cabinet|comctl32|comdlg32|crypt32|d3d9|d3d11|d3d12|dbghelp|dwmapi|dxgi|dxva2|gdi32|imm32|iphlpapi|kernel32|ksuser|mf|mfplat|mfreadwrite|mfuuid|msvcrt|msvfw32|ntdll|ole32|oleaut32|opengl32|psapi|secur32|setupapi|shell32|shlwapi|user32|uuid|ucrtbase|version|vfw32|winmm|winspool|ws2_32)\.dll$/i;
    const external = windows ? [...linkage.matchAll(/DLL Name:\s*(\S+)/g)].map(match => match[1]).filter(value => !systemDlls.test(value)) : linkage.split('\n').slice(1).map(line => line.trim().split(' ')[0]).filter(value => value && !value.startsWith('/usr/lib/') && !value.startsWith('/System/Library/'));
    if (external.length) throw new Error(`FFmpeg depends on unbundled libraries: ${external.join(', ')}`);
    await verify(binary);
    await fs.writeFile(completed, JSON.stringify({ signature, binarySha256: await hash(binary) }));
  }
  const version = await verify(binary);
  await fs.copyFile(binary, destination); await fs.chmod(destination, 0o755);
  // Ship complete corresponding codec sources and the build recipe alongside
  // the executable, including the original copyright and license files.
  for (const source of sources) await fs.copyFile(archives.get(source.id), path.join(notices, source.file));
  await fs.copyFile(fileURLToPath(import.meta.url), path.join(notices, 'build-recipe.mjs'));
  await fs.writeFile(path.join(notices, 'SOURCES.json'), `${JSON.stringify(sources, null, 2)}\n`);
  await fs.copyFile(path.join(work, 'ffmpeg/COPYING.GPLv2'), path.join(packageDir, 'ffmpeg.LICENSE'));
  await fs.writeFile(path.join(packageDir, 'ffmpeg.README'), `This desktop FFmpeg was compiled by Lumen from the pinned sources and recipe in resources/ffmpeg-source.\nIt replaces the npm package's downloaded executable.\n${version}\n`);
  await fs.writeFile(path.join(notices, 'BUILD.txt'), `${version}\nBuilt on ${process.platform} ${process.arch} with ${windows ? 'MSYS2 MINGW64 base-devel and mingw-w64-x86_64-toolchain' : 'Apple Command Line Tools and make'}. Run prepareFfmpeg(resourcesDirectory, cacheDirectory) from build-recipe.mjs on the target architecture.\nNo nonfree components or external package-manager libraries are linked.\n`);
  console.log(`Redistributable FFmpeg installed: ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await prepareFfmpeg(path.join(desktop, 'build/resources'), path.join(desktop, 'build/cache'));
}
