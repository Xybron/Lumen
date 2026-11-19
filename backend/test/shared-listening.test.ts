import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import express from 'express';
import WebSocket from 'ws';
import type {ListeningResult} from '../../shared/worship.js';
import type {SharedListeningSnapshot} from '../../shared/listening.js';
import type {RelayHandle} from '../src/ws.js';

test('shared listening reserves one producer and privately fans out only the latest update',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-shared-listening-'));
  const previousDirectory=process.env.LUMEN_DATA_DIR,previousKey=process.env.ASSEMBLYAI_API_KEY;
  process.env.LUMEN_DATA_DIR=directory;process.env.ASSEMBLYAI_API_KEY='fake-test-key-never-connected';
  const {CONTENT_FILE}=await import('../src/paths.js');
  const {initDb}=await import('../src/db.js'),identity=initDb();
  const {login,createUser,setGrant,logout}=await import('../src/auth.js');
  const adminLogin=login('admin','admin')!,admin={Cookie:`lumen_session=${adminLogin.sessionId}`};
  const reader=createUser('shared-reader','Reader','test-password')!;setGrant(reader.id,'source','author');
  const readerLogin=login('shared-reader','test-password')!,readerHeaders={Cookie:`lumen_session=${readerLogin.sessionId}`};
  const viewer=createUser('shared-viewer','Viewer','test-password')!;setGrant(viewer.id,'*','viewer');
  const viewerHeaders={Cookie:`lumen_session=${login('shared-viewer','test-password')!.sessionId}`};
  const {SharedListeningHub}=await import('../src/shared-listening.js');
  const hub=new SharedListeningHub();let server:http.Server|undefined,worship:Awaited<ReturnType<typeof import('../src/worship.js')['createWorship']>>|undefined;
  const streams:AbortController[]=[];
  t.after(async()=>{
    for(const abort of streams)abort.abort();hub.close();worship?.close();
    server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));identity.close();
    if(previousDirectory===undefined)delete process.env.LUMEN_DATA_DIR;else process.env.LUMEN_DATA_DIR=previousDirectory;
    if(previousKey===undefined)delete process.env.ASSEMBLYAI_API_KEY;else process.env.ASSEMBLYAI_API_KEY=previousKey;
    await fs.rm(directory,{recursive:true,force:true});
  });
  const result=(transcript:string):ListeningResult=>({transcript,elapsedMs:4,candidate:null,match:'none',score:0,switched:false,decision:'listening',reason:'Listening',workspace:{channelId:'source',revision:0,versionId:'KJV',setlist:[],recent:[],live:null,blanked:false,theme:{background:'#000000',color:'#ffffff',size:'lg',align:'center'}}});
  const session={id:randomUUID(),channelId:'source',source:'scripture' as const,ownerId:adminLogin.user.id,provider:'assemblyai' as const,startedAt:Date.now()};
  const events:SharedListeningSnapshot[]=[];let stops=0;
  hub.subscribe(snapshot=>events.push(snapshot));
  hub.reserve(session,()=>{stops++;});assert.equal(hub.snapshot().session?.state,'starting');
  assert.throws(()=>hub.reserve({...session,id:randomUUID()},()=>{}),/already active/);
  hub.ready(session.id);hub.publish(session.id,result('Private words before Notes exists'),false,0);
  assert.equal(hub.snapshot().result?.transcript,'Private words before Notes exists');
  assert.equal(hub.snapshot().session?.linkedNotes,0);
  const detached=hub.snapshot();detached.result!.transcript='mutated';assert.equal(hub.snapshot().result?.transcript,'Private words before Notes exists');
  let throwingCalls=0;const unsubscribeFailure=hub.subscribe(()=>{throwingCalls++;throw new Error('Independent consumer failed');});
  hub.publish(session.id,result('Completed private words'),true,0);assert.equal(throwingCalls,1);unsubscribeFailure();
  hub.setLinkedCount(session.id,2);assert.equal(hub.snapshot().session?.linkedNotes,2);
  const length=events.length;hub.setLinkedCount(session.id,2);assert.equal(events.length,length,'Unchanged metadata does not recurse through consumers');

  await fs.writeFile(CONTENT_FILE,JSON.stringify({version:2,channels:[{id:'source',kind:'scripture'},{id:'other-source',kind:'scripture'}],playlists:[]}));
  const {createWorship}=await import('../src/worship.js');
  const relay={setAuthoritativeChannel(){},injectRemote(){}} as unknown as RelayHandle;
  worship=await createWorship(relay,hub);
  const app=express();app.use(express.json());app.use('/api',hub.router);app.use('/api',worship.router);
  server=http.createServer(app);server.on('upgrade',(req,socket,head)=>worship!.cloudWss.handleUpgrade(req,socket,head,ws=>worship!.cloudWss.emit('connection',ws,req)));
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,url=`${base}/api/listening/shared`;
  const wait=async(fn:()=>boolean,label:string)=>{const end=Date.now()+5000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error(`Timed out: ${label}`);};
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(`${url}/events`)).status,401);
  const view=await fetch(url,{headers:viewerHeaders});assert.equal(view.headers.get('cache-control'),'private, no-store');assert.equal((await view.json()).session,null,'A viewer cannot discover the private producer or transcript');
  assert.equal((await(await fetch(url,{headers:readerHeaders})).json()).result.transcript,'Completed private words');
  assert.equal((await fetch(`${url}?session=${session.id}`,{method:'DELETE',headers:readerHeaders})).status,403,'An author subscriber cannot stop another operator’s microphone');
  const abort=new AbortController();streams.push(abort);
  const sse=await fetch(`${url}/events`,{headers:readerHeaders,signal:abort.signal});assert.match(sse.headers.get('content-type')??'',/^text\/event-stream(?:;|$)/);
  const sseEvents:SharedListeningSnapshot[]=[];let streamEnded=false;
  const read=(async()=>{const reader=sse.body!.getReader(),decoder=new TextDecoder();let pending='';try{while(true){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});let end:number;while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);if(frame.startsWith('data: '))sseEvents.push(JSON.parse(frame.slice(6)));}}}finally{streamEnded=true;}})();
  await wait(()=>sseEvents.length===1,'initial private snapshot');
  hub.publish(session.id,result('New current words'),false,1);await wait(()=>sseEvents.at(-1)?.turn===1,'live event');
  setGrant(readerLogin.user.id,'source','viewer');hub.publish(session.id,result('Must not leak after revocation'),true,1);
  await wait(()=>sseEvents.at(-1)?.session===null,'revocation clears subscriber');
  assert.ok(!JSON.stringify(sseEvents).includes('Must not leak after revocation'));
  logout(readerLogin.sessionId);hub.publish(session.id,result('Must not leak after logout'),true,2);
  await wait(()=>streamEnded,'logout closes private event stream');await read;
  assert.equal((await fetch(`${url}?session=${session.id}`,{method:'DELETE',headers:admin})).status,200);
  assert.equal(stops,1);assert.equal(hub.snapshot().session?.state,'finishing');hub.stop(session.id);assert.equal(stops,1,'Repeated Stop is idempotent');
  hub.ready(session.id);assert.equal(hub.snapshot().session?.state,'finishing','Late ready cannot resurrect a stopped producer');
  hub.publish(session.id,result('Final words during drain'),true,2);assert.equal(hub.snapshot().result?.transcript,'Final words during drain');hub.end(session.id);
  assert.deepEqual(hub.snapshot(),{session:null,result:null,final:false,turn:-1});
  hub.publish(session.id,result('Late old producer'),true,3);assert.equal(hub.snapshot().result,null);

  // Creating a cloud lease does not make a provider connection. Reserve it
  // before awaiting credentials, keep it across manual publication, and reject
  // another capture even on a different Scripture channel.
  const start=(channel='source')=>fetch(`${base}/api/worship/channels/${channel}/listening`,{method:'POST',headers:{...admin,'Content-Type':'application/json'},body:JSON.stringify({provider:'assemblyai',mode:'assisted'})});
  const started=await start();assert.equal(started.status,200);const lease=await started.json();assert.equal(hub.snapshot().session?.id,lease.id);
  assert.equal((await start('other-source')).status,409);
  const take=await fetch(`${base}/api/worship/channels/source/command`,{method:'POST',headers:{...admin,'Content-Type':'application/json'},body:JSON.stringify({revision:0,command:{type:'take',selection:{kind:'scripture',versionId:'KJV',book:43,chapter:3,verse:16}}})});
  assert.equal(take.status,200);assert.equal(hub.snapshot().session?.id,lease.id,'Taking a reviewed verse does not stop shared listening');
  await fs.writeFile(CONTENT_FILE,JSON.stringify({version:2,channels:[{id:'other-source',kind:'scripture'}],playlists:[]}));
  const rejected=await new Promise<{type:string;message:string}>((resolve,reject)=>{
    const socket=new WebSocket(`${base.replace('http:','ws:')}/worship/listening/stream?channel=source&session=${lease.id}`,{headers:{...admin,Origin:base}});
    const timeout=setTimeout(()=>{socket.terminate();reject(new Error('Deleted producer channel was not rejected.'));},3000);
    socket.on('message',data=>{clearTimeout(timeout);socket.close();resolve(JSON.parse(String(data)));});socket.on('error',error=>{clearTimeout(timeout);reject(error);});
  });
  assert.equal(rejected.type,'error');assert.match(rejected.message,/no longer exists/,'Source deletion is checked before opening a provider connection');
  assert.equal((await fetch(`${url}?session=${lease.id}`,{method:'DELETE',headers:admin})).status,200);assert.equal(hub.snapshot().session,null,'Stopping before WS connection releases reservation');
});
