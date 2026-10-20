export type ListeningProcessing = 'speech' | 'mixer';
export interface ListeningLevels { rms:number; peak:number; clipping:boolean }
export interface ListeningInputInfo { deviceId:string; label:string; sampleRate:number; processing:ListeningProcessing }
export interface ListeningCaptureOptions {
  signal?:AbortSignal;
  processing?:ListeningProcessing;
  onInfo?:(info:ListeningInputInfo)=>void;
  onLevels?:(levels:ListeningLevels)=>void;
}

export function listeningInputError(error:unknown):string {
  const name=error instanceof Error?error.name:'';
  if(name==='NotAllowedError'||name==='PermissionDeniedError')return 'Microphone access is blocked. Allow it in your browser’s site settings and your system’s Microphone privacy settings, then try again.';
  if(name==='NotFoundError'||name==='DevicesNotFoundError')return 'No audio input was found. Connect a microphone or audio interface, then refresh the device list.';
  if(name==='OverconstrainedError'||name==='ConstraintNotSatisfiedError')return 'The selected audio input is unavailable. Reconnect it or explicitly select another device.';
  if(name==='NotReadableError'||name==='TrackStartError')return 'The audio input could not be opened. Check the device connection and whether another application has exclusive access.';
  if(name==='SecurityError')return 'Microphone access is disabled. Use localhost or HTTPS and allow microphone access for this site.';
  return error instanceof Error?error.message:'The audio input could not be opened. Check its connection and permissions.';
}

export function listeningAudioConstraints(deviceId:string,processing:ListeningProcessing='speech'):MediaStreamConstraints {
  const enabled=processing==='speech';
  return {audio:{deviceId:deviceId?{exact:deviceId}:undefined,channelCount:{ideal:1},echoCancellation:enabled,noiseSuppression:enabled,autoGainControl:enabled},video:false};
}

export function wav16k(samples:Float32Array,rate:number):Blob {
  const ratio=rate/16000,length=Math.floor(samples.length/ratio),buffer=new ArrayBuffer(44+length*2),view=new DataView(buffer);
  const text=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
  text(0,'RIFF');view.setUint32(4,36+length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,length*2,true);
  for(let i=0;i<length;i++){const start=Math.floor(i*ratio),end=Math.max(start+1,Math.floor((i+1)*ratio));let sample=0;for(let j=start;j<end;j++)sample+=samples[j]??0;sample=Math.max(-1,Math.min(1,sample/(end-start)));view.setInt16(44+i*2,sample<0?sample*32768:sample*32767,true);}
  return new Blob([buffer],{type:'audio/wav'});
}
/** getUserMedia cannot be aborted by browsers; a late stream is stopped before
 * it can be attached to an audio graph. Every graph produces only silence. */
async function openListeningInput(deviceId:string,onSamples:(samples:Float32Array,rate:number)=>void,onEnded:()=>void,options:ListeningCaptureOptions) {
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Listening requires localhost or HTTPS and a browser with microphone support.');
  const signal=options.signal,processing=options.processing??'speech';
  let stopped=false,stream:MediaStream|undefined,context:AudioContext|undefined,source:MediaStreamAudioSourceNode|undefined,node:AudioWorkletNode|undefined;
  let effectiveDeviceId='',deviceCheckSequence=0;
  const ended=()=>{if(stopped)return;stop();onEnded();};
  const deviceChange=()=>{
    const sequence=++deviceCheckSequence;
    if(!effectiveDeviceId||!navigator.mediaDevices.enumerateDevices)return;
    void navigator.mediaDevices.enumerateDevices().then(devices=>{
      if(stopped||sequence!==deviceCheckSequence)return;
      if(!devices.some(device=>device.kind==='audioinput'&&device.deviceId===effectiveDeviceId))ended();
    }).catch(error=>{
      if(stopped||sequence!==deviceCheckSequence)return;
      if(error instanceof Error&&['NotAllowedError','SecurityError'].includes(error.name))ended();
    });
  };
  const abortError=()=>new DOMException('Audio input cancelled.','AbortError');
  const check=()=>{if(stopped||signal?.aborted)throw abortError();};
  const stop=()=>{
    if(stopped)return;
    stopped=true;signal?.removeEventListener('abort',stop);
    navigator.mediaDevices?.removeEventListener?.('devicechange',deviceChange);
    if(node){node.port.onmessage=null;node.port.close();node.disconnect();}
    source?.disconnect();
    stream?.getTracks().forEach(track=>{track.onended=null;track.stop();});
    if(context&&context.state!=='closed')void context.close().catch(()=>{});
  };
  signal?.addEventListener('abort',stop,{once:true});
  try {
    check();
    const acquired=await navigator.mediaDevices.getUserMedia(listeningAudioConstraints(deviceId,processing));
    if(stopped||signal?.aborted){acquired.getTracks().forEach(track=>track.stop());throw abortError();}
    stream=acquired;
    const track=stream.getAudioTracks()[0];
    if(!track||track.readyState==='ended')throw new Error('The selected audio input disconnected. Reconnect it or select another device.');
    track.onended=ended;
    const settings=track.getSettings();
    effectiveDeviceId=settings.deviceId||deviceId;
    // The live capture outlives channel panels. Guard its actual device here,
    // not only in the settings component: a browser may keep a default track
    // alive after unplugging it and otherwise switch microphones silently.
    if(effectiveDeviceId&&!['default','communications'].includes(effectiveDeviceId))navigator.mediaDevices.addEventListener?.('devicechange',deviceChange);
    else effectiveDeviceId='';
    context=new AudioContext();
    await context.audioWorklet.addModule('/listening-worklet.js');check();
    await context.resume();check();
    node=new AudioWorkletNode(context,'lumen-listening');
    source=context.createMediaStreamSource(stream);source.connect(node);node.connect(context.destination);
    const sampleRate=context.sampleRate;let meterSamples=0,power=0,peak=0;
    node.port.onmessage=event=>{
      if(stopped)return;
      const samples=event.data as Float32Array;
      if(!(samples instanceof Float32Array))return;
      onSamples(samples,sampleRate);
      if(options.onLevels){
        for(const sample of samples){power+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
        meterSamples+=samples.length;
        if(meterSamples>=sampleRate*.06){options.onLevels({rms:Math.sqrt(power/meterSamples),peak,clipping:peak>=.98});meterSamples=0;power=0;peak=0;}
      }
    };
    options.onInfo?.({deviceId:settings.deviceId??deviceId,label:track.label||'Audio input',sampleRate,processing});
    return stop;
  }catch(error){stop();throw error;}
}

/** Local-only device test: no WAV generation, network requests, or monitoring. */
export function monitorListeningInput(deviceId:string,onEnded:()=>void,options:ListeningCaptureOptions={}) {
  return openListeningInput(deviceId,()=>{},onEnded,options);
}

export async function captureListening(deviceId:string,onWindow:(audio:Blob,level:number)=>void,onEnded:()=>void,options:ListeningCaptureOptions={}) {
  let rate=0,ring=new Float32Array(0),cursor=0,count=0,timer:number|undefined;
  const reset=()=>{clearInterval(timer);timer=undefined;};
  const stopInput=await openListeningInput(deviceId,(samples,sampleRate)=>{
    if(rate!==sampleRate){rate=sampleRate;ring=new Float32Array(Math.round(rate*5));cursor=0;count=0;}
    for(const sample of samples){ring[cursor]=sample;cursor=(cursor+1)%ring.length;count=Math.min(ring.length,count+1);}
  },()=>{reset();onEnded();},options);
  const stop=()=>{reset();stopInput();options.signal?.removeEventListener('abort',reset);};
  if(options.signal?.aborted){stop();return stop;}
  options.signal?.addEventListener('abort',reset,{once:true});
  timer=window.setInterval(()=>{
    if(!rate||count<rate*2.5)return;
    const samples=new Float32Array(count),start=(cursor-count+ring.length)%ring.length;let power=0;
    for(let i=0;i<count;i++){const sample=ring[(start+i)%ring.length];samples[i]=sample;power+=sample*sample;}
    onWindow(wav16k(samples,rate),Math.sqrt(power/count));
  },2500);
  return stop;
}
