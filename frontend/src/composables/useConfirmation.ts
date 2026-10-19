import { getCurrentScope,onScopeDispose,readonly,shallowRef } from 'vue';

export interface ConfirmationOptions {
  title:string;
  description:string;
  confirmLabel:string;
  cancelLabel?:string;
  tone?:'default'|'danger'|'live';
  details?:string[];
  note?:string;
}
interface ConfirmationRequest extends ConfirmationOptions { id:number; returnFocus:HTMLElement|null }
const current=shallowRef<ConfirmationRequest|null>(null);
export const currentConfirmation=readonly(current);
let sequence=0,finish:((accepted:boolean)=>void)|undefined;

export function settleConfirmation(id:number,accepted=false){
  if(current.value?.id!==id)return;
  const resolve=finish;finish=undefined;current.value=null;resolve?.(accepted);
}

function requestConfirmation(options:ConfirmationOptions,signal:AbortSignal):Promise<boolean>{
  // Never queue a second destructive/live action behind a dialog the operator
  // has not seen yet. A departed requester cannot leave a latent confirmation.
  if(signal.aborted||current.value)return Promise.resolve(false);
  const element=typeof document==='undefined'?null:document.activeElement;
  const active=typeof HTMLElement!=='undefined'&&element instanceof HTMLElement?element:null;
  const menu=active?.closest('[role="menu"]'),triggerId=menu?.getAttribute('aria-labelledby');
  const returnFocus=(triggerId?document.getElementById(triggerId):null)??active;
  const id=++sequence;
  return new Promise(resolve=>{
    const cancel=()=>settleConfirmation(id,false);
    finish=accepted=>{signal.removeEventListener('abort',cancel);resolve(accepted);};
    signal.addEventListener('abort',cancel,{once:true});
    current.value={...options,details:options.details?[...options.details]:undefined,id,returnFocus};
  });
}

export function useConfirmation(){
  const requests=new Set<AbortController>();let disposed=false;
  if(getCurrentScope())onScopeDispose(()=>{disposed=true;for(const request of requests)request.abort();requests.clear();});
  async function confirmAction(options:ConfirmationOptions){
    if(disposed)return false;
    const request=new AbortController();requests.add(request);
    try{return await requestConfirmation(options,request.signal);}finally{requests.delete(request);}
  }
  return {confirmAction};
}
