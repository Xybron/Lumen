import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { captureListening,listeningAudioConstraints,listeningInputError,monitorListeningInput,wav16k } from '../../frontend/src/lib/worship/audio.js';

function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(value=>{resolve=value;});return {promise,resolve};}
function audioHarness(t:TestContext){
  const keys=['navigator','AudioContext','AudioWorkletNode','window','clearInterval'],originals=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  t.after(()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];}});
  const track={label:'USB service mixer',readyState:'live',stops:0,onended:null as null|(()=>void),stop(){this.stops++;this.readyState='ended';},getSettings:()=>({deviceId:'usb-mixer',sampleRate:48000})};
  const stream={getAudioTracks:()=>[track],getTracks:()=>[track]};let expectedStream:unknown=stream;
  const nodes:any[]=[],contexts:any[]=[],constraints:any[]=[],timers=new Map<number,()=>void>();let timerId=0;
  const mediaDevices=new EventTarget();let connected=true;
  let open=()=>Promise.resolve(stream),module=()=>Promise.resolve();
  Object.assign(mediaDevices,{getUserMedia:(value:unknown)=>{constraints.push(value);return open();},enumerateDevices:()=>Promise.resolve(connected?[{kind:'audioinput',deviceId:'usb-mixer'}]:[])});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices}});
  class Context {
    sampleRate=48000;state='running';closes=0;destination={};source={connections:[] as unknown[],disconnects:0,connect(value:unknown){this.connections.push(value);},disconnect(){this.disconnects++;}};
    audioWorklet={addModule:(url:string)=>{assert.equal(url,'/listening-worklet.js');return module();}};
    constructor(){contexts.push(this);}
    resume(){return Promise.resolve();}
    close(){this.closes++;this.state='closed';return Promise.resolve();}
    createMediaStreamSource(value:unknown){assert.equal(value,expectedStream);return this.source;}
  }
  class Worklet {
    connections:unknown[]=[];disconnects=0;port={onmessage:null as null|((event:{data:Float32Array})=>void),closes:0,close(){this.closes++;}};
    constructor(context:unknown,name:string){assert.ok(context instanceof Context);assert.equal(name,'lumen-listening');nodes.push(this);}
    connect(value:unknown){this.connections.push(value);}
    disconnect(){this.disconnects++;}
  }
  (globalThis as any).AudioContext=Context;(globalThis as any).AudioWorkletNode=Worklet;
  (globalThis as any).window={setInterval:(fn:()=>void)=>{timers.set(++timerId,fn);return timerId;}};
  (globalThis as any).clearInterval=(id:number)=>timers.delete(id);
  return {track,stream,nodes,contexts,constraints,timers,mediaDevices,expectStream(value:unknown){expectedStream=value;},setConnected(value:boolean){connected=value;},setOpen(value:typeof open){open=value;},setModule(value:typeof module){module=value;}};
}

test('Program listening owns cloned audio and never opens a microphone or stops Program tracks',async t=>{
  const h=audioHarness(t),descriptor=Object.getOwnPropertyDescriptor(globalThis,'MediaStream');
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'MediaStream',descriptor);else delete (globalThis as any).MediaStream;});
  const clone={...h.track,stops:0,readyState:'live',stop(){this.stops++;this.readyState='ended';}};
  Object.assign(h.track,{clone:()=>clone});
  class Stream {constructor(private tracks:typeof clone[]){h.expectStream(this);}getAudioTracks(){return this.tracks;}getTracks(){return this.tracks;}}
  Object.defineProperty(globalThis,'MediaStream',{configurable:true,value:Stream});
  const stop=await captureListening('',()=>{},()=>assert.fail('No disconnection expected'),{stream:h.stream as unknown as MediaStream});
  assert.equal(h.constraints.length,0,'Program audio requires no getUserMedia call');
  stop();stop();assert.equal(clone.stops,1);assert.equal(h.track.stops,0);assert.equal(h.track.readyState,'live');
});

test('listening selects the exact configured input and offers speech/clean-mixer processing',()=>{
  assert.deepEqual(listeningAudioConstraints('usb-mixer','speech'),{audio:{deviceId:{exact:'usb-mixer'},channelCount:{ideal:1},echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  assert.deepEqual(listeningAudioConstraints('usb-mixer','mixer'),{audio:{deviceId:{exact:'usb-mixer'},channelCount:{ideal:1},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
  assert.equal((listeningAudioConstraints('').audio as MediaTrackConstraints).deviceId,undefined);
});

test('listening cancellation releases a permission-prompt stream that resolves late',async t=>{
  const h=audioHarness(t),pending=deferred<typeof h.stream>(),abort=new AbortController();h.setOpen(()=>pending.promise);
  const capture=monitorListeningInput('usb-mixer',()=>assert.fail('Cancel is not disconnect'),{signal:abort.signal});
  abort.abort();pending.resolve(h.stream);
  await assert.rejects(capture,{name:'AbortError'});
  assert.equal(h.track.stops,1);assert.equal(h.contexts.length,0);assert.equal(h.nodes.length,0);
});

test('listening cancellation during worklet loading closes context and never attaches input',async t=>{
  const h=audioHarness(t),pending=deferred<void>(),abort=new AbortController();h.setModule(()=>pending.promise);
  const capture=monitorListeningInput('usb-mixer',()=>assert.fail('Cancel is not disconnect'),{signal:abort.signal});
  await Promise.resolve();assert.equal(h.contexts.length,1);abort.abort();pending.resolve();
  await assert.rejects(capture,{name:'AbortError'});
  assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closes,1);assert.equal(h.nodes.length,0);
});

test('local meter reports real input/levels without creating WAV windows and releases once',async t=>{
  const h=audioHarness(t),levels:any[]=[],info:any[]=[];let ended=0;
  const stop=await monitorListeningInput('usb-mixer',()=>{ended++;},{onInfo:value=>info.push(value),onLevels:value=>levels.push(value)});
  assert.deepEqual(info,[{deviceId:'usb-mixer',label:'USB service mixer',sampleRate:48000,processing:'speech'}]);
  assert.equal(h.timers.size,0,'Local meter never starts a WAV-window timer');
  h.nodes[0].port.onmessage({data:new Float32Array(3000).fill(.99)});
  assert.equal(levels.length,1);assert.equal(levels[0].clipping,true);assert.ok(levels[0].rms>.98);
  h.track.onended?.();assert.equal(ended,1);stop();stop();
  assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closes,1);assert.equal(h.nodes[0].port.closes,1);assert.equal(h.nodes[0].disconnects,1);assert.equal(h.contexts[0].source.disconnects,1);
});

test('capture emits 16 kHz WAV windows on the sample clock and stops on abort',async t=>{
  const h=audioHarness(t),abort=new AbortController(),windows:Blob[]=[];
  const stop=await captureListening('usb-mixer',audio=>{windows.push(audio);},()=>assert.fail('Abort is not a disconnect'),{signal:abort.signal,processing:'mixer'});
  h.nodes[0].port.onmessage({data:new Float32Array(48000*3).fill(.2)});
  assert.equal(h.timers.size,0,'Capture does not depend on throttled background-tab timers');
  assert.equal(windows.length,1);
  const header=new DataView(await windows[0].arrayBuffer());assert.equal(header.getUint32(24,true),16000);assert.equal(header.getUint16(22,true),1);
  abort.abort();stop();assert.equal(h.timers.size,0);assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closes,1);
});

test('slow recognition retains busy-time speech and submits it with preceding context',async t=>{
  const h=audioHarness(t),pending=deferred<void>(),windows:Blob[]=[];
  const stop=await captureListening('usb-mixer',audio=>{windows.push(audio);return windows.length===1?pending.promise:undefined;},()=>assert.fail('Capture must stay connected'));
  const push=(seconds:number,value:number)=>h.nodes[0].port.onmessage({data:new Float32Array(48000*seconds).fill(value)});
  push(2.5,.1);assert.equal(windows.length,1);
  push(2.5,.2);push(2.5,.3);push(2.5,.4);
  assert.equal(windows.length,1,'Only one recognition request may be in flight');
  pending.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(windows.length,2,'Buffered speech is submitted as soon as recognition finishes');
  const second=new DataView(await windows[1].arrayBuffer());
  assert.equal(second.getUint32(40,true),16000*10*2);
  for(const [seconds,value] of [[1,.1],[3,.2],[6,.3],[9,.4]])assert.ok(Math.abs(second.getInt16(44+16000*seconds*2,true)/32767-value)<.001,'Context and every unsent interval are retained in order');
  stop();
});

test('capture does not resubmit old audio and keeps overlap for the next phrase',async t=>{
  const h=audioHarness(t),windows:Blob[]=[];
  const stop=await captureListening('usb-mixer',audio=>{windows.push(audio);},()=>{});
  h.nodes[0].port.onmessage({data:new Float32Array(48000*2.5).fill(.1)});
  h.nodes[0].port.onmessage({data:new Float32Array(48000).fill(.2)});
  assert.equal(windows.length,1,'An incomplete new stride cannot repeatedly resubmit the old window');
  h.nodes[0].port.onmessage({data:new Float32Array(48000*1.5).fill(.3)});
  assert.equal(windows.length,2);
  const second=new DataView(await windows[1].arrayBuffer());assert.equal(second.getUint32(40,true),16000*5*2);
  assert.ok(Math.abs(second.getInt16(44,true)/32767-.1)<.001);
  stop();
});

test('capture stops explicitly before a slow decoder overwrites unsubmitted speech',async t=>{
  const h=audioHarness(t),pending=deferred<void>();let overflow=0,windows=0;
  const stop=await captureListening('usb-mixer',()=>{windows++;return pending.promise;},()=>assert.fail('Overload is not a disconnected microphone'),{onOverflow:()=>{overflow++;}});
  const send=h.nodes[0].port.onmessage;
  send({data:new Float32Array(48000*2.5).fill(.2)});
  for(let i=0;i<5;i++)send({data:new Float32Array(48000*2.5).fill(.3)});
  assert.equal(overflow,1);assert.equal(h.track.stops,1);assert.equal(windows,1);
  pending.resolve();await new Promise(resolve=>setImmediate(resolve));stop();
  assert.equal(windows,1,'An old inference completion never restarts stopped capture');
});

test('a deferred window remains available until its consumer accepts it',async t=>{
  const h=audioHarness(t),windows:Blob[]=[];let ready=false;
  const stop=await captureListening('usb-mixer',audio=>{if(!ready)return false;windows.push(audio);},()=>{});
  h.nodes[0].port.onmessage({data:new Float32Array(48000*2.5).fill(.1)});
  ready=true;h.nodes[0].port.onmessage({data:new Float32Array(48000).fill(.2)});
  assert.equal(windows.length,1);
  const result=new DataView(await windows[0].arrayBuffer());assert.equal(result.getUint32(40,true),16000*3.5*2);
  assert.ok(Math.abs(result.getInt16(44,true)/32767-.1)<.001);stop();
});

test('live capture independently stops a removed device even when no channel settings panel remains',async t=>{
  const h=audioHarness(t);let ended=0;
  const stop=await captureListening('usb-mixer',()=>{},()=>{ended++;});
  h.setConnected(false);h.mediaDevices.dispatchEvent(new Event('devicechange'));await Promise.resolve();
  assert.equal(ended,1);assert.equal(h.track.stops,1);assert.equal(h.timers.size,0);assert.equal(h.contexts[0].closes,1);
  h.mediaDevices.dispatchEvent(new Event('devicechange'));await Promise.resolve();stop();assert.equal(ended,1);
});

test('an unavailable configured input fails explicitly without retrying the default microphone',async t=>{
  const h=audioHarness(t);h.setOpen(()=>Promise.reject(new DOMException('Unavailable','OverconstrainedError')));
  await assert.rejects(monitorListeningInput('missing-usb',()=>{}),{name:'OverconstrainedError'});
  assert.equal(h.constraints.length,1);assert.deepEqual(h.constraints[0].audio.deviceId,{exact:'missing-usb'});assert.match(listeningInputError(new DOMException('Unavailable','OverconstrainedError')),/explicitly select another device/);
  assert.match(listeningInputError(new DOMException('Denied','NotAllowedError')),/site settings/);
});

test('WAV conversion clamps samples to bounded signed PCM without changing the source',async()=>{
  const samples=new Float32Array([2,-2,.25]),blob=wav16k(samples,16000),view=new DataView(await blob.arrayBuffer());
  assert.equal(blob.type,'audio/wav');assert.equal(view.getInt16(44,true),32767);assert.equal(view.getInt16(46,true),-32768);assert.deepEqual([...samples],[2,-2,.25]);
});

test('listening worklet downmixes right-only stereo while every speaker output stays silent',async()=>{
  const source=await readFile(new URL('../../frontend/public/listening-worklet.js',import.meta.url),'utf8'),messages:Float32Array[]=[];
  let Registered:any;
  class Processor {port={postMessage:(samples:Float32Array,transfer:ArrayBuffer[])=>{assert.equal(transfer.length,1);assert.equal(transfer[0],samples.buffer);messages.push(samples);}};}
  vm.runInNewContext(source,{Float32Array,AudioWorkletProcessor:Processor,registerProcessor:(name:string,constructor:unknown)=>{assert.equal(name,'lumen-listening');Registered=constructor;}});
  const processor=new Registered(),left=new Float32Array(4),right=new Float32Array([1,-1,.8,-.8]),output=new Float32Array(4).fill(.5),otherOutput=new Float32Array(4).fill(.5);
  for(let i=0;i<255;i++)assert.equal(processor.process([[left,right]],[[output,otherOutput]]),true);
  assert.equal(messages.length,0,'Tiny render quanta are batched before transfer');
  processor.process([[left,right]],[[output,otherOutput]]);
  assert.equal(messages[0].length,1024);assert.deepEqual([...messages[0].slice(0,4)],[.5,-.5,Math.fround(.4),Math.fround(-.4)]);
  assert.deepEqual([...messages[0].slice(-4)],[.5,-.5,Math.fround(.4),Math.fround(-.4)]);
  assert.deepEqual([...left],[0,0,0,0]);assert.deepEqual([...right],[1,-1,Math.fround(.8),Math.fround(-.8)]);
  assert.deepEqual([...output],[0,0,0,0]);assert.deepEqual([...otherOutput],[0,0,0,0]);
  processor.process([[new Float32Array(1024).fill(1),new Float32Array(1024).fill(1)]],[[output]]);
  assert.ok(messages[1].every(value=>value===1),'Full-level stereo is averaged, not summed/clipped');
  for(let i=0;i<256;i++)processor.process([[right]],[[output]]);assert.deepEqual([...messages[2].slice(0,4)],[...right],'Mono retains its original gain');
  processor.process([[]],[[output.fill(.5)]]);assert.equal(messages.length,3);assert.deepEqual([...output],[0,0,0,0]);
});
