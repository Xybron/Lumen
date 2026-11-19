import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {AssemblyStream,ASSEMBLYAI_MODEL,assemblyUrl} from '../src/assemblyai-stream.js';

test('AssemblyAI uses natural low-latency turn endings while retaining vocabulary and voice isolation',()=>{
  const params=new URL(assemblyUrl()).searchParams;
  assert.equal(params.get('mode'),'min_latency');
  assert.equal(params.get('speech_model'),ASSEMBLYAI_MODEL);
  assert.equal(params.get('voice_focus'),'near-field');
  assert.equal(params.get('voice_focus_threshold'),'0.5');
  assert.ok(JSON.parse(params.get('keyterms_prompt')!).includes('John'));
});

test('AssemblyAI forwards provider finals immediately, does not slice every ten seconds, and flushes on Stop',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const port=(server.address() as {port:number}).port;let received=0,ended=false,endpoints=0;
  const finalTurn={type:'Turn',turn_order:0,transcript:'John 3:16',end_of_turn:true};
  let finishReceived!:()=>void;const finished=new Promise<void>(resolve=>finishReceived=resolve);
  let terminateReceived!:()=>void;const terminated=new Promise<void>(resolve=>terminateReceived=resolve);
  server.on('connection',(socket,request)=>{
    assert.equal(request.headers.authorization,'fake-test-key');
    socket.send(JSON.stringify({type:'Begin',configuration:{model:ASSEMBLYAI_MODEL,voice_focus:'near-field'}}));
    socket.on('message',(data,binary)=>{
      if(binary){
        received+=Array.isArray(data)?data.reduce((sum,part)=>sum+part.length,0):data.byteLength;
        // A provider-finalized turn can arrive before any client endpoint.
        if(received===3200)socket.send(JSON.stringify(finalTurn));
      }else{
        const message=JSON.parse(String(data));
        if(message.type==='ForceEndpoint'){endpoints++;socket.send(JSON.stringify({...finalTurn,turn_order:1,transcript:''}));finishReceived();}
        if(message.type==='Terminate'){ended=true;terminateReceived();}
      }
    });
  });
  let done!:(value:unknown)=>void;const turn=new Promise(resolve=>done=resolve);
  const stream=new AssemblyStream('fake-test-key',done,message=>assert.fail(message),`ws://127.0.0.1:${port}`);
  try{
    await stream.connected;stream.send(Buffer.alloc(3200));
    assert.deepEqual(await turn,finalTurn);
    assert.equal(endpoints,0,'Provider finals do not wait for client-forced boundaries');
    for(let i=0;i<100;i++)stream.send(Buffer.alloc(3200));
    stream.finish();await finished;
    assert.equal(received,323200,'All audio forwards without truncation or duplication');
    assert.equal(endpoints,1,'Only explicit Stop forces an endpoint, even across ten seconds of audio');
    assert.equal(ended,false,'Finishing still allows the final transcript to arrive');
    stream.close();await terminated;assert.ok(ended);
  }finally{stream.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
