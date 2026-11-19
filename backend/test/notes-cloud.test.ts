import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import express from 'express';
import WebSocket from 'ws';
import type {LocalListener} from '../src/local-listener.js';
import type {AssemblyTurn} from '../src/assemblyai-stream.js';

test('Notes shares streaming scripture detection, commits only final turns, and revokes streams safely',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-notes-cloud-')),previous=process.env.LUMEN_DATA_DIR;
  process.env.LUMEN_DATA_DIR=directory;
  const {CONTENT_FILE,DATA_DIR}=await import('../src/paths.js');assert.equal(DATA_DIR,directory);
  const {initDb}=await import('../src/db.js'),identity=initDb();
  const {login,createUser,setGrant}=await import('../src/auth.js');
  const {saveOwner}=await import('../src/presence.js');
  const {WorshipLibrary}=await import('../src/worship-library.js'),library=new WorshipLibrary(':memory:');
  library.importBible({version:{id:'KJV',name:'KJV',attribution:'test'},verses:[
    {book:43,chapter:3,verse:16,text:'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.'},
    {book:7,chapter:3,verse:10,text:'And the Spirit of the LORD came upon him, and he judged Israel, and went out to war.'},
    {book:9,chapter:16,verse:13,text:'Then Samuel took the horn of oil, and anointed him in the midst of his brethren: and the Spirit of the LORD came upon David from that day forward.'},
  ]});
  const adminLogin=login('admin','admin')!,admin={Cookie:`lumen_session=${adminLogin.sessionId}`};
  const author=createUser('cloud-notes-author','Author','test-password')!;setGrant(author.id,'channel','author');
  const authorHeaders={Cookie:`lumen_session=${login('cloud-notes-author','test-password')!.sessionId}`};
  const content={version:2,channels:[{id:'channel',playlistId:'deck',kind:'presentation'}],playlists:[{id:'deck',items:[{id:'note',type:'notes',title:'Approved',body:'Public reviewed slide',layout:'statement'}]}]};
  const original=JSON.stringify(content);await fs.writeFile(CONTENT_FILE,original);
  let otherActive=false,localStarts=0,releaseKey:(()=>void)|undefined,pauseKey:Promise<void>|undefined,keyWaiting=false;
  const streams:Array<{turn:(value:AssemblyTurn)=>void;error:(message:string)=>void;bytes:number;closes:number;finishes:number;finishTurn?:AssemblyTurn}>=[];
  const listener={start:async()=>{localStarts++;}} as unknown as LocalListener;
  const {createNotes}=await import('../src/notes.js');
  const notes=createNotes({listener,library,otherListeningActive:()=>otherActive,cloudOptions:{
    key:async()=>{if(pauseKey){keyWaiting=true;await pauseKey;keyWaiting=false;}return 'fake-key';},
    createStream:(_key,turn,error)=>{
      const state={turn,error,bytes:0,closes:0,finishes:0,finishTurn:undefined as AssemblyTurn|undefined};streams.push(state);
      return {connected:Promise.resolve(),send:bytes=>{state.bytes+=bytes.length;},finish:()=>{state.finishes++;if(state.finishTurn)setTimeout(()=>turn(state.finishTurn!),10);},close:()=>{state.closes++;}};
    },
  }});
  const app=express();app.use(express.json());app.use('/api',notes.router);
  const server=http.createServer(app);server.on('upgrade',(req,socket,head)=>notes.cloudWss!.handleUpgrade(req,socket,head,ws=>notes.cloudWss!.emit('connection',ws,req)));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,url=`${base}/api/notes/channels/channel/items/note`;
  const sockets:WebSocket[]=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();notes.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));library.close();identity.close();if(previous===undefined)delete process.env.LUMEN_DATA_DIR;else process.env.LUMEN_DATA_DIR=previous;await fs.rm(directory,{recursive:true,force:true});});
  const wait=async(fn:()=>unknown,label:string)=>{const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error(`Timed out: ${label}`);};
  const post=(headers=admin)=>fetch(`${url}/listening`,{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:base},body:JSON.stringify({provider:'assemblyai'})});
  const get=async()=>await(await fetch(url,{headers:admin})).json();
  const connect=(id:string,headers=admin,origin=base,item='note')=>{
    const socket=new WebSocket(`${base.replace('http:','ws:')}/notes/listening/stream?channel=channel&item=${item}&session=${id}`,{headers:{...headers,Origin:origin}}),messages:any[]=[];
    socket.on('message',data=>messages.push(JSON.parse(String(data))));sockets.push(socket);return {socket,messages};
  };
  const turn=(order:number,transcript:string,final=false):AssemblyTurn=>({type:'Turn',turn_order:order,transcript,end_of_turn:final});
  assert.equal((await fetch(`${url}/listening`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"provider":"assemblyai"}'})).status,401);
  otherActive=true;assert.equal((await post()).status,409);otherActive=false;
  // An in-flight cloud start owns the listener before its key lookup settles.
  pauseKey=new Promise<void>(resolve=>{releaseKey=resolve;});const pending=post();
  await wait(()=>notes.hasActive(),'pending Notes reservation');assert.equal((await post()).status,409);assert.equal(localStarts,0);
  releaseKey!();pauseKey=undefined;const lease=await(await pending).json();assert.equal(lease.provider,'assemblyai');
  assert.equal((await fetch(`${url}/listening/audio?session=${lease.id}&sequence=0`,{method:'POST',headers:{...admin,'Content-Type':'audio/wav'},body:Buffer.alloc(64)})).status,409);
  const wrong=connect(lease.id,admin,'https://wrong.example');await wait(()=>wrong.messages.some(m=>m.type==='error'),'wrong origin rejection');assert.equal(streams.length,0);assert(notes.hasActive());
  const wrongItem=connect(lease.id,admin,base,'different-note');await wait(()=>wrongItem.messages.some(m=>m.type==='error'),'wrong item rejection');assert.equal(streams.length,0);
  const live=connect(lease.id);await wait(()=>live.messages.some(m=>m.type==='ready'),'ready');assert.equal(streams.length,1);
  const duplicate=connect(lease.id);await wait(()=>duplicate.messages.some(m=>m.type==='error'),'duplicate socket rejection');assert.equal(streams[0].closes,0);assert(notes.hasActive());
  live.socket.send(Buffer.alloc(3200));await wait(()=>streams[0].bytes===3200,'audio forwarding');
  streams[0].turn(turn(0,'John chapter three verse sixteen'));
  await wait(()=>live.messages.some(m=>m.type==='result'),'partial result');assert.equal(live.messages.at(-1).result.candidate,null,'A provisional citation waits for confirmation');assert.equal((await get()).segments.length,0);
  streams[0].turn(turn(0,'John chapter three verse sixteen',true));
  await wait(()=>live.messages.some(m=>m.segment),'final segment');assert.equal(live.messages.at(-1).result.candidate.reference,'John 3:16 · KJV');
  streams[0].turn(turn(0,'John chapter three verse sixteen.',true));
  streams[0].turn(turn(1,'John chapter three verse sixteen',true));
  await wait(async()=>((await get()).segments.length===2),'distinct repeated turn');
  assert.deepEqual((await get()).segments.map((segment:any)=>segment.text),['John chapter three verse sixteen','John chapter three verse sixteen']);
  streams[0].turn(turn(2,'And the Spirit of the Lord came upon'));
  await wait(()=>live.messages.at(-1)?.turn===2,'ambiguous quote');assert.equal(live.messages.at(-1).result.candidate,null,'Shared quotation prefix stays withheld in Notes');
  streams[0].finishTurn=turn(2,'And the Spirit of the Lord came upon David from that day forward',true);
  live.socket.send(JSON.stringify({type:'stop'}));
  await once(live.socket,'close');assert.equal(streams[0].finishes,1);assert.equal(streams[0].closes,1);assert(!notes.hasActive());
  assert.equal((await get()).segments.length,3,'Stop flushes the final short utterance');
  assert.equal(live.messages.filter(m=>m.type==='result').at(-1).result.candidate.reference,'1 Samuel 16:13 · KJV');
  assert.equal(library.workspace('channel').live,null);assert.equal(await fs.readFile(CONTENT_FILE,'utf8'),original,'Speech never updates public slides');

  // An author losing permission cannot append a provider result already queued.
  const revokedLease=await(await post(authorHeaders)).json(),revoked=connect(revokedLease.id,authorHeaders);
  await wait(()=>revoked.messages.some(m=>m.type==='ready'),'author stream');setGrant(author.id,'channel','viewer');streams.at(-1)!.turn(turn(0,'John 3:16',true));
  await wait(()=>revoked.messages.some(m=>m.type==='error'),'revoked permission');assert.equal((await get()).segments.length,3);assert(!notes.hasActive());
  setGrant(author.id,'channel','author');
  const ownedLease=await(await post()).json(),owned=connect(ownedLease.id);await wait(()=>owned.messages.some(m=>m.type==='ready'),'owner stream');
  saveOwner('channel',author.id);streams.at(-1)!.turn(turn(0,'John 3:16',true));await wait(()=>owned.messages.some(m=>m.type==='error'),'control changed');assert.equal((await get()).segments.length,3);assert(!notes.hasActive());saveOwner('channel',adminLogin.user.id);

  const deletedLease=await(await post()).json(),deleted=connect(deletedLease.id);await wait(()=>deleted.messages.some(m=>m.type==='ready'),'deletion stream');
  content.playlists[0].items=[];await fs.writeFile(CONTENT_FILE,JSON.stringify(content));streams.at(-1)!.turn(turn(0,'John 3:16',true));await wait(()=>deleted.messages.some(m=>m.type==='result'),'deleted optional item');assert(notes.hasActive(),'Deleting the optional Note must not stop the preacher stream');
  assert.equal((await fetch(`${url}/listening?session=${deletedLease.id}`,{method:'DELETE',headers:admin})).status,200,'The producer can still be stopped after its launching Note is deleted');await fs.writeFile(CONTENT_FILE,original);
  assert.equal((await get()).segments.length,3);

  const stoppedLease=await(await post()).json(),stopped=connect(stoppedLease.id);await wait(()=>stopped.messages.some(m=>m.type==='ready'),'delete session');
  const stoppedStream=streams.at(-1)!;assert.equal((await fetch(`${url}/listening?session=${stoppedLease.id}`,{method:'DELETE',headers:admin})).status,200);assert.equal(stoppedStream.closes,1);
  stoppedStream.turn(turn(0,'John 3:16',true));assert.equal((await get()).segments.length,3,'Late callbacks after DELETE cannot append');assert(!notes.hasActive());

  const loadingLease=await(await post()).json(),beforeLoading=streams.length;
  pauseKey=new Promise<void>(resolve=>{releaseKey=resolve;});const loading=connect(loadingLease.id);
  await wait(()=>keyWaiting,'bridge key lookup');assert.equal((await fetch(`${url}/listening?session=${loadingLease.id}`,{method:'DELETE',headers:admin})).status,200);
  releaseKey!();pauseKey=undefined;await wait(()=>loading.socket.readyState===WebSocket.CLOSED,'cancelled socket closes');assert.equal(streams.length,beforeLoading,'Cancelled connection never starts a provider stream');assert(!notes.hasActive());

  const expiringLease=await(await post()).json(),expiring=connect(expiringLease.id);await wait(()=>expiring.messages.some(m=>m.type==='ready'),'expiring stream');
  const expiringStream=streams.at(-1)!,originalNow=Date.now;
  try{Date.now=()=>originalNow()+60000;assert(!notes.hasActive());}finally{Date.now=originalNow;}
  assert.equal(expiringStream.closes,1,'Expired Notes lease closes the provider');expiringStream.turn(turn(0,'John 3:16',true));assert.equal((await get()).segments.length,3);

  const unfinishedLease=await(await post()).json(),unfinished=connect(unfinishedLease.id);await wait(()=>unfinished.messages.some(m=>m.type==='ready'),'unresponsive finalization stream');
  streams.at(-1)!.turn(turn(0,'Unfinished last words'));await wait(()=>unfinished.messages.some(m=>m.type==='result'),'unfinished interim');unfinished.socket.send(JSON.stringify({type:'stop'}));
  await wait(()=>unfinished.messages.some(m=>m.type==='error'&&m.message.includes('Only completed passages were saved')),'bounded finalization warning');assert(!notes.hasActive());assert.equal((await get()).segments.length,3,'An unfinalized partial is never silently saved as verified words');
  assert.equal(localStarts,0,'AssemblyAI never starts local Whisper');
});
