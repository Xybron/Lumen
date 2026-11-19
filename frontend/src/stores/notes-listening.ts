import { computed,ref,watch } from 'vue';
import { defineStore } from 'pinia';
import { useIdentityStore } from './identity';
import { usePresenceStore } from './presence';
import { useSharedListeningStore } from './shared-listening';
import { captureStreaming,listeningInputError,type ListeningInputInfo,type ListeningProcessing } from '@/lib/worship/audio';
import { openNotesProgramAudio } from '@/lib/notes-program-audio';
import type { NotesListeningSession } from '../../../shared/notes';

interface StartOptions { channelId:string;itemId:string;deviceId:string;processing:ListeningProcessing;source:'microphone'|'program' }

/** The shared microphone belongs to the listening session, never a Notes dialog. */
export const useNotesListeningStore=defineStore('notes-listening',()=>{
  const session=ref<NotesListeningSession|null>(null),starting=ref(false),finishing=ref(false),level=ref(0),error=ref('');
  const inputInfo=ref<ListeningInputInfo|null>(null),channelId=ref(''),active=computed(()=>starting.value||!!session.value);
  const identity=useIdentityStore(),presence=usePresenceStore(),shared=useSharedListeningStore();
  let abort:AbortController|undefined,stopCapture:(()=>void)|undefined,closeProgram:(()=>void)|undefined;
  let socket:WebSocket|undefined,closed:Promise<void>|undefined,deadline:number|undefined,stopTask:Promise<void>|undefined;
  let unregister:(()=>void)|undefined;
  async function request<T>(url:string,options:RequestInit={}):Promise<T>{
    const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}}),value=await response.json();
    if(!response.ok)throw new Error(value.error||'The station could not start shared listening.');return value;
  }
  async function stop(finish=true):Promise<void>{
    if(stopTask){if(!finish){socket?.close();socket=undefined;}return stopTask;}
    const current=session.value,connection=socket,connectionClosed=closed;
    abort?.abort();abort=undefined;stopCapture?.();stopCapture=undefined;closeProgram?.();closeProgram=undefined;
    clearTimeout(deadline);deadline=undefined;starting.value=false;level.value=0;
    const drain=finish&&connection?.readyState===WebSocket.OPEN&&!!current;finishing.value=!!drain;
    if(!drain){socket=undefined;connection?.close();}
    stopTask=(async()=>{
      if(drain){
        let timeout:number|undefined;
        try{connection.send(JSON.stringify({type:'stop'}));await Promise.race([connectionClosed,new Promise<void>(resolve=>{timeout=window.setTimeout(resolve,4000);})]);}
        catch{/* Completed turns remain in linked Notes. */}finally{clearTimeout(timeout);}
      }
      if(socket===connection){socket=undefined;closed=undefined;}connection?.close();
      if(session.value===current){session.value=null;unregister?.();unregister=undefined;}
      // A shared stop is independent of the optional originating Notes item.
      if(current)await request(`/api/listening/shared?session=${encodeURIComponent(current.id)}`,{method:'DELETE'}).catch(()=>{});
    })();
    try{await stopTask;}finally{stopTask=undefined;finishing.value=false;}
  }
  async function start(options:StartOptions){
    if(active.value||stopTask)return;
    const controller=new AbortController();abort=controller;channelId.value=options.channelId;
    const path=`/api/notes/channels/${encodeURIComponent(options.channelId)}/items/${encodeURIComponent(options.itemId)}`;
    starting.value=true;error.value='';inputInfo.value=null;shared.dismissError();
    const valid=()=>abort===controller&&!controller.signal.aborted;
    const fail=(message:string)=>{if(!valid())return;error.value=message;shared.reportError(message);void stop(false);};
    const ended=()=>fail('The audio input disconnected. Reconnect it before starting shared listening again.');
    let ready=false;
    try{
      let stream:MediaStream|undefined;
      if(options.source==='program'){
        const input=await openNotesProgramAudio(controller.signal,ended);
        if(!valid()){input.close();return;}stream=input.stream;closeProgram=input.close;
      }
      const release=await captureStreaming(options.deviceId,pcm=>{
        if(!valid()||!ready)return;
        if(socket?.readyState!==WebSocket.OPEN||socket.bufferedAmount>64000){fail('The network cannot keep up with the audio. Shared listening stopped.');return;}
        try{socket.send(pcm);}catch{fail('The audio connection failed. Start listening again when the connection is ready.');}
      },ended,{signal:controller.signal,stream,processing:stream?'mixer':options.processing,onInfo:info=>{if(valid())inputInfo.value=info;},onLevels:levels=>{if(valid())level.value=levels.rms;}});
      if(!valid()){release();return;}stopCapture=release;
      const lease=await request<NotesListeningSession>(`${path}/listening`,{method:'POST',body:JSON.stringify({provider:'assemblyai'}),signal:controller.signal});
      if(!valid()){void request(`/api/listening/shared?session=${encodeURIComponent(lease.id)}`,{method:'DELETE'}).catch(()=>{});return;}
      session.value=lease;
      unregister=shared.registerProducer(lease.id,()=>stop(true));
      const url=new URL('/notes/listening/stream',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
      url.searchParams.set('channel',options.channelId);url.searchParams.set('item',options.itemId);url.searchParams.set('session',lease.id);
      const connection=new WebSocket(url);socket=connection;closed=new Promise<void>(resolve=>connection.addEventListener('close',()=>resolve(),{once:true}));
      deadline=window.setTimeout(()=>fail('Shared listening did not start. Check your connection and try again.'),20000);
      connection.onmessage=event=>{
        if(socket!==connection||session.value?.id!==lease.id)return;
        let message:{type:string;message?:string};
        try{message=JSON.parse(event.data);}catch{if(!finishing.value)fail('The station returned an invalid listening response.');return;}
        if(message.type==='ready'){clearTimeout(deadline);deadline=undefined;ready=true;starting.value=false;}
        else if(message.type==='error'){error.value=message.message||'Shared listening stopped.';shared.reportError(error.value);if(finishing.value)connection.close();else void stop(false);}
      };
      connection.onerror=()=>{if(!finishing.value)fail('The shared audio connection failed. Check your connection and restart listening.');};
      connection.onclose=()=>{if(socket!==connection)return;clearTimeout(deadline);deadline=undefined;if(!finishing.value)fail('Shared listening disconnected. Completed passages remain in linked Notes.');};
    }catch(cause){if(valid()){error.value=listeningInputError(cause);shared.reportError(error.value);await stop(false);}}
  }
  watch(()=>[identity.me?.id,presence.owners] as const,([userId],[previousUser])=>{
    if(active.value&&(!userId||userId!==previousUser||!identity.can(channelId.value,'author')||presence.controlledByOther(channelId.value)))void stop(false);
  },{deep:true});
  watch(()=>shared.session?.state,state=>{if(state==='finishing'&&shared.session?.id===session.value?.id)void stop(true);});
  window.addEventListener('beforeunload',()=>{abort?.abort();stopCapture?.();closeProgram?.();socket?.close();});
  return {session,channelId,starting,finishing,active,level,error,inputInfo,start,stop};
});
