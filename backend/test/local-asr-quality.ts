// Optional real-model smoke test: no microphone, station HTTP API, downloads or
// model/settings changes. Uses an already-installed Base English model, seeded
// synthetic noise and macOS `say` (Samantha). Not an accent-accuracy evaluation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import ffmpeg from 'ffmpeg-static';
import {fileURLToPath} from 'node:url';
import {LocalListener,localTranscript} from '../src/local-listener.js';
import {BOOK_NAMES,parseReferences} from '../src/scripture-reference.js';
import {WorshipLibrary} from '../src/worship-library.js';
import {ListeningSessions} from '../src/listening-session.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const executable=path.join(root,'data/ai/whisper.cpp-1.9.5/build/bin/whisper-server');
const model=path.join(root,'data/ai/models/ggml-base.en.bin');
await fs.access(executable);await fs.access(model);
if(process.platform!=='darwin')throw new Error('This optional smoke test uses macOS say; it never records a microphone.');
assert.ok(ffmpeg,'The installed FFmpeg binary is required.');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-asr-quality-'));
const listener=new LocalListener({dataDir:dir,executable,model});
const library=new WorshipLibrary(':memory:');
library.importBible({version:{id:'KJV',name:'King James Version',attribution:'Public domain'},verses:[{book:43,chapter:3,verse:16,text:'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.'},{book:19,chapter:23,verse:1,text:'The LORD is my shepherd; I shall not want.'}]});
const sessions=new ListeningSessions(library,()=>{}),lease=sessions.start('quality','synthetic-test',{mode:'automatic',language:'en',commands:false});
let baseline:ChildProcess|null=null,workerLog='';
const results:Array<{input:string;configuration:string;transcript:string;elapsedMs:number}> = [];

function wav(pcm:Buffer) {
  const out=Buffer.alloc(44+pcm.length);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);return out;
}
function generated(kind:'noise'|'hum'|'mixed') {
  const pcm=Buffer.alloc(16000*5*2);let seed=0x32ae4091;
  for(let i=0;i<pcm.length/2;i++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const noise=(seed/0xffffffff*2-1)*.01*32767;
    const hum=Math.sin(2*Math.PI*120*i/16000)*.006*32767;
    pcm.writeInt16LE(Math.round(kind==='noise'?noise:kind==='hum'?hum:noise*.1+hum),i*2);
  }
  return wav(pcm);
}
async function unusedPort() {
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as net.AddressInfo).port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port;
}
async function stop(child:ChildProcess|null) {
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=once(child,'exit').catch(()=>{});child.kill('SIGTERM');
  const timeout=setTimeout(()=>child.kill('SIGKILL'),3000);try{await exited;}finally{clearTimeout(timeout);}
}
try {
  const port=await unusedPort();
  // Reproduce the old configuration in a separate, random-loopback worker.
  baseline=spawn(executable,['--host','127.0.0.1','--port',String(port),'-m',model,'-t','4','--max-context','224','--beam-size','5','--no-fallback','--suppress-nst'],{stdio:['ignore','ignore','pipe']});
  baseline.stderr?.on('data',chunk=>{workerLog=(workerLog+chunk).slice(-10000);});
  let ready=false;
  for(let attempt=0;attempt<225;attempt++) {
    if(baseline.exitCode!==null)throw new Error(`Isolated baseline worker exited: ${workerLog}`);
    try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1500)})).ok;}catch{}
    if(ready)break;await new Promise(resolve=>setTimeout(resolve,400));
  }
  assert.equal(ready,true,'The isolated baseline worker must become ready.');
  const inputs=(['noise','hum','mixed'] as const).map(input=>({input,window:generated(input)}));
  for(const {input,window} of inputs) {
    const form=new FormData();form.append('file',new Blob([new Uint8Array(window)],{type:'audio/wav'}),'generated.wav');
    for(const [key,value] of Object.entries({response_format:'verbose_json',language:'en',detect_language:'false',translate:'false',temperature:'0',temperature_inc:'0',beam_size:'5',no_speech_thold:'0.6',no_language_probabilities:'true',prompt:`Bible book names: ${BOOK_NAMES.join(', ')}. Chapter, verse.`}))form.append(key,value);
    const start=performance.now(),response=await fetch(`http://127.0.0.1:${port}/inference`,{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
    assert.equal(response.ok,true);const raw=await response.json();
    results.push({input,configuration:'previous book-list prompt / context 224',transcript:localTranscript(raw),elapsedMs:Math.round(performance.now()-start)});
  }
  await stop(baseline);baseline=null;
  for(const [sequence,{input,window}] of inputs.entries()) {
    const result=await listener.transcribe(window,'en','scripture');
    results.push({input,configuration:'current empty prompt / context 0',transcript:result.text,elapsedMs:result.elapsedMs});
    assert.equal(parseReferences(result.text).length,0,`${input} must not invent a usable Bible reference`);
    assert.equal(BOOK_NAMES.filter(book=>result.text.toLowerCase().includes(book.toLowerCase())).length<2,true,`${input} must not echo a Bible-book list`);
    const accepted=sessions.accept('quality',lease.id,'synthetic-test',sequence,'scripture',result.text,result.elapsedMs,library.workspace('quality').revision);
    assert.equal(accepted.candidate,null,`${input} must not produce a candidate against the installed smoke-test library`);assert.equal(accepted.switched,false);
  }
  const aiff=path.join(dir,'reference.aiff');execFileSync('say',['-v','Samantha','-r','135','-o',aiff,'John chapter three, verse sixteen.']);
  const pcm=execFileSync(ffmpeg!,['-hide_banner','-loglevel','error','-i',aiff,'-af','apad=pad_dur=1','-ac','1','-ar','16000','-f','s16le','-'],{maxBuffer:384000});
  const reference=await listener.transcribe(wav(pcm),'en','scripture');
  results.push({input:'synthetic English John 3:16',configuration:'current empty prompt / context 0',transcript:reference.text,elapsedMs:reference.elapsedMs});
  assert.ok(parseReferences(reference.text).some(item=>item.book===43&&item.chapter===3&&item.verse===16&&item.complete),'Clear synthetic English reference remains recognised without a vocabulary prompt.');
  const candidate=sessions.accept('quality',lease.id,'synthetic-test',inputs.length,'scripture',reference.text,reference.elapsedMs,library.workspace('quality').revision);
  assert.equal(candidate.match,'reference');assert.equal(candidate.candidate?.reference,'John 3:16 · KJV');
  assert.equal(candidate.switched,true,'One clear synthetic reference must publish without a repeated WAV.');assert.equal(candidate.decision,'sent-live');
  console.log(JSON.stringify({passed:true,scope:'Synthetic smoke test only; does not measure Ghanaian English or Twi accuracy.',results,artifacts:dir},null,2));
} catch(error) {
  console.error(workerLog);throw error;
} finally {
  listener.close();library.close();await stop(baseline);
  await fs.writeFile(path.join(dir,'results.json'),JSON.stringify({scope:'Synthetic, no microphone or live station use.',results},null,2));
}
