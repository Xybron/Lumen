// Build-time tooling only. No compiler, Git or download is needed by operators.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { installListeningModel } from '../../scripts/listening-model-download.mjs';

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, target, sha256) {
  if (await exists(target) && await digest(target) === sha256) return;
  const staged = `${target}.download`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(staged));
    if (await digest(staged) !== sha256) throw new Error(`Checksum mismatch: ${path.basename(target)}`);
    await fs.rename(staged, target);
  } finally { await fs.rm(staged, { force: true }); }
}

export async function prepareListening(resourcesDir, cacheDir) {
  const cache = path.join(cacheDir, 'listening');
  await fs.mkdir(cache, { recursive: true });
  let cmake = process.env.LUMEN_CMAKE || 'cmake';
  try { await run(cmake, ['--version']); }
  catch (error) {
    if (process.platform !== 'darwin') throw new Error('The build machine needs CMake and Visual Studio C++ build tools. Installed Lumen does not need them.', { cause: error });
    const archive = path.join(cache, 'cmake-3.31.6-macos-universal.tar.gz');
    await download('https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-macos-universal.tar.gz', archive,
      '330b9514f5112e5ed4fb08b8b05803b776fd9b539a6ae12927d14dcc0ee2ba8d');
    cmake = path.join(cache, 'cmake-3.31.6-macos-universal/CMake.app/Contents/bin/cmake');
    if (!await exists(cmake)) await run('tar', ['-xzf', archive, '-C', cache]);
  }
  const archive = path.join(cache, 'whisper.cpp-v1.9.5.tar.gz');
  await download('https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz', archive,
    'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720');
  const source = path.join(cache, 'whisper.cpp-1.9.5');
  if (!await exists(path.join(source, 'CMakeLists.txt'))) await run('tar', ['-xzf', archive, '-C', cache]);
  const build = path.join(cache, `build-${process.platform}-${process.arch}`);
  const flags = [
    '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>',
    '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF',
    '-DGGML_METAL=OFF', '-DGGML_BLAS=OFF', '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=ON', '-DWHISPER_CURL=OFF', '-DWHISPER_BUILD_IS_DEV=OFF',
    // Baseline instructions work on laptops unlike a build tuned to the runner CPU.
    '-DGGML_AVX=OFF', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_F16C=OFF',
  ];
  await run(cmake, ['-S', source, '-B', build, ...flags]);
  await run(cmake, ['--build', build, '--config', 'Release', '--target', 'whisper-server', '--parallel', String(Math.min(6, os.availableParallelism()))]);
  const filename = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
  const candidates = [path.join(build, 'bin', 'Release', filename), path.join(build, 'bin', filename)];
  const binary = (await Promise.all(candidates.map(async file => await exists(file) ? file : null))).find(Boolean);
  if (!binary) throw new Error('Built whisper-server was not found.');
  const target = path.join(resourcesDir, 'listening');
  await fs.mkdir(path.join(target, 'models'), { recursive: true });
  await fs.copyFile(binary, path.join(target, filename));
  if (process.platform !== 'win32') await fs.chmod(path.join(target, filename), 0o755);
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(target, 'LICENSE-whisper.cpp'));
  await fs.copyFile(new URL('./WHISPER-MODEL-LICENSE.txt', import.meta.url), path.join(target, 'LICENSE-whisper-model'));
  // The existing downloader verifies official model byte count and SHA-256.
  const models = path.join(cache, 'models');
  await fs.mkdir(models, { recursive: true });
  const model = await installListeningModel('base.en', models);
  await fs.copyFile(model, path.join(target, 'models', path.basename(model)));
  await fs.writeFile(path.join(target, 'MODEL-NOTICE.txt'),
    'Whisper Base English weights by OpenAI (MIT license), converted for whisper.cpp.\n' +
    'Source: https://huggingface.co/ggerganov/whisper.cpp\n' +
    'Original model and license: https://github.com/openai/whisper\n');
  return { whisperRelativePath: `listening/${filename}`, modelRelativePath: `listening/models/${path.basename(model)}` };
}
