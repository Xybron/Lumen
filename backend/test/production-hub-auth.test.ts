import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { initialProduction, ProductionSchema } from '../src/production-schema.js';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../shared/program-monitor.js';

// Exercise the actual Hub frame/permission paths without opening a server or
// touching a real station. Identity lives in this test's temporary database.
class Socket extends EventEmitter {
  readyState=WebSocket.OPEN;
  messages:Record<string,unknown>[]=[];
  send(value:string) { this.messages.push(JSON.parse(value)); }
  ping() {}
  close() { this.readyState=WebSocket.CLOSED;this.emit('close'); }
  terminate() { this.close(); }
  frame(value:unknown) { this.emit('message',Buffer.from(JSON.stringify(value))); }
}

test('authenticated channel authors can watch Program without gaining private Preview/Multiview, publishing or arbitrary signaling authority',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-hub-auth-'));
  const originalDir=process.env.LUMEN_DATA_DIR;
  process.env.LUMEN_DATA_DIR=dir;
  const {initDb}=await import('../src/db.js');
  const db=initDb();
  const {createUser,setGrant,login}=await import('../src/auth.js');
  const {ProductionHub}=await import('../src/production-hub.js');
  const state=initialProduction();
  state.sources.push({id:'camera',name:'Camera',kind:'camera',loop:false,audio:{volume:1,muted:false,mode:'follow',delayMs:0}});
  const hub=new ProductionHub(req=>req.headers['x-test-engine']==='yes',()=>state,()=>({state:'running',fps:30,levels:{},sources:{},sourceErrors:{},recording:null}));
  t.after(async()=>{hub.close();db.close();if(originalDir===undefined)delete process.env.LUMEN_DATA_DIR;else process.env.LUMEN_DATA_DIR=originalDir;await fs.rm(dir,{recursive:true,force:true});});
  const user=createUser('scripture-author','Scripture operator','test-password')!;
  setGrant(user.id,'scripture','author');
  const partialCookie=`lumen_session=${login('scripture-author','test-password')!.sessionId}`;
  const adminCookie=`lumen_session=${login('admin','admin')!.sessionId}`;
  function connect(headers:Record<string,string>={}) {
    const socket=new Socket();
    hub.wss.emit('connection',socket as unknown as WebSocket,{headers} as IncomingMessage);
    return socket;
  }
  const engine=connect({'x-test-engine':'yes'}),partial=connect({cookie:partialCookie});
  const engineId=engine.messages.find(message=>message.t==='connected')!.peerId;
  engine.messages=[];
  partial.frame({t:'watch',outputId:'program'});
  assert.equal(engine.messages.at(-1)?.t,'watch');
  assert.equal(engine.messages.at(-1)?.outputId,'program');
  engine.messages=[];
  partial.frame({t:'watch',outputId:'preview'});
  partial.frame({t:'watch',outputId:'multiview'});
  partial.frame({t:'watch',outputId:PROGRAM_MONITOR_OUTPUT_ID});
  partial.frame({t:'publish',sourceId:'camera'});
  partial.frame({t:'signal',peerId:engineId,key:'out:preview',description:{type:'answer',sdp:'forged'}});
  partial.frame({t:'signal',peerId:engineId,key:'out:multiview',description:{type:'answer',sdp:'forged'}});
  partial.frame({t:'signal',peerId:engineId,key:`out:${PROGRAM_MONITOR_OUTPUT_ID}`,description:{type:'answer',sdp:'forged'}});
  assert.deepEqual(engine.messages,[]);

  const anonymous=connect();engine.messages=[];
  anonymous.frame({t:'watch',outputId:'program'});
  anonymous.frame({t:'watch',outputId:'preview'});
  anonymous.frame({t:'watch',outputId:'multiview'});
  anonymous.frame({t:'watch',outputId:PROGRAM_MONITOR_OUTPUT_ID});
  anonymous.frame({t:'publish',sourceId:'camera'});
  anonymous.frame({t:'signal',peerId:engineId,key:'out:multiview',description:{type:'answer',sdp:'forged'}});
  assert.deepEqual(engine.messages,[]);
  anonymous.frame({t:'watch',outputId:'screen_main'});
  assert.equal(engine.messages.at(-1)?.outputId,'screen_main','Public named outputs retain their existing access');

  // Even malformed legacy state cannot turn a private renderer feed into a
  // public named output. Schema validation separately prevents creating one.
  assert.equal(ProductionSchema.safeParse({...state,outputs:[{...state.outputs[0],id:PROGRAM_MONITOR_OUTPUT_ID}]}).success,false,'The private monitor ID cannot be configured as a public output');
  state.outputs.push({...state.outputs[0],id:'multiview'});engine.messages=[];
  state.outputs.push({...state.outputs[0],id:PROGRAM_MONITOR_OUTPUT_ID});
  anonymous.frame({t:'watch',outputId:'multiview'});
  partial.frame({t:'watch',outputId:'multiview'});
  anonymous.frame({t:'watch',outputId:PROGRAM_MONITOR_OUTPUT_ID});
  partial.frame({t:'watch',outputId:PROGRAM_MONITOR_OUTPUT_ID});
  const anonymousId=anonymous.messages.find(message=>message.t==='connected')!.peerId;
  engine.frame({t:'signal',peerId:anonymousId,key:'out:multiview',description:{type:'offer',sdp:'forged'}});
  assert.deepEqual(engine.messages,[]);
  assert.equal(anonymous.messages.some(message=>message.t==='signal'),false,'An unauthorized atlas peer cannot receive offers either');

  const admin=connect({cookie:adminCookie});engine.messages=[];
  admin.frame({t:'watch',outputId:'preview'});
  admin.frame({t:'watch',outputId:'multiview'});
  admin.frame({t:'watch',outputId:PROGRAM_MONITOR_OUTPUT_ID});
  admin.frame({t:'publish',sourceId:'camera'});
  assert.deepEqual(engine.messages.map(message=>message.t),['watch','watch','watch','publish']);
  assert.equal(engine.messages[0].outputId,'preview');
  assert.equal(engine.messages[1].outputId,'multiview');
  assert.equal(engine.messages[2].outputId,PROGRAM_MONITOR_OUTPUT_ID);
  assert.equal(engine.messages[3].sourceId,'camera');
  admin.frame({t:'signal',peerId:engineId,key:'out:multiview',description:{type:'answer',sdp:'authorized'}});
  assert.equal(engine.messages.at(-1)?.key,'out:multiview');
  admin.frame({t:'unwatch',outputId:'multiview'});
  assert.equal(engine.messages.at(-1)?.t,'unwatch');
  const afterUnwatch=engine.messages.length;
  admin.frame({t:'signal',peerId:engineId,key:'out:multiview',description:{type:'answer',sdp:'stale'}});
  assert.equal(engine.messages.length,afterUnwatch,'Unwatch revokes atlas signaling');
  admin.frame({t:'unwatch',outputId:PROGRAM_MONITOR_OUTPUT_ID});
  const afterMonitorUnwatch=engine.messages.length;
  admin.frame({t:'signal',peerId:engineId,key:`out:${PROGRAM_MONITOR_OUTPUT_ID}`,description:{type:'answer',sdp:'stale'}});
  assert.equal(engine.messages.length,afterMonitorUnwatch,'Unwatch revokes private monitor signaling');

  const global=createUser('all-channels','All-channel author','test-password')!;
  setGrant(global.id,'*','author');
  const globalAuthor=connect({cookie:`lumen_session=${login('all-channels','test-password')!.sessionId}`});
  engine.messages=[];globalAuthor.frame({t:'watch',outputId:'multiview'});
  assert.equal(engine.messages.at(-1)?.outputId,'multiview','Global authors have operator Multiview access');
  globalAuthor.frame({t:'watch',outputId:PROGRAM_MONITOR_OUTPUT_ID});
  assert.equal(engine.messages.at(-1)?.outputId,PROGRAM_MONITOR_OUTPUT_ID,'Global authors can use the lightweight private monitor');
});
