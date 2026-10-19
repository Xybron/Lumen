import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {LocalListener,localTranscript} from '../src/local-listener.js';
import {LISTENING_MODELS} from '../../shared/listening-models.js';
import {installListeningModel} from '../../scripts/listening-model-download.mjs';
import {ListeningSessions} from '../src/listening-session.js';
import {WorshipLibrary} from '../src/worship-library.js';

function wav(silent=false) {
  const out=Buffer.alloc(32044);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(out.length-44,40);
  if(!silent)for(let i=44;i<out.length;i+=2)out.writeInt16LE(Math.round(3000*Math.sin(i/10)),i);
  return out;
}
async function fixture() {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-listener-unit-')),models=path.join(dir,'ai/models');await fs.mkdir(models,{recursive:true});
  for(const id of ['base.en','small.en','small'])await fs.writeFile(path.join(models,`ggml-${id}.bin`),'protocol fixture, not model weights');
  const executable=fileURLToPath(new URL('./fixtures/local-listener-worker.mjs',import.meta.url));await fs.chmod(executable,0o755);
  const listener=new LocalListener({dataDir:dir,executable});
  return {dir,models,listener,executable,async close(){listener.close();await fs.rm(dir,{recursive:true,force:true});}};
}
test('model catalogue is a fixed set with verified official byte counts and SHA-256',()=>{
  assert.deepEqual(LISTENING_MODELS.map(model=>model.id),['base.en','small.en','small','medium.en','medium','large-v3-turbo-q5_0']);
  for(const model of LISTENING_MODELS){assert.match(model.sha256,/^[a-f0-9]{64}$/);assert.equal(model.filename,`ggml-${model.id}.bin`);assert.equal(model.multilingual,!model.id.includes('.en'));assert.ok(model.bytes>100000000);}
});
test('model selection permits installed IDs only, persists and preserves the existing Base default',async()=>{
  const f=await fixture();try {
    const status=await f.listener.status();assert.equal(status.modelId,'base.en');assert.equal(status.model,'ggml-base.en.bin');assert.equal(status.decoding,'beam-search');assert.equal(status.profiles.find(profile=>profile.id==='medium.en')?.installed,false);
    for(const id of ['../../secret','https://model','--model=/private/file','custom'])await assert.rejects(()=>f.listener.selectModel(id),/known local/);
    await assert.rejects(()=>f.listener.selectModel('medium.en'),/Install this model/);
    assert.equal((await f.listener.selectModel('small.en')).modelId,'small.en');
    const replacement=new LocalListener({dataDir:f.dir,executable:f.executable});try{assert.equal((await replacement.status()).modelId,'small.en');}finally{replacement.close();}
    assert.equal(await fs.readFile(path.join(f.models,'ggml-base.en.bin'),'utf8'),'protocol fixture, not model weights');
  }finally{await f.close();}
});
test('all listening contexts use prompt-free isolated decoding with supported beam-search settings',async()=>{
  const f=await fixture();try {
    assert.match((await f.listener.transcribe(wav(),'en','scripture')).text,/John chapter three/);
    await f.listener.transcribe(wav(),'en','lyrics');
    await f.listener.transcribe(wav(),'en');
    const args=JSON.parse(await fs.readFile(path.join(f.models,'worker-args.json'),'utf8'));assert.equal(args[args.indexOf('--max-context')+1],'0');assert.equal(args[args.indexOf('--beam-size')+1],'5');assert.ok(args.includes('--no-fallback'));assert.doesNotMatch(args.join(' '),/Genesis|Revelation|--prompt/);
    const calls=(await fs.readFile(path.join(f.models,'worker-calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.length,3);assert.equal(calls[0].beam_size,'5');assert.equal(calls[0].response_format,'verbose_json');assert.equal(calls[0].language,'en');assert.equal(calls[0].temperature,'0');assert.equal(calls[0].temperature_inc,'0');assert.equal(calls[0].no_language_probabilities,'true');assert.equal(calls[0].detect_language,'false');assert.equal(calls[0].translate,'false');
    for(const call of calls)assert.equal(call.prompt,'','No channel can condition recognition on a book-name list or a previous prompt');
    await f.listener.selectModel('small');assert.equal((await f.listener.status()).state,'stopped');await f.listener.transcribe(wav(),'fr','lyrics');assert.equal((await f.listener.status()).modelId,'small');assert.equal((await f.listener.status()).state,'ready');
  }finally{await f.close();}
});
test('malformed input, unsupported language, silence and concurrent model changes cannot invoke unsafe inference',async()=>{
  const f=await fixture();try {
    await assert.rejects(()=>f.listener.transcribe(Buffer.from('bad'),'en'),/16 kHz/);
    await assert.rejects(()=>f.listener.transcribe(wav(),'en; rm'),/two-letter/);
    await assert.rejects(()=>f.listener.transcribe(wav(),'fr'),/English model/);
    await assert.rejects(()=>f.listener.transcribe(wav(),'en','arbitrary prompt' as any),/context/);
    assert.deepEqual(await f.listener.transcribe(wav(true),'en','scripture'),{text:'',elapsedMs:0});assert.equal((await f.listener.status()).state,'stopped');
    await fs.writeFile(path.join(f.models,'worker-response.json'),JSON.stringify({text:'waiting',delayMs:250}));
    const inference=f.listener.transcribe(wav(),'en','scripture');
    await assert.rejects(()=>f.listener.selectModel('small.en'),/current audio window/);
    await inference;
    assert.equal((await f.listener.status()).modelId,'base.en');
  }finally{await f.close();}
});
test('explicit environment model remains administrator-controlled',async()=>{
  const f=await fixture(),custom=new LocalListener({dataDir:f.dir,executable:f.executable,model:path.join(f.models,'ggml-base.en.bin')});
  try{assert.equal((await custom.status()).modelId,'custom');await assert.rejects(()=>custom.selectModel('small.en'),/administrator override/);assert.equal((await custom.selectModel('custom')).modelId,'custom');}
  finally{custom.close();await f.close();}
});
test('low-confidence/no-speech segments cannot masquerade as a reliable transcript',()=>{
  assert.equal(localTranscript({text:' fallback',segments:[{text:' John 3:16',avg_logprob:-1.8,no_speech_prob:.1}]}),'');
  assert.equal(localTranscript({segments:[{text:' invented',avg_logprob:-.9,no_speech_prob:.98},{text:' real speech',avg_logprob:-.3,no_speech_prob:.01}]}),'real speech');
  assert.equal(localTranscript({segments:[{text:' quiet speech',avg_logprob:-.3,no_speech_prob:.95}]}),'quiet speech');
  assert.equal(localTranscript({text:' legacy worker '}),'legacy worker');assert.equal(localTranscript({text:undefined}),'');assert.equal(localTranscript(null as any),'');
});
test('installer rejects paths and preserves existing model files without making a download',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-model-download-'));
  try {
    let downloaded=false;const fetcher=async()=>{downloaded=true;throw new Error('must not download');};
    await assert.rejects(()=>installListeningModel('../../outside',dir,fetcher),/Unknown listening model/);
    const existing=path.join(dir,'ggml-base.en.bin');await fs.writeFile(existing,'an existing local model');
    await assert.rejects(()=>installListeningModel('base.en',dir,fetcher),/was preserved/);
    assert.equal(await fs.readFile(existing,'utf8'),'an existing local model');assert.equal(downloaded,false);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('installer never exposes a partial or unverified download as an installed model',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-model-download-'));
  try {
    await assert.rejects(()=>installListeningModel('base.en',dir,async()=>new Response('wrong length',{headers:{'content-length':'12'}})),/size did not match/);
    assert.deepEqual(await fs.readdir(dir),[]);
    await assert.rejects(()=>installListeningModel('base.en',dir,async()=>new Response(new Uint8Array([1,2,3,4]))),/integrity check failed/);
    assert.deepEqual(await fs.readdir(dir),[]);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('model selection excludes new starts, inference and simultaneous selections during asynchronous validation',async t=>{
  const f=await fixture();try {
    const access=fs.access.bind(fs);let release!:()=>void,entered!:()=>void,hold=true;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    t.mock.method(fs,'access',async(file:any,...args:any[])=>{
      if(hold&&String(file)===path.join(f.models,'ggml-small.en.bin')){hold=false;entered();await gate;}
      return access(file,...args);
    });
    const selection=f.listener.selectModel('small.en');await enteredPromise;
    try {
      await assert.rejects(()=>f.listener.start(),/model is changing/);
      await assert.rejects(()=>f.listener.transcribe(wav(),'en'),/model is changing/);
      await assert.rejects(()=>f.listener.selectModel('small'),/current audio window/);
    }finally{release();}
    assert.equal((await selection).modelId,'small.en');assert.equal((await f.listener.status()).state,'stopped');
    t.mock.restoreAll();
    const starting=f.listener.start();
    await assert.rejects(()=>f.listener.selectModel('small'),/current audio window/);
    await starting;assert.equal((await f.listener.status()).modelId,'small.en');
  }finally{t.mock.restoreAll();await f.close();}
});
test('an old channel owner can revoke only their own lease and cannot stop a replacement listener',()=>{
  const library=new WorshipLibrary(':memory:'),sessions=new ListeningSessions(library,()=>{});
  const options={mode:'assisted' as const,language:'en',commands:false};
  try {
    const old=sessions.start('scripture','old-owner',options);assert.equal(sessions.hasActive(),true);
    assert.equal(sessions.stopOwned('scripture','unrelated-user'),false);assert.equal(sessions.check('scripture',old.id,'old-owner').id,old.id);
    // Stopping a microphone after control is lost must still revoke its lease.
    assert.equal(sessions.stopOwned('scripture','old-owner'),true);assert.equal(sessions.hasActive(),false);
    assert.throws(()=>sessions.accept('scripture',old.id,'old-owner',0,'scripture','John 3:16',1,0),/stopped or expired/);
    const replacement=sessions.start('scripture','new-owner',options);
    assert.equal(sessions.stopOwned('scripture','old-owner'),false);assert.equal(sessions.check('scripture',replacement.id,'new-owner').id,replacement.id);assert.equal(sessions.hasActive(),true);
    sessions.stopOwned('scripture','new-owner');assert.equal(sessions.hasActive(),false);
  }finally{library.close();}
});
test('station-wide active check counts all channels and prunes expired leases',t=>{
  const library=new WorshipLibrary(':memory:'),sessions=new ListeningSessions(library,()=>{});
  const options={mode:'assisted' as const,language:'en',commands:false},now=Date.now();
  try {
    t.mock.method(Date,'now',()=>now);
    const first=sessions.start('scripture','user',options);sessions.start('lyrics','other-user',options);
    sessions.stopOwned('scripture','user');assert.equal(sessions.hasActive(),true,'A different channel still blocks a station model change');
    t.mock.method(Date,'now',()=>now+45001);assert.equal(sessions.hasActive(),false,'Expired idle sessions do not indefinitely block model settings');
    assert.throws(()=>sessions.check('scripture',first.id,'user'),/stopped or expired/);
    const fresh=sessions.start('scripture','user',options);assert.equal(sessions.hasActive(),true);assert.notEqual(fresh.id,first.id);
  }finally{t.mock.restoreAll();library.close();}
});
