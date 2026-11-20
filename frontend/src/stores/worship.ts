import { ref, reactive, watch } from 'vue';
import { defineStore } from 'pinia';
import { toast } from 'vue-sonner';
import { subscribeTopics, subscribeWs } from '@/lib/ws';
import { worshipRequest } from '@/lib/worship/api';
import { captureListening,captureStreaming,listeningInputError,type ListeningInputInfo,type ListeningProcessing } from '@/lib/worship/audio';
import { useIdentityStore } from './identity';
import { usePresenceStore } from './presence';
import { useSharedListeningStore } from './shared-listening';
import type { BibleVersion, WorshipWorkspace, WorshipCommand, CueSelection, LiveCue, ListeningStatus, ListeningSession, ListeningResult, ScripturePin, ScriptureSelection } from '../../../shared/worship';

interface ListeningView { session:ListeningSession|null; starting:boolean; busy:boolean; level:number; peak:number; clipping:boolean; inputInfo:ListeningInputInfo|null; result:ListeningResult|null; error:string }
interface ListeningControls { provider:'local'|'assemblyai'; providerSelected?:boolean; mode:'assisted'|'automatic'; commands:boolean }
export const useWorshipStore=defineStore('worship',()=>{
  const scripturePins=ref<ScripturePin[]>([]),pinsBusy=ref(false);
  let pinsRequest=0;
  async function refreshPins(){if(pinsBusy.value)return;const request=++pinsRequest;const pins=await worshipRequest<ScripturePin[]>('/scripture-pins');if(request===pinsRequest)scripturePins.value=pins;}
  async function savePin(selection:ScriptureSelection,id?:string){
    if(pinsBusy.value)return;
    pinsBusy.value=true;const request=++pinsRequest;
    try{const pins=await worshipRequest<ScripturePin[]>(id?`/scripture-pins/${id}`:'/scripture-pins',{method:id?'DELETE':'POST',...(id?{}:{body:JSON.stringify(selection)})});if(request===pinsRequest)scripturePins.value=pins;}
    finally{pinsBusy.value=false;}
  }
  const workspaces=reactive<Record<string,WorshipWorkspace>>({}),drafts=reactive<Record<string,LiveCue|null>>({});
  const versions=ref<BibleVersion[]>([]),aiStatus=ref<ListeningStatus|null>(null),saving=reactive<Record<string,boolean>>({}),preparing=reactive<Record<string,boolean>>({});
  const listening=reactive<Record<string,ListeningView>>({});
  // Channel panels unmount when entering Studio. Keep their controls beside
  // the capture/session, in memory only: a reload must not restore auto mode.
  const listeningControls=reactive<Record<string,ListeningControls>>({});
  function listeningControlsFor(id:string){
    if(!listeningControls[id])listeningControls[id]={provider:'local',mode:'assisted',commands:false};
    return listeningControls[id];
  }
  const cloudSockets=new Map<string,WebSocket>();
  const cloudDraining=new Set<string>(),producerReleases=new Map<string,()=>void>();
  const shared=useSharedListeningStore(),sharedTargets=new Map<string,'scripture'|'lyrics'>(),sharedFrames=new Map<string,string>();
  const sharedResults=reactive<Record<string,ListeningResult|null>>({}),sharedErrors=reactive<Record<string,string>>({});
  const sharedTimers=new Map<string,number>();
  function followShared(id:string,kind:'scripture'|'lyrics'='scripture'){sharedTargets.set(id,kind);applyShared();shared.connect();}
  function applyShared(){
    const snapshot=shared.snapshot;
    if(snapshot.session?.mode){const session=listening[snapshot.session.channelId]?.session;if(session?.id===snapshot.session.id)session.mode=snapshot.session.mode;}
    if(!snapshot.session||!snapshot.result){sharedFrames.clear();for(const id of sharedTargets.keys()){clearTimeout(sharedTimers.get(id));sharedResults[id]=null;sharedErrors[id]='';}return;}
    const frame=JSON.stringify([snapshot.session.id,snapshot.turn,snapshot.result.transcript,snapshot.result.candidate?.selection??null,snapshot.result.reason]);
    for(const [id,kind] of sharedTargets){
      if(!identity.can(id,'author')||sharedFrames.get(id)===frame)continue;
      sharedFrames.set(id,frame);
      if(kind==='lyrics'){
        clearTimeout(sharedTimers.get(id));
        const sessionId=snapshot.session.id;
        sharedTimers.set(id,window.setTimeout(async()=>{
          try{
            const value=await worshipRequest<{sessionId:string;result:ListeningResult|null}>(`/channels/${id}/listening/shared-result?session=${encodeURIComponent(sessionId)}`);
            if(shared.session?.id!==sessionId||sharedFrames.get(id)!==frame)return;
            sharedResults[id]=value.result;sharedErrors[id]='';
          }catch(cause){if(shared.session?.id===sessionId&&sharedFrames.get(id)===frame){sharedResults[id]=null;sharedErrors[id]=(cause as Error).message;}}
        },120));
      }else if(!snapshot.result.candidate||snapshot.result.candidate.selection.kind==='scripture')drafts[id]=snapshot.result.candidate;
      // A shared result's workspace belongs to its producer, never the viewer.
    }
  }
  const examples=reactive<Record<string,any[]>>({});
  const exampleBusy=reactive<Record<string,boolean>>({});
  const captures=new Map<string,{stop:()=>void;heartbeat:number;abort:AbortController}>();
  const stopping=new Map<string,Promise<void>>();
  const prepareVersion=new Map<string,number>();
  const identity=useIdentityStore(),presence=usePresenceStore();
  watch(()=>shared.snapshot,applyShared,{deep:false});
  watch(()=>shared.session?.state,state=>{if(state==='finishing')for(const [id] of cloudSockets)if(listening[id]?.session?.id===shared.session?.id)void stopListening(id);});
  watch(()=>[identity.isAuthenticated,presence.owners] as const,()=>{
    for(const id of captures.keys())if(!identity.isAuthenticated||presence.controlledByOther(id))void stopListening(id);
  },{deep:true});
  subscribeWs(message=>{if(message.t==='worship-state'){const old=workspaces[message.channel];if(!old||message.workspace.revision>=old.revision)workspaces[message.channel]=message.workspace;}});
  subscribeWs(message=>{if(message.t==='library-updated')window.dispatchEvent(new Event('lumen:library-imported'));});
  subscribeWs(message=>{if(message.t==='data-cleared')window.dispatchEvent(new Event('lumen:data-cleared'));});
  window.addEventListener('lumen:data-cleared',()=>{
    for(const id of new Set([...Object.keys(drafts),...prepareVersion.keys()])) { prepareVersion.set(id,(prepareVersion.get(id)??0)+1); drafts[id]=null; preparing[id]=false; }
    for(const id of captures.keys())void stopListening(id,false);
    void refreshVersions().catch(()=>{});
  });
  async function load(id:string){subscribeTopics([id]);const state=await worshipRequest<WorshipWorkspace>(`/channels/${id}`);if(!workspaces[id]||state.revision>=workspaces[id].revision)workspaces[id]=state;await refreshVersions();}
  async function refreshVersions(){versions.value=await worshipRequest<BibleVersion[]>('/versions');}
  async function refreshAi(){aiStatus.value=await worshipRequest<ListeningStatus>('/listening/status');}
  async function selectListeningModel(modelId:string){aiStatus.value=await worshipRequest<ListeningStatus>('/listening/model',{method:'POST',body:JSON.stringify({modelId})});}
  async function prepare(id:string,selection:CueSelection){
    const version=(prepareVersion.get(id)??0)+1;prepareVersion.set(id,version);preparing[id]=true;
    try{
      const cue=await worshipRequest<LiveCue>('/preview',{method:'POST',body:JSON.stringify(selection)});
      if(prepareVersion.get(id)===version)drafts[id]=cue;
    }catch(error){
      // A failed current selection must never leave an older cue sendable.
      // Superseded failures/responses do not affect the newest preparation.
      if(prepareVersion.get(id)===version){drafts[id]=null;throw error;}
    }finally{if(prepareVersion.get(id)===version)preparing[id]=false;}
  }
  async function stopListening(id:string,notifyServer=true){
    const capture=captures.get(id),socket=cloudSockets.get(id),session=listening[id]?.session;
    capture?.stop();clearInterval(capture?.heartbeat);
    if(stopping.has(id)){if(!notifyServer){capture?.abort.abort();socket?.close();}await stopping.get(id);return;}
    const finish=notifyServer&&socket?.readyState===WebSocket.OPEN&&!!session;
    const request=(async()=>{
      if(finish){
        cloudDraining.add(id);let timeout:number|undefined;
        const closed=new Promise<void>(resolve=>socket.addEventListener('close',()=>resolve(),{once:true}));
        try{
          if(shared.session?.id===session.id)await fetch(`/api/listening/shared?session=${encodeURIComponent(session.id)}`,{method:'DELETE'});
          else socket.send(JSON.stringify({type:'stop'}));
          await Promise.race([closed,new Promise<void>(resolve=>{timeout=window.setTimeout(resolve,4000);})]);
        }catch{/* Closing below releases the source on connection failure. */}finally{clearTimeout(timeout);}
      }
      capture?.abort.abort();socket?.close();cloudSockets.delete(id);cloudDraining.delete(id);exampleBusy[id]=false;captures.delete(id);
      producerReleases.get(id)?.();producerReleases.delete(id);
      if(listening[id]){if(session?.provider==='assemblyai'&&sharedTargets.get(id)==='lyrics')listening[id].result=null;listening[id].session=null;listening[id].starting=false;listening[id].busy=false;listening[id].level=0;listening[id].peak=0;listening[id].clipping=false;}
      // Cancelled CONNECTING sockets may never reach the bridge. End their
      // captured lease by ID without touching a replacement session.
      if(notifyServer&&session?.provider==='assemblyai')await fetch(`/api/listening/shared?session=${encodeURIComponent(session.id)}`,{method:'DELETE'}).catch(()=>{});
      else if(notifyServer&&!socket)await worshipRequest(`/channels/${id}/listening`,{method:'DELETE'}).catch(()=>{});
    })();
    stopping.set(id,request);try{await request;}finally{if(stopping.get(id)===request)stopping.delete(id);}
  }
  async function command(id:string,command:WorshipCommand){
    if(saving[id])return;
    saving[id]=true;
    // Stepping live lyrics also moves the operator's prepared section. Supersede
    // an older preview request, but preserve a new selection made while waiting.
    const followLyrics=command.type==='step'&&workspaces[id]?.live?.selection.kind==='lyrics';
    const stepVersion=followLyrics?(prepareVersion.get(id)??0)+1:undefined;
    if(stepVersion!==undefined){prepareVersion.set(id,stepVersion);preparing[id]=false;}
    try{
      if(listening[id]?.session?.provider!=='assemblyai')await stopListening(id,false);
      const state=workspaces[id];
      const result=await worshipRequest<WorshipWorkspace>(`/channels/${id}/command`,{method:'POST',body:JSON.stringify({revision:state.revision,command})});
      if(result.revision>=(workspaces[id]?.revision??-1)){
        workspaces[id]=result;
        if(stepVersion!==undefined&&prepareVersion.get(id)===stepVersion&&result.live?.selection.kind==='lyrics')drafts[id]=result.live;
      }
    }
    catch(error){toast.error((error as Error).message);await load(id).catch(()=>{});throw error;}
    finally{saving[id]=false;}
  }
  async function take(id:string){if(preparing[id])return;const draft=drafts[id];if(draft)await command(id,{type:'take',selection:{...draft.selection}});}
  async function startListening(id:string,deviceId:string,mode:'assisted'|'automatic',commands:boolean,processing:ListeningProcessing='speech'){
    if(listeningControlsFor(id).provider==='assemblyai')return startCloudListening(id,deviceId,processing,mode);
    await stopping.get(id);
    if(captures.has(id))return;
    Object.assign(listeningControlsFor(id),{mode,commands});
    const view=reactive<ListeningView>({session:null,starting:true,busy:false,level:0,peak:0,clipping:false,inputInfo:null,result:null,error:''});listening[id]=view;
    let stopCapture:(()=>void)|undefined;
    const abort=new AbortController();let sequence=0;
    const capture={stop:()=>{stopCapture?.();},heartbeat:0,abort};captures.set(id,capture);
    try{
      // Capture permission is requested by the user's explicit Listen click.
      // No audio is sent until the authenticated station session is ready.
      // Startup windows are intentionally consumed during model warmup: the
      // listening session starts with current speech, not a stale startup queue.
      stopCapture=await captureListening(deviceId,(audio,level)=>{
        const current=listening[id];if(abort.signal.aborted||captures.get(id)!==capture||!current?.session)return;
        if(current.busy)return false;
        // Silence breaks partial reference context even though no WAV is sent.
        if(level<.003){sequence++;return;}
        current.busy=true;
        const session=current.session;
        return worshipRequest<ListeningResult>(`/channels/${id}/listening/audio?session=${session.id}&sequence=${sequence++}`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:audio,signal:abort.signal}).then(result=>{
          if(listening[id]?.session?.id!==session.id)return;
          current.result=result;current.error='';
          if(!workspaces[id]||result.workspace.revision>=workspaces[id].revision)workspaces[id]=result.workspace;
          if(result.candidate)drafts[id]=result.candidate;
        }).catch(error=>{
          if(abort.signal.aborted)return;
          // Continuing after a failed window silently loses speech and can
          // stitch a later verse number onto unrelated reference context.
          current.error=`Listening stopped because this audio could not be processed. ${error.message}`;
          void stopListening(id);toast.error('Listening stopped. Manual controls remain available.');
        }).finally(()=>{current.busy=false;});
      },()=>{
        if(captures.get(id)!==capture)return;
        view.error='The listening input disconnected. Reconnect it or choose another device, then start listening again.';
        void stopListening(id);
      },{
        signal:abort.signal,processing,
        onInfo:info=>{if(captures.get(id)===capture)view.inputInfo=info;},
        onLevels:levels=>{if(captures.get(id)!==capture)return;view.level=levels.rms;view.peak=levels.peak;view.clipping=levels.clipping;},
        onOverflow:()=>{
          if(captures.get(id)!==capture)return;
          view.error='Recognition could not keep up with the speaker. Listening stopped because audio arrived faster than it could be processed. Choose a faster model or reduce other work on this station, then start again.';
          void stopListening(id);
        },
      });
      if(abort.signal.aborted){stopCapture();return;}
      const session=await worshipRequest<ListeningSession>(`/channels/${id}/listening`,{method:'POST',body:JSON.stringify({mode,commands,language:'en'}),signal:abort.signal});
      if(abort.signal.aborted){stopCapture();return;}
      listening[id].session=session;listening[id].starting=false;
      const heartbeat=window.setInterval(()=>{void worshipRequest(`/channels/${id}/listening/heartbeat`,{method:'POST',body:JSON.stringify({sessionId:session.id}),signal:abort.signal}).catch(error=>{if(abort.signal.aborted||captures.get(id)!==capture)return;view.error=error.message;void stopListening(id,false);});},10000);
      capture.heartbeat=heartbeat;void refreshAi().catch(()=>{});
    }catch(error){stopCapture?.();if(captures.get(id)===capture)captures.delete(id);if(abort.signal.aborted)return;view.starting=false;view.error=listeningInputError(error);toast.error(view.error);}
  }
  async function startCloudListening(id:string,deviceId:string,processing:ListeningProcessing,mode:'assisted'|'automatic'){
    await stopping.get(id);if(captures.has(id))return;
    Object.assign(listeningControlsFor(id),{provider:'assemblyai',mode,commands:false});
    const view=reactive<ListeningView>({session:null,starting:true,busy:false,level:0,peak:0,clipping:false,inputInfo:null,result:null,error:''});listening[id]=view;
    const abort=new AbortController();let stopInput:(()=>void)|undefined,ready=false;
    const capture={stop:()=>stopInput?.(),heartbeat:0,abort};captures.set(id,capture);
    const fail=(message:string)=>{if(abort.signal.aborted)return;view.error=message;shared.reportError(message);void stopListening(id);};
    try {
      stopInput=await captureStreaming(deviceId,pcm=>{
        const socket=cloudSockets.get(id);if(!ready||abort.signal.aborted||!socket)return;
        if(socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>64000){fail('The network cannot keep up with microphone audio. Listening stopped.');return;}socket.send(pcm);
      },()=>fail('The microphone disconnected. Reconnect it and start listening again.'),{
        processing,signal:abort.signal,onInfo:info=>view.inputInfo=info,onLevels:levels=>{view.level=levels.rms;view.peak=levels.peak;view.clipping=levels.clipping;},
      });
      if(abort.signal.aborted){stopInput();return;}
      const session=await worshipRequest<ListeningSession>(`/channels/${id}/listening`,{method:'POST',body:JSON.stringify({provider:'assemblyai',mode,commands:false,language:'en'}),signal:abort.signal});
      if(abort.signal.aborted){stopInput();return;}view.session=session;
      producerReleases.set(id,shared.registerProducer(session.id,()=>stopListening(id)));shared.connect();void shared.refresh().catch(()=>{});
      const url=new URL('/worship/listening/stream',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('channel',id);url.searchParams.set('session',session.id);
      const socket=new WebSocket(url);cloudSockets.set(id,socket);
      const deadline=window.setTimeout(()=>fail('Streaming did not start. Check your internet connection and try again.'),20000);
      socket.onmessage=event=>{
        if(abort.signal.aborted||captures.get(id)!==capture)return;
        let message:any;try{message=JSON.parse(event.data);}catch{fail('The station returned an invalid streaming response.');return;}
        if(message.type==='ready'){clearTimeout(deadline);ready=true;view.starting=false;}
        else if(message.type==='finishing'){capture.stop();void stopListening(id);}
        else if(message.type==='result'){
          view.result=message.result;view.error='';if(sharedTargets.get(id)!=='lyrics')drafts[id]=message.result.candidate;
          if(message.result.workspace.revision>=(workspaces[id]?.revision??-1))workspaces[id]=message.result.workspace;
        }else if(message.type==='error')fail(message.message);
        else if(message.type==='example'){exampleBusy[id]=false;(examples[id]??=[]).unshift(message.example);examples[id]=examples[id].slice(0,20);}
        else if(message.type==='save-error'){exampleBusy[id]=false;toast.error(message.message);}
      };
      socket.onerror=()=>fail('The streaming connection failed. Check your connection and restart listening.');
      socket.onclose=()=>{clearTimeout(deadline);if(!abort.signal.aborted&&!cloudDraining.has(id))fail('Streaming disconnected. Listening stopped.');};
      abort.signal.addEventListener('abort',()=>{clearTimeout(deadline);socket.close();},{once:true});
    }catch(error){if(!abort.signal.aborted)fail(listeningInputError(error));else stopInput?.();}
  }
  async function refreshListeningExamples(id:string){examples[id]=await worshipRequest<any[]>(`/listening/examples?channel=${encodeURIComponent(id)}`);}
  function saveListeningExample(id:string){
    const socket=cloudSockets.get(id);if(socket?.readyState!==WebSocket.OPEN||exampleBusy[id])return;
    exampleBusy[id]=true;socket.send(JSON.stringify({type:'save-example'}));
  }
  async function reviewListeningExample(id:string,exampleId:string,review:unknown){
    const saved=await worshipRequest<any>(`/listening/examples/${exampleId}`,{method:'PATCH',body:JSON.stringify(review)});
    const index=examples[id]?.findIndex(e=>e.id===exampleId)??-1;if(index>=0)examples[id][index]=saved;return saved;
  }
  async function deleteListeningExample(id:string,exampleId:string){await worshipRequest(`/listening/examples/${exampleId}`,{method:'DELETE'});examples[id]=(examples[id]??[]).filter(e=>e.id!==exampleId);}
  window.addEventListener('beforeunload',()=>{for(const capture of captures.values())capture.stop();});
  return{followShared,sharedResults,sharedErrors,examples,exampleBusy,refreshListeningExamples,saveListeningExample,reviewListeningExample,deleteListeningExample,scripturePins,pinsBusy,refreshPins,savePin,workspaces,drafts,versions,aiStatus,saving,preparing,listening,listeningControlsFor,load,refreshVersions,refreshAi,selectListeningModel,prepare,command,take,startListening,stopListening};
});
