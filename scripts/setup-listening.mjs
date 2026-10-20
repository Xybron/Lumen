// Installs only into Lumen's data directory. No Homebrew/global packages,
// cloud inference, service registration, or microphone access.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LISTENING_MODELS, listeningModel } from '../shared/listening-models.js';
import { installListeningModel } from './listening-model-download.mjs';
const args=process.argv.slice(2);
if(args.includes('--list-models')) {
  for(const model of LISTENING_MODELS)console.log(`${model.id.padEnd(24)} ${String(model.downloadMiB).padStart(4)} MiB  ${model.label}\n  ${model.description}`);
  process.exit(0);
}
if(args.some(arg=>!arg.startsWith('--model='))||args.length>1)throw new Error('Usage: npm run setup:ai -- --model=small.en (or --list-models).');
const modelId=args[0]?.slice('--model='.length)??'base.en';
const requestedModel=listeningModel(modelId);
if(!requestedModel)throw new Error('Unknown model. Run npm run setup:ai -- --list-models.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(process.env.LUMEN_DATA_DIR ? path.resolve(process.env.LUMEN_DATA_DIR) : path.join(root,'data'),'ai');
await fs.mkdir(dir,{recursive:true});
async function run(executable,args) {
  await new Promise((resolve,reject)=>{ const child=spawn(executable,args,{stdio:'inherit'}); child.once('error',reject); child.once('close',code=>code===0?resolve():reject(new Error(`${executable} exited ${code}`))); });
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function download(url,file) {
  if (await exists(file)) return;
  console.log(`Downloading ${path.basename(file)}…`);
  const response=await fetch(url,{signal:AbortSignal.timeout(600000)});
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const { createWriteStream } = await import('node:fs');
  await pipeline(Readable.fromWeb(response.body),createWriteStream(`${file}.download`));
  await fs.rename(`${file}.download`,file);
}
let cmake=process.env.LUMEN_CMAKE ?? 'cmake';
try { await run(cmake,['--version']); }
catch {
  if (process.platform!=='darwin') throw new Error('Install CMake and a C++ compiler, then rerun npm run setup:ai. You can also set LUMEN_CMAKE.');
  const archive=path.join(dir,'cmake-3.31.6-macos-universal.tar.gz');
  await download('https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-macos-universal.tar.gz',archive);
  cmake=path.join(dir,'cmake-3.31.6-macos-universal/CMake.app/Contents/bin/cmake');
  if (!await exists(cmake)) await run('tar',['-xzf',archive,'-C',dir]);
}
const source=path.join(dir,'whisper.cpp-1.9.5'), binary=path.join(source,'build/bin',process.platform==='win32'?'whisper-server.exe':'whisper-server');
if (!await exists(binary)) {
  const archive=path.join(dir,'whisper.cpp-v1.9.5.tar.gz');
  await download('https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz',archive);
  if (!await exists(path.join(source,'CMakeLists.txt'))) await run('tar',['-xzf',archive,'-C',dir]);
  await run(cmake,['-S',source,'-B',path.join(source,'build'),'-DCMAKE_BUILD_TYPE=Release','-DWHISPER_BUILD_TESTS=OFF','-DWHISPER_BUILD_SERVER=ON','-DGGML_METAL_EMBED_LIBRARY=ON']);
  await run(cmake,['--build',path.join(source,'build'),'--config','Release','--target','whisper-server','-j',String(Math.min(6,os.availableParallelism()))]);
}
const models=path.join(dir,'models'); await fs.mkdir(models,{recursive:true});
console.log(`Installing ${requestedModel.label} (${requestedModel.downloadMiB} MiB). Existing models are preserved.`);
const modelFile=await installListeningModel(modelId,models);
console.log(`\nLocal listening is installed.\nRuntime: ${binary}\nModel: ${modelFile}\nSelect this installed model in a channel's listening settings. Audio stays on this station.\n`);
