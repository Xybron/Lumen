import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LISTENING_VAD_MODEL as model} from '../../shared/listening-vad.js';
import {installListeningVad,verifyListeningVad} from '../../scripts/listening-vad-download.mjs';

async function directory(t:TestContext){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-vad-download-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;
}

test('VAD catalogue pins one official local speech detector',()=>{
  assert.equal(Object.isFrozen(model),true);
  assert.equal(model.id,'silero-v6.2.0');assert.equal(model.filename,'ggml-silero-v6.2.0.bin');
  assert.equal(model.bytes,885098);
  assert.equal(model.sha256,'2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987');
  assert.equal(model.downloadUrl,`https://huggingface.co/ggml-org/whisper-vad/resolve/main/${model.filename}`);
});

test('VAD installer requests only the pinned URL with a timeout and cleans failed staging',async t=>{
  const dir=await directory(t);
  await assert.rejects(installListeningVad(dir,async(url,options)=>{
    assert.equal(url,model.downloadUrl);assert.ok(options?.signal instanceof AbortSignal);
    return new Response('Unavailable',{status:503});
  }),/download failed \(503\)/);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('VAD installer refuses an unexpected declared size before publishing a file',async t=>{
  const dir=await directory(t);
  await assert.rejects(installListeningVad(dir,async()=>new Response('truncated',{headers:{'Content-Length':'9'}})),/size did not match/);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('VAD installer detects a truncated stream even without Content-Length',async t=>{
  const dir=await directory(t);
  await assert.rejects(installListeningVad(dir,async()=>new Response('truncated')),/integrity check failed/);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('VAD installer verifies SHA-256 rather than trusting a matching byte count',async t=>{
  const dir=await directory(t);
  await assert.rejects(installListeningVad(dir,async()=>new Response(new Uint8Array(model.bytes),{headers:{'Content-Length':String(model.bytes)}})),/integrity check failed/);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('VAD installer bounds downloads that omit Content-Length',async t=>{
  const dir=await directory(t);
  await assert.rejects(installListeningVad(dir,async()=>new Response(new Uint8Array(model.bytes+1))),/exceeded the official file size/);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('VAD installer preserves a mismatched existing asset and never fetches over it',async t=>{
  const dir=await directory(t),target=path.join(dir,model.filename),original='existing local asset';
  await fs.writeFile(target,original);
  assert.equal(await verifyListeningVad(target),false);
  await assert.rejects(installListeningVad(dir,async()=>{assert.fail('An existing mismatched file must not trigger download');}),/was preserved/);
  assert.equal(await fs.readFile(target,'utf8'),original);assert.deepEqual(await fs.readdir(dir),[model.filename]);
});

test('VAD installer cleans staging after an interrupted network request',async t=>{
  const dir=await directory(t);
  await assert.rejects(installListeningVad(dir,async()=>{throw new DOMException('Download cancelled','AbortError');}),{name:'AbortError'});
  assert.deepEqual(await fs.readdir(dir),[]);
});
