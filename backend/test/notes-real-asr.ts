// Optional installed-runtime smoke: synthetic speech, no user microphone,
// downloads, live station or changes to model settings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import express from 'express';
import ffmpeg from 'ffmpeg-static';

assert.equal(process.platform,'darwin','This smoke uses the macOS installed app and synthetic Samantha voice.');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-notes-real-asr-data-'));
const artifacts=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-notes-real-asr-report-'));
process.env.LUMEN_DATA_DIR=directory;
const {DATA_DIR,CONTENT_FILE}=await import('../src/paths.js');assert.equal(DATA_DIR,directory);
const {initDb}=await import('../src/db.js'),{login}=await import('../src/auth.js');
const {LocalListener}=await import('../src/local-listener.js'),{createNotes}=await import('../src/notes.js');
const executable='/Applications/Lumen.app/Contents/Resources/listening/whisper-server';
const model='/Applications/Lumen.app/Contents/Resources/listening/models/ggml-base.en.bin';
await fs.access(executable);await fs.access(model);assert(ffmpeg);
const identity=initDb(),listener=new LocalListener({dataDir:directory,executable,model,vadModel:false});
const notes=createNotes({listener,otherListeningActive:()=>false});
let server:http.Server|undefined;const results:unknown[]=[];
try {
  const original=JSON.stringify({version:2,channels:[{id:'channel',playlistId:'deck',kind:'presentation'}],playlists:[{id:'deck',items:[{id:'notes',type:'notes',title:'Reviewed only',body:'Public content remains unchanged',layout:'statement'}]}]});
  await fs.writeFile(CONTENT_FILE,original);
  const app=express();app.use(express.json());app.use('/api',notes.router);server=http.createServer(app);
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notes/channels/channel/items/notes`,headers={Cookie:`lumen_session=${login('admin','admin')!.sessionId}`};
  const aiff=path.join(directory,'synthetic.aiff');execFileSync('say',['-v','Samantha','-r','145','-o',aiff,'We care for our community. Hope grows when we work together.']);
  const pcm=execFileSync(ffmpeg!,['-hide_banner','-loglevel','error','-i',aiff,'-af','apad=pad_dur=0.5','-ac','1','-ar','16000','-f','s16le','-'],{maxBuffer:384000});
  const wav=Buffer.alloc(44+pcm.length);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);
  const started=await fetch(`${base}/listening`,{method:'POST',headers});assert.equal(started.status,200,await started.clone().text());const lease=await started.json() as {id:string};
  const submit=()=>fetch(`${base}/listening/audio?session=${lease.id}&sequence=0`,{method:'POST',headers:{...headers,'Content-Type':'audio/wav'},body:wav});
  const beginning=performance.now(),response=await submit();assert.equal(response.status,200,await response.clone().text());
  const document=await response.json() as {segments:{text:string;uncertain:boolean}[]};
  const text=document.segments.map(segment=>segment.text).join(' ');assert.match(text,/community/i);assert.match(text,/hope/i);assert.match(text,/together/i);
  const retry=await(await submit()).json() as typeof document;assert.deepEqual(retry.segments,document.segments,'Retry does not duplicate real recognition');
  assert.equal(await fs.readFile(CONTENT_FILE,'utf8'),original,'Real speech never enters public content automatically');
  const reopened=await(await fetch(base,{headers})).json() as typeof document;assert.deepEqual(reopened.segments,document.segments);
  await fetch(`${base}/listening?session=${lease.id}`,{method:'DELETE',headers});assert(!notes.hasActive());
  results.push({passed:true,model:path.basename(model),scope:'Synthetic English smoke, not accent/sermon accuracy evaluation',audioSeconds:pcm.length/32000,elapsedMs:Math.round(performance.now()-beginning),segments:document.segments,publicContentUnchanged:true});
  console.log(JSON.stringify({results,artifacts},null,2));
}finally{
  server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  notes.close();listener.close();identity.close();await fs.writeFile(path.join(artifacts,'report.json'),JSON.stringify(results,null,2));await fs.rm(directory,{recursive:true,force:true});
}
