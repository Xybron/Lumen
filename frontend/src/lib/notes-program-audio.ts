import { StudioSignal,StudioPeer } from '@/lib/studio/signal';

/** Receive the existing Program Main mix without taking a scene or opening any
 * input device. Closing this receiver never stops the Program's own tracks. */
export function openNotesProgramAudio(abort:AbortSignal,onEnded:()=>void):Promise<{stream:MediaStream;close:()=>void}> {
  return new Promise((resolve,reject)=>{
    const signal=new StudioSignal();let peer:StudioPeer|null=null,settled=false,closed=false;
    const timeout=window.setTimeout(()=>fail(new Error('Program audio is unavailable. Start the Program engine in Studio or choose a microphone.')),12000);
    const close=()=>{if(closed)return;closed=true;clearTimeout(timeout);abort.removeEventListener('abort',cancel);signal.send({t:'unwatch',outputId:'program'});peer?.close();signal.close();};
    const fail=(error:Error)=>{if(closed)return;close();if(!settled)reject(error);else onEnded();};
    const cancel=()=>fail(new DOMException('Notes input cancelled.','AbortError'));
    abort.addEventListener('abort',cancel,{once:true});
    if(abort.aborted){cancel();return;}
    signal.onConnected=()=>signal.send({t:'watch',outputId:'program',compactProgram:true,monitorOnly:true});
    signal.onDisconnected=()=>fail(new Error('Program audio disconnected.'));
    signal.subscribe(message=>{
      if(closed)return;
      if(message.status&&['offline','error','stopped'].includes(message.status.state)) {fail(new Error('Program engine is not running. Start it in Studio or choose a microphone.'));return;}
      if(message.t!=='signal'||message.key!=='out:program'||!message.peerId)return;
      if(message.description?.type==='offer'){
        if(settled){fail(new Error('Program audio changed. Start Notes listening again.'));return;}
        peer?.close();peer=new StudioPeer(signal,message.peerId,message.key);const current=peer;
        current.pc.ontrack=event=>{
          if(closed||peer!==current||event.track.kind!=='audio')return;
          clearTimeout(timeout);settled=true;
          event.track.addEventListener('ended',()=>fail(new Error('Program audio ended.')),{once:true});
          resolve({stream:new MediaStream([event.track]),close});
        };
        current.pc.onconnectionstatechange=()=>{if(peer===current&&['failed','disconnected','closed'].includes(current.pc.connectionState))fail(new Error('Program audio disconnected.'));};
      }
      void peer?.receive(message).catch(error=>fail(error));
    });
  });
}
