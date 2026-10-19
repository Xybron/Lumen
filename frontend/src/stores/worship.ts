import { ref, reactive, watch } from 'vue';
import { defineStore } from 'pinia';
import { toast } from 'vue-sonner';
import { subscribeTopics, subscribeWs } from '@/lib/ws';
import { worshipRequest, WorshipRequestError } from '@/lib/worship/api';
import { captureListening,listeningInputError,type ListeningInputInfo,type ListeningProcessing } from '@/lib/worship/audio';
import { useIdentityStore } from './identity';
import { usePresenceStore } from './presence';
import type { BibleVersion, WorshipWorkspace, WorshipCommand, CueSelection, LiveCue, ListeningStatus, ListeningSession, ListeningResult } from '../../../shared/worship';

interface ListeningView { session:ListeningSession|null; starting:boolean; busy:boolean; level:number; peak:number; clipping:boolean; inputInfo:ListeningInputInfo|null; result:ListeningResult|null; error:string }
interface ListeningControls { mode:'assisted'|'automatic'; commands:boolean }
export const useWorshipStore=defineStore('worship',()=>{
  const workspaces=reactive<Record<string,WorshipWorkspace>>({}),drafts=reactive<Record<string,LiveCue|null>>({});
  const versions=ref<BibleVersion[]>([]),aiStatus=ref<ListeningStatus|null>(null),saving=reactive<Record<string,boolean>>({}),preparing=reactive<Record<string,boolean>>({});
  const listening=reactive<Record<string,ListeningView>>({});
  // Channel panels unmount when entering Studio. Keep their controls beside
  // the capture/session, in memory only: a reload must not restore auto mode.
  const listeningControls=reactive<Record<string,ListeningControls>>({});
  function listeningControlsFor(id:string){
    if(!listeningControls[id])listeningControls[id]={mode:'assisted',commands:false};
    return listeningControls[id];
  }
  const captures=new Map<string,{stop:()=>void;heartbeat:number;abort:AbortController}>();
  const stopping=new Map<string,Promise<void>>();
  const prepareVersion=new Map<string,number>();
  const identity=useIdentityStore(),presence=usePresenceStore();
  watch(()=>[identity.isAuthenticated,presence.owners] as const,()=>{
    for(const id of captures.keys())if(!identity.isAuthenticated||presence.controlledByOther(id))void stopListening(id);
  },{deep:true});
  subscribeWs(message=>{if(message.t==='worship-state'){const old=workspaces[message.channel];if(!old||message.workspace.revision>=old.revision)workspaces[message.channel]=message.workspace;}});
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
    const capture=captures.get(id);capture?.stop();capture?.abort.abort();clearInterval(capture?.heartbeat);captures.delete(id);
    if(listening[id]){listening[id].session=null;listening[id].starting=false;listening[id].busy=false;listening[id].level=0;listening[id].peak=0;listening[id].clipping=false;}
    if(!notifyServer){await stopping.get(id);return;}
    if(stopping.has(id)){await stopping.get(id);return;}
    const request=worshipRequest(`/channels/${id}/listening`,{method:'DELETE'}).then(()=>{},()=>{});
    stopping.set(id,request);
    try{await request;}finally{if(stopping.get(id)===request)stopping.delete(id);}
  }
  async function command(id:string,command:WorshipCommand){
    if(saving[id])return;
    saving[id]=true;
    try{await stopListening(id,false);const state=workspaces[id];const result=await worshipRequest<WorshipWorkspace>(`/channels/${id}/command`,{method:'POST',body:JSON.stringify({revision:state.revision,command})});if(result.revision>=(workspaces[id]?.revision??-1))workspaces[id]=result;}
    catch(error){toast.error((error as Error).message);await load(id).catch(()=>{});throw error;}
    finally{saving[id]=false;}
  }
  async function take(id:string){if(preparing[id])return;const draft=drafts[id];if(draft)await command(id,{type:'take',selection:{...draft.selection}});}
  async function startListening(id:string,deviceId:string,mode:'assisted'|'automatic',commands:boolean,processing:ListeningProcessing='speech'){
    await stopping.get(id);
    if(captures.has(id))return;
    Object.assign(listeningControlsFor(id),{mode,commands});
    const view=reactive<ListeningView>({session:null,starting:true,busy:false,level:0,peak:0,clipping:false,inputInfo:null,result:null,error:''});listening[id]=view;
    let stopCapture:(()=>void)|undefined;
    const abort=new AbortController();let sequence=0,failures=0;
    const capture={stop:()=>{stopCapture?.();},heartbeat:0,abort};captures.set(id,capture);
    try{
      // Capture permission is requested by the user's explicit Listen click.
      // No audio is sent until the authenticated station session is ready.
      stopCapture=await captureListening(deviceId,(audio,level)=>{
        const current=listening[id];if(abort.signal.aborted||captures.get(id)!==capture||!current?.session)return;
        if(current.busy||level<.003)return;
        current.busy=true;
        const session=current.session;
        void worshipRequest<ListeningResult>(`/channels/${id}/listening/audio?session=${session.id}&sequence=${sequence++}`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:audio,signal:abort.signal}).then(result=>{
          if(listening[id]?.session?.id!==session.id)return;
          current.result=result;current.error='';failures=0;
          if(!workspaces[id]||result.workspace.revision>=workspaces[id].revision)workspaces[id]=result.workspace;
          if(result.candidate)drafts[id]=result.candidate;
        }).catch(error=>{
          if(abort.signal.aborted)return;
          current.error=error.message;
          if(error instanceof WorshipRequestError&&error.status===429)return;
          if(++failures>=3 || error.status===409 || error.status===403){void stopListening(id);toast.error('Listening stopped. Manual controls remain available.');}
        }).finally(()=>{current.busy=false;});
      },()=>{
        if(captures.get(id)!==capture)return;
        view.error='The listening input disconnected. Reconnect it or choose another device, then start listening again.';
        void stopListening(id);
      },{
        signal:abort.signal,processing,
        onInfo:info=>{if(captures.get(id)===capture)view.inputInfo=info;},
        onLevels:levels=>{if(captures.get(id)!==capture)return;view.level=levels.rms;view.peak=levels.peak;view.clipping=levels.clipping;},
      });
      if(abort.signal.aborted){stopCapture();return;}
      const session=await worshipRequest<ListeningSession>(`/channels/${id}/listening`,{method:'POST',body:JSON.stringify({mode,commands,language:'en'}),signal:abort.signal});
      if(abort.signal.aborted){stopCapture();return;}
      listening[id].session=session;listening[id].starting=false;
      const heartbeat=window.setInterval(()=>{void worshipRequest(`/channels/${id}/listening/heartbeat`,{method:'POST',body:JSON.stringify({sessionId:session.id}),signal:abort.signal}).catch(error=>{if(abort.signal.aborted||captures.get(id)!==capture)return;view.error=error.message;void stopListening(id,false);});},10000);
      capture.heartbeat=heartbeat;void refreshAi().catch(()=>{});
    }catch(error){stopCapture?.();if(captures.get(id)===capture)captures.delete(id);if(abort.signal.aborted)return;view.starting=false;view.error=listeningInputError(error);toast.error(view.error);}
  }
  window.addEventListener('beforeunload',()=>{for(const capture of captures.values())capture.stop();});
  return{workspaces,drafts,versions,aiStatus,saving,preparing,listening,listeningControlsFor,load,refreshVersions,refreshAi,selectListeningModel,prepare,command,take,startListening,stopListening};
});
