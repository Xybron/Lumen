import {computed,ref,watch} from 'vue';
import {defineStore} from 'pinia';
import {useIdentityStore} from './identity';
import type {SharedListeningSnapshot} from '../../../shared/listening';

const empty=():SharedListeningSnapshot=>({session:null,result:null,final:false,turn:-1});

/** Private session events contain text only; only the producer captures audio. */
export const useSharedListeningStore=defineStore('shared-listening',()=>{
  const identity=useIdentityStore(),snapshot=ref<SharedListeningSnapshot>(empty());
  const connected=ref(false),busy=ref(false),error=ref(''),notice=ref('');
  const session=computed(()=>snapshot.value.session);
  let events:EventSource|undefined,generation=0,eventRevision=0,refreshId=0;
  const producers=new Map<string,()=>Promise<void>>();
  function reportError(message:string){notice.value=message;}
  function dismissError(){notice.value='';}
  function registerProducer(id:string,stop:()=>Promise<void>){
    producers.set(id,stop);
    return()=>{if(producers.get(id)===stop)producers.delete(id);};
  }
  function disconnect(){generation++;eventRevision++;refreshId++;events?.close();events=undefined;connected.value=false;snapshot.value=empty();}
  function connect(){
    if(events||!identity.isAuthenticated)return;
    const source=new EventSource('/api/listening/shared/events');events=source;
    source.onopen=()=>{if(events===source){connected.value=true;error.value='';}};
    source.onmessage=event=>{
      if(events!==source)return;
      try{const value=JSON.parse(event.data) as SharedListeningSnapshot;if(!('session'in value))return;eventRevision++;if(value.session&&value.session.id!==snapshot.value.session?.id)notice.value='';snapshot.value=value;connected.value=true;error.value='';}catch{error.value='The listening status could not be read.';}
    };
    source.onerror=()=>{if(events===source){connected.value=false;error.value='Reconnecting to shared listening…';}};
  }
  async function refresh(){
    if(!identity.isAuthenticated)return;
    const current=generation,revision=eventRevision,id=++refreshId;
    const response=await fetch('/api/listening/shared',{cache:'no-store'});
    if(!response.ok)throw new Error('The shared listening session is unavailable.');
    const value=await response.json();if(current===generation&&revision===eventRevision&&id===refreshId)snapshot.value=value;
    connect();
  }
  async function stop(){
    const current=session.value;if(!current||busy.value||current.ownerId!==identity.me?.id)return;
    busy.value=true;error.value='';
    try{
      const producer=producers.get(current.id);
      if(producer)await producer();
      else{
        const response=await fetch(`/api/listening/shared?session=${encodeURIComponent(current.id)}`,{method:'DELETE'});
        if(!response.ok){const value=await response.json();throw new Error(value.error||'Could not stop listening.');}
      }
      await refresh();
    }catch(cause){error.value=(cause as Error).message;}
    finally{busy.value=false;}
  }
  watch(()=>identity.me?.id,()=>{disconnect();error.value='';notice.value='';if(identity.isAuthenticated)connect();},{immediate:true});
  return{snapshot,session,connected,busy,error,notice,reportError,dismissError,connect,disconnect,refresh,stop,registerProducer};
});
