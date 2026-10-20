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
  const stream={getAudioTracks:()=>[track],getTracks:()=>[track]};
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
    createMediaStreamSource(value:unknown){assert.equal(value,stream);return this.source;}
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
  return {track,stream,nodes,contexts,constraints,timers,mediaDevices,setConnected(value:boolean){connected=value;},setOpen(value:typeof open){open=value;},setModule(value:typeof module){module=value;}};
}

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

test('capture preserves 16 kHz WAV windows and cleans its timer on abort',async t=>{
  const h=audioHarness(t),abort=new AbortController(),windows:Blob[]=[];
  const stop=await captureListening('usb-mixer',audio=>windows.push(audio),()=>assert.fail('Abort is not a disconnect'),{signal:abort.signal,processing:'mixer'});
  h.nodes[0].port.onmessage({data:new Float32Array(48000*3).fill(.2)});
  assert.equal(h.timers.size,1);for(const fn of h.timers.values())fn();
  assert.equal(windows.length,1);
  const header=new DataView(await windows[0].arrayBuffer());assert.equal(header.getUint32(24,true),16000);assert.equal(header.getUint16(22,true),1);
  abort.abort();stop();assert.equal(h.timers.size,0);assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closes,1);
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
  class Processor {port={postMessage:(samples:Float32Array)=>messages.push(samples)};}
  vm.runInNewContext(source,{Float32Array,AudioWorkletProcessor:Processor,registerProcessor:(name:string,constructor:unknown)=>{assert.equal(name,'lumen-listening');Registered=constructor;}});
  const processor=new Registered(),left=new Float32Array(4),right=new Float32Array([1,-1,.8,-.8]),output=new Float32Array(4).fill(.5),otherOutput=new Float32Array(4).fill(.5);
  assert.equal(processor.process([[left,right]],[[output,otherOutput]]),true);
  assert.deepEqual([...messages[0]],[.5,-.5,Math.fround(.4),Math.fround(-.4)]);
  assert.deepEqual([...left],[0,0,0,0]);assert.deepEqual([...right],[1,-1,Math.fround(.8),Math.fround(-.8)]);
  assert.deepEqual([...output],[0,0,0,0]);assert.deepEqual([...otherOutput],[0,0,0,0]);
  processor.process([[new Float32Array(4).fill(1),new Float32Array(4).fill(1)]],[[output]]);
  assert.deepEqual([...messages[1]],[1,1,1,1],'Full-level stereo is averaged, not summed/clipped');
  processor.process([[right]],[[output]]);assert.deepEqual([...messages[2]],[...right],'Mono retains its original gain');
  processor.process([[]],[[output.fill(.5)]]);assert.equal(messages.length,3);assert.deepEqual([...output],[0,0,0,0]);
});
