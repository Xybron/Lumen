<script setup lang="ts">
import SegmentedMeter from '@/components/audio/SegmentedMeter.vue';
import { computed,nextTick,onBeforeUnmount,ref,watch } from 'vue';
import { Trash2,Copy,Mic,Square,Check,AudioLines,Link,Unlink,NotebookPen,Monitor,ChevronLeft,ChevronRight,SlidersHorizontal,ArrowDownToLine,AlignLeft,AlignCenter,AlignRight,Image,Palette,ChevronDown,Quote,List,Type,Layers,LoaderCircle } from 'lucide-vue-next';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import PreviewSurface from '@/components/dashboard/PreviewSurface.vue';
import MediaImagePicker from '@/components/media/MediaImagePicker.vue';
import { mediaAssetReference,type MediaLibraryAsset } from '@/lib/media-library';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { useSharedListeningStore } from '@/stores/shared-listening';
import { useNotesListeningStore } from '@/stores/notes-listening';
import { useConfirmation } from '@/composables/useConfirmation';
import { useListeningInput } from '@/composables/useListeningInput';
import { captureListening,listeningInputError } from '@/lib/worship/audio';
import { openNotesProgramAudio } from '@/lib/notes-program-audio';
import { shortId } from '@/lib/ids';
import type { Channel,Item } from '@/types';
import type { NotesDocument,NotesDraft,NotesListeningSession,NotesSegment } from '../../../../shared/notes';
import type { ListeningStatus } from '../../../../shared/worship';

const props=defineProps<{open:boolean;channel:Channel|null;item:Item|null;series:Item[];commit:(items:Item[])=>Promise<boolean>}>();
const {confirmAction}=useConfirmation();
const clearing=ref(false),clearedThrough=ref(0);
const emit=defineEmits<{'update:open':[value:boolean]}>();
const identity=useIdentityStore(),presence=usePresenceStore(),shared=useSharedListeningStore(),producer=useNotesListeningStore();
const {devices,deviceId,processing,refreshDevices,missing,canUse,selectedLabel,syncCaptureInfo,error:inputError}=useListeningInput();
const privateDocument=ref<NotesDocument|null>(null),loading=ref(false),saving=ref(false),error=ref(''),notice=ref('');
const draft=ref<NotesDraft>({title:'',body:'',reference:'',layout:'key-points'}),savedDraft=ref('');
const source=ref<'microphone'|'program'>('microphone'),starting=ref(false),session=ref<NotesListeningSession|null>(null),level=ref(0),busy=ref(false);
const provider=ref<'local'|'assemblyai'>('assemblyai'),transcriptVisible=ref(false),linkBusy=ref(false),linkSessionId=ref<string|null>(null),afterTurn=ref(-1);
const model=ref<ListeningStatus|null>(null),selectedText=ref(''),transcriptElement=ref<HTMLTextAreaElement|null>(null);
const previewIndex=ref(0),updating=ref(false),lastApplied=ref(''),audioSettings=ref(false),styleOpen=ref(true),imagePickerOpen=ref(false);
const mobilePane=ref<'write'|'preview'|'transcript'>('write'),bodyElement=ref<HTMLTextAreaElement|null>(null);
const allocatedIds:string[]=[];let bodyCursor:number|null=null,hydrating=false,autosaveTimer:ReturnType<typeof setTimeout>|undefined,saveTask:Promise<boolean>|undefined;
const layouts=[{value:'key-points',label:'Key points',icon:List},{value:'statement',label:'Statement',icon:Type},{value:'quote',label:'Quote',icon:Quote},{value:'general',label:'General',icon:Layers}] as const;
const themes=[
  {name:'Midnight',color:'#172438',gradient:'linear-gradient(135deg, #182b45 0%, #0b111e 100%)'},
  {name:'Royal',color:'#312e81',gradient:'linear-gradient(135deg, #37306b 0%, #161428 100%)'},
  {name:'Emerald',color:'#064e3b',gradient:''},
  {name:'Burgundy',color:'#5b213d',gradient:'linear-gradient(135deg, #64233e 0%, #25141e 100%)'},
  {name:'Slate',color:'#29313c',gradient:''},
  {name:'Black',color:'#101113',gradient:''},
] as const;
const grouping=computed({get:()=>draft.value.grouping??'single',set:(value:'single'|'pointers')=>{draft.value.grouping=value;}});
const lines=computed(()=>grouping.value==='pointers'?draft.value.body.split(/\r?\n/).map(line=>line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/,'').trim()).filter(Boolean):[draft.value.body.trim()]);
const previewItems=computed<Item[]>(()=>{
  if(!props.item)return [];
  return (lines.value.length?lines.value:['']).slice(0,100).map((body,index)=>({...props.item!,
    id:index===0?props.item!.id:props.series[index]?.id??(allocatedIds[index]??=shortId('item')),
    type:'notes',title:draft.value.title.trim(),body,reference:draft.value.reference.trim(),
    layout:grouping.value==='pointers'?'statement':draft.value.layout,
    background:draft.value.background,typography:draft.value.typography,
  }));
});
const previewItem=computed(()=>previewItems.value[previewIndex.value]??previewItems.value[0]);
const thumbnails=computed(()=>{const start=Math.max(0,Math.min(previewIndex.value-3,previewItems.value.length-7));return previewItems.value.slice(start,start+7).map((item,index)=>({item,index:start+index}));});
function publicationSignature(items:Item[]){return JSON.stringify(items.map(({id,title,body,reference,layout,background,typography})=>({id,title:title??'',body:body??'',reference:reference??'',layout,background,typography})));}
const changesToApply=computed(()=>publicationSignature(previewItems.value)!==lastApplied.value);
const canUpdate=computed(()=>canEdit.value&&!updating.value&&!!draft.value.body.trim()&&lines.value.length<=100&&changesToApply.value);
const textSize=computed({get:()=>draft.value.typography?.size??'lg',set:(size:NonNullable<Item['typography']>['size'])=>{draft.value.typography={...draft.value.typography,size};}});
const textAlign=computed(()=>draft.value.typography?.align??(previewItem.value?.layout==='key-points'?'left':'center'));
const backgroundName=computed(()=>draft.value.background?.kind==='image'?'Image background':draft.value.background?.kind==='video'?'Video background':themes.find(theme=>isTheme(theme))?.name??'Custom background');
const endpoint=computed(()=>props.channel&&props.item?`/api/notes/channels/${encodeURIComponent(props.channel.id)}/items/${encodeURIComponent(props.item.id)}`:'');
const canEdit=computed(()=>!!props.channel&&identity.can(props.channel.id,'author')&&!presence.controlledByOther(props.channel.id));
const active=computed(()=>starting.value||!!session.value);
const linked=computed(()=>!!linkSessionId.value&&shared.session?.id===linkSessionId.value);
const showTranscript=computed(()=>transcriptVisible.value);
const transcript=computed(()=>privateDocument.value?.segments.map(segment=>segment.text).join('\n\n')??'');
const uncertain=computed(()=>privateDocument.value?.segments.filter(segment=>segment.uncertain).length??0);
const dirty=computed(()=>JSON.stringify(draft.value)!==savedDraft.value);
const modelReady=computed(()=>provider.value==='assemblyai'?!!model.value?.assemblyai?.available:!!model.value&&model.value.state!=='unavailable');
const liveResult=computed(()=>linked.value&&shared.snapshot.turn>afterTurn.value?shared.snapshot.result:null);
const interim=computed(()=>liveResult.value&&!shared.snapshot.final?liveResult.value.transcript:'');
const scripture=computed(()=>liveResult.value?.candidate?.selection.kind==='scripture'?liveResult.value.candidate:null);
const ownProducer=computed(()=>producer.channelId===props.channel?.id);
const inputLevel=computed(()=>active.value?level.value:ownProducer.value?producer.level:0);
let generation=0,loadAbort:AbortController|undefined,captureAbort:AbortController|undefined,stopCapture:(()=>void)|undefined,closeProgram:(()=>void)|undefined,heartbeat:number|undefined,sessionEndpoint='';
let linkRequest=0,refreshQueued=false,refreshingLink=false;
interface LinkState {clearedThrough?:number;linked:boolean;sessionId:string|null;afterTurn?:number;segments:NotesSegment[]}
async function request<T>(url:string,options:RequestInit={}):Promise<T> {
  const response=await fetch(url,{...options,headers:{...(options.body instanceof Blob?{}:{'Content-Type':'application/json'}),...options.headers}});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'The station could not save these notes.');return value;
}
function applyClear(through=0){
  clearedThrough.value=Math.max(clearedThrough.value,through);
  if(privateDocument.value)privateDocument.value.segments=privateDocument.value.segments.filter(segment=>segment.id>clearedThrough.value);
}
async function clearTranscript(){
  if(!canEdit.value||clearing.value||!privateDocument.value?.segments.length)return;
  const sequence=generation,path=endpoint.value,throughId=privateDocument.value.segments.at(-1)!.id;
  if(!await confirmAction({title:'Clear transcript?',description:'Remove the captured phrases from this note. Your written notes and slides stay unchanged. Linked listening will keep adding new speech.',confirmLabel:'Clear transcript',tone:'danger'}))return;
  if(sequence!==generation)return;
  clearing.value=true;++linkRequest;
  try{
    const result=await request<LinkState>(`${path}/transcript`,{method:'DELETE',body:JSON.stringify({throughId})});
    if(sequence!==generation)return;
    applyClear(result.clearedThrough);appendSegments(result.segments);selectedText.value='';notice.value='Transcript cleared';
  }catch(cause){if(sequence===generation)error.value=(cause as Error).message;}
  finally{if(sequence===generation){clearing.value=false;void refreshLink();}}
}
function appendSegments(segments:NotesSegment[]){
  if(!privateDocument.value||!segments.length)return;
  const byId=new Map(privateDocument.value.segments.map(segment=>[segment.id,segment]));for(const segment of segments.filter(segment=>segment.id>clearedThrough.value))byId.set(segment.id,segment);
  privateDocument.value={...privateDocument.value,segments:[...byId.values()].sort((a,b)=>a.id-b.id)};
}
async function refreshLink(){
  if(!props.open||!privateDocument.value||!canEdit.value)return;
  if(refreshingLink){refreshQueued=true;return;}
  const sequence=generation,path=endpoint.value,requestId=linkRequest;refreshingLink=true;
  try{
    const last=privateDocument.value.segments.at(-1)?.id??0;
    const state=await request<LinkState>(`${path}/listening/link?after=${last}`);
    if(sequence!==generation||requestId!==linkRequest)return;
    linkSessionId.value=state.linked?state.sessionId:null;afterTurn.value=state.afterTurn??-1;
    if(state.linked&&loading.value)transcriptVisible.value=true;
    applyClear(state.clearedThrough);appendSegments(state.segments);
  }catch(cause){if(sequence===generation&&requestId===linkRequest)error.value=(cause as Error).message;}
  finally{refreshingLink=false;if(refreshQueued){refreshQueued=false;void refreshLink();}}
}
async function linkTranscript(){
  const current=shared.session;if(!current||!canEdit.value||linkBusy.value)return;
  const sequence=generation,path=endpoint.value;linkBusy.value=true;error.value='';++linkRequest;
  try{
    await request(`${path}/listening/link`,{method:'POST',body:JSON.stringify({sessionId:current.id})});
    if(sequence!==generation)return;transcriptVisible.value=true;await refreshLink();notice.value='Linked. New completed phrases append here; earlier speech is not copied.';
  }catch(cause){if(sequence===generation)error.value=(cause as Error).message;}
  finally{if(sequence===generation)linkBusy.value=false;}
}
async function unlinkTranscript(){
  if(!canEdit.value||linkBusy.value)return;
  const sequence=generation,path=endpoint.value;linkBusy.value=true;error.value='';++linkRequest;
  try{
    await request(`${path}/listening/link`,{method:'DELETE'});
    if(sequence!==generation)return;linkSessionId.value=null;await refreshLink();notice.value='Transcript unlinked. Shared listening continues; saved passages remain here.';
  }catch(cause){if(sequence===generation)error.value=(cause as Error).message;}
  finally{if(sequence===generation)linkBusy.value=false;}
}
async function stopListening(){
  const current=session.value,path=sessionEndpoint;
  captureAbort?.abort();captureAbort=undefined;stopCapture?.();stopCapture=undefined;closeProgram?.();closeProgram=undefined;clearInterval(heartbeat);heartbeat=undefined;
  session.value=null;starting.value=false;busy.value=false;level.value=0;
  if(current&&path)await request(`${path}/listening?session=${encodeURIComponent(current.id)}`,{method:'DELETE'}).catch(()=>{});
}
async function load(){
  clearTimeout(autosaveTimer);hydrating=true;saving.value=false;updating.value=false;saveTask=undefined;bodyCursor=null;allocatedIds.length=0;previewIndex.value=0;mobilePane.value='write';audioSettings.value=false;imagePickerOpen.value=false;
  const sequence=++generation;++linkRequest;loadAbort?.abort();loadAbort=new AbortController();void stopListening();
  privateDocument.value=null;clearing.value=false;clearedThrough.value=0;selectedText.value='';error.value='';notice.value='';linkSessionId.value=null;transcriptVisible.value=false;linkBusy.value=false;
  if(!props.open||!endpoint.value||!canEdit.value){hydrating=false;return;}
  loading.value=true;const path=endpoint.value;
  try{
    const [document,status]=await Promise.all([request<NotesDocument>(path,{signal:loadAbort.signal}),request<ListeningStatus>('/api/worship/listening/status',{signal:loadAbort.signal}).catch(()=>null),shared.refresh()]);
    if(sequence!==generation)return;
    privateDocument.value=document;applyClear(document.clearedThrough);
    draft.value=JSON.parse(JSON.stringify({...document.draft,grouping:document.draft.grouping??(props.series.length>1?'pointers':'single'),background:document.draft.background??props.item?.background,typography:document.draft.typography??props.item?.typography}));
    savedDraft.value=JSON.stringify(draft.value);lastApplied.value=publicationSignature(props.series.length?props.series:props.item?[props.item]:[]);model.value=status;await refreshLink();
  }catch(cause){if(sequence===generation&&!loadAbort.signal.aborted)error.value=(cause as Error).message;}
  finally{if(sequence===generation){loading.value=false;hydrating=false;}}
}
async function saveDraft(){
  clearTimeout(autosaveTimer);
  if(saveTask){if(!await saveTask)return false;return saveDraft();}
  if(!privateDocument.value||!canEdit.value)return false;
  if(!dirty.value)return true;
  const sequence=generation,path=endpoint.value,snapshot=JSON.parse(JSON.stringify(draft.value)) as NotesDraft,revision=privateDocument.value.revision;saving.value=true;error.value='';
  const task=(async()=>{
    try{
      const document=await request<NotesDocument>(`${path}?transcript=omit`,{method:'PUT',body:JSON.stringify({revision,draft:snapshot})});
      if(sequence!==generation)return false;
      privateDocument.value={...document,segments:(privateDocument.value?.segments.length??0)>document.segments.length?privateDocument.value!.segments:document.segments};
      applyClear(document.clearedThrough);savedDraft.value=JSON.stringify(snapshot);return true;
    }catch(cause){if(sequence===generation)error.value=(cause as Error).message;return false;}
    finally{if(sequence===generation)saving.value=false;}
  })();
  saveTask=task;const result=await task;if(saveTask===task)saveTask=undefined;return result;
}
async function flushDraft(){while(dirty.value||saveTask){if(!await saveDraft())return false;}return true;}
async function setOpen(value:boolean){
  if(value){emit('update:open',true);return;}
  if(updating.value)return;
  if(privateDocument.value&&canEdit.value&&!await flushDraft())return;
  await stopListening();emit('update:open',false);
}
async function startListening(){
  if(active.value||shared.session||producer.active||!canEdit.value||!modelReady.value||source.value==='microphone'&&(!canUse.value||missing.value))return;
  error.value='';notice.value='';transcriptVisible.value=true;
  if(provider.value==='assemblyai'){
    const sequence=generation;
    await producer.start({channelId:props.channel!.id,itemId:props.item!.id,deviceId:deviceId.value,processing:processing.value,source:source.value});
    if(sequence!==generation)return;
    if(producer.error)error.value=producer.error;await shared.refresh();await refreshLink();return;
  }
  const path=endpoint.value,sequence=generation,abort=new AbortController();captureAbort=abort;sessionEndpoint=path;starting.value=true;
  const valid=()=>sequence===generation&&!abort.signal.aborted&&captureAbort===abort;
  const fail=(message:string)=>{if(!valid())return;error.value=message;void stopListening();};
  const ended=()=>fail('The selected audio input disconnected. Start listening again when it is ready.');
  try{
    const lease=await request<NotesListeningSession>(`${path}/listening`,{method:'POST',body:JSON.stringify({provider:'local'}),signal:abort.signal});
    if(!valid()){void request(`${path}/listening?session=${lease.id}`,{method:'DELETE'}).catch(()=>{});return;}
    session.value=lease;let windowSequence=0;
    heartbeat=window.setInterval(()=>void request(`${path}/listening/heartbeat`,{method:'POST',body:JSON.stringify({sessionId:lease.id}),signal:abort.signal}).catch(cause=>fail((cause as Error).message)),10000);
    let stream:MediaStream|undefined;
    if(source.value==='program'){const input=await openNotesProgramAudio(abort.signal,ended);if(!valid()){input.close();return;}stream=input.stream;closeProgram=input.close;}
    const stop=await captureListening(deviceId.value,audio=>{
      if(!valid())return;busy.value=true;
      return request<NotesDocument>(`${path}/listening/audio?session=${lease.id}&sequence=${windowSequence++}`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:audio,signal:abort.signal}).then(document=>{if(valid())appendSegments(document.segments);}).catch(cause=>fail(`Listening stopped. ${(cause as Error).message}`)).finally(()=>{if(valid())busy.value=false;});
    },ended,{signal:abort.signal,stream,processing:stream?'mixer':processing.value,onInfo:info=>{if(valid()&&!stream)syncCaptureInfo(info);},onLevels:value=>{if(valid())level.value=value.rms;},onOverflow:()=>fail('Recognition could not keep up. Choose a faster local model or reduce other work before restarting.')});
    if(!valid()){stop();return;}stopCapture=stop;starting.value=false;
  }catch(cause){if(valid()){error.value=listeningInputError(cause);await stopListening();}}
}
function useReference(){if(!scripture.value||!canEdit.value)return;draft.value.reference=scripture.value.reference;notice.value='Reference added to your draft.';}
function selectTranscript(){const area=transcriptElement.value;selectedText.value=area?transcript.value.slice(area.selectionStart,area.selectionEnd).trim():'';}
function rememberCursor(){bodyCursor=bodyElement.value?.selectionEnd??null;}
async function useSelection(){
  if(!selectedText.value||!canEdit.value)return;
  const body=draft.value.body,index=Math.min(bodyCursor??body.length,body.length),before=body.slice(0,index),after=body.slice(index);
  const inserted=(before&&!/\n$/.test(before)?'\n':'')+selectedText.value+(after&&!/^\n/.test(after)?'\n':'');
  if(body.length+inserted.length>20000){error.value='This note is full. Select a shorter passage or start another note.';return;}
  draft.value.body=before+inserted+after;bodyCursor=index+inserted.length;selectedText.value='';mobilePane.value='write';notice.value='Selection inserted into your notes.';
  await nextTick();bodyElement.value?.focus();bodyElement.value?.setSelectionRange(bodyCursor,bodyCursor);
}
async function copyTranscript(){try{await navigator.clipboard.writeText(transcript.value);notice.value='Transcript copied';}catch{transcriptElement.value?.focus();transcriptElement.value?.select();notice.value='Select and copy the transcript with your keyboard.';}}
async function updateSlides(){
  if(!canUpdate.value)return;
  const sequence=generation,items=JSON.parse(JSON.stringify(previewItems.value)) as Item[],signature=publicationSignature(items);
  updating.value=true;error.value='';notice.value='';
  try{
    if(!await flushDraft()||sequence!==generation||!canEdit.value)return;
    if(await props.commit(items)){if(sequence===generation){lastApplied.value=signature;notice.value=items.length>1?`${items.length} slides updated`:'Slide updated';}}
    else if(sequence===generation)error.value='Slides could not be updated. Your draft is saved; try again.';
  }catch(cause){if(sequence===generation)error.value=(cause as Error).message;}
  finally{if(sequence===generation)updating.value=false;}
}
function onKeydown(event:KeyboardEvent){if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();void updateSlides();}}
function toggleTranscript(){transcriptVisible.value=!transcriptVisible.value;if(transcriptVisible.value)mobilePane.value='transcript';else if(mobilePane.value==='transcript')mobilePane.value='write';}
function isTheme(theme:typeof themes[number]){return theme.gradient?draft.value.background?.kind==='gradient'&&draft.value.background.gradient===theme.gradient:draft.value.background?.kind==='color'&&draft.value.background.color===theme.color;}
function useTheme(theme:typeof themes[number]){draft.value.background=theme.gradient?{kind:'gradient',gradient:theme.gradient,overlayOpacity:0}:{kind:'color',color:theme.color,overlayOpacity:0};}
function setAlignment(align:'left'|'center'|'right'){draft.value.typography={...draft.value.typography,align};}
function chooseImage(asset:MediaLibraryAsset){if(asset.kind!=='image'||asset.origin!=='library'||!canEdit.value)return;draft.value.background={kind:'image',src:mediaAssetReference(asset,true),fit:'cover',overlayOpacity:.35};}
watch(()=>[shared.snapshot.session?.id,shared.snapshot.session?.linkedNotes,shared.snapshot.final,shared.snapshot.turn],()=>{if(props.open&&privateDocument.value)void refreshLink();});
watch(()=>producer.inputInfo,info=>{if(info&&ownProducer.value)syncCaptureInfo(info);});
watch(()=>producer.error,message=>{if(message&&props.open&&ownProducer.value)error.value=message;});
watch(draft,()=>{if(hydrating||!privateDocument.value||!canEdit.value)return;notice.value='';clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>void saveDraft(),650);},{deep:true,flush:'sync'});
watch(()=>previewItems.value.length,length=>{previewIndex.value=Math.max(0,Math.min(previewIndex.value,length-1));});
watch([()=>props.open,()=>props.channel?.id,()=>props.item?.id],()=>void load(),{immediate:true});
watch(()=>[identity.me?.id,canEdit.value] as const,([userId,allowed],[previousUser])=>{if(props.open&&(!allowed||userId!==previousUser)){++generation;++linkRequest;loadAbort?.abort();void stopListening();privateDocument.value=null;draft.value={title:'',body:'',reference:'',layout:'key-points'};savedDraft.value=JSON.stringify(draft.value);emit('update:open',false);}});
onBeforeUnmount(()=>{clearTimeout(autosaveTimer);++generation;++linkRequest;loadAbort?.abort();void stopListening();});
</script>

<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent class="notes-workspace-dialog" @keydown.stop="onKeydown">
      <DialogHeader class="notes-header">
        <div class="notes-heading-icon"><NotebookPen :size="20" /></div>
        <div class="notes-heading-copy"><DialogTitle>Notes workspace</DialogTitle><DialogDescription>Capture the thought. See the slide. Keep moving.</DialogDescription></div>
        <div class="notes-header-actions">
          <span class="notes-save-state" role="status"><LoaderCircle v-if="saving" :size="12" class="notes-spin" /><Check v-else-if="!dirty" :size="12" />{{saving?'Saving draft…':dirty?'Unsaved draft':'Draft saved'}}</span>
          <button class="notes-transcript-toggle" :aria-pressed="showTranscript" :aria-label="showTranscript?'Hide transcript':'Show transcript'" @click="toggleTranscript"><AudioLines :size="15" /><span>Transcript</span><i v-if="linked" class="notes-live-dot" /></button>
        </div>
      </DialogHeader>
      <div v-if="loading" class="notes-loading" role="status"><LoaderCircle :size="22" class="notes-spin" />Opening your notes…</div>
      <div v-if="error" class="notes-error-banner" role="alert">{{error}}<button v-if="dirty&&!saving" @click="saveDraft">Retry draft save</button></div>
      <nav v-if="privateDocument" class="notes-mobile-tabs" aria-label="Notes workspace panels">
        <button :aria-pressed="mobilePane==='write'" @click="mobilePane='write'"><NotebookPen :size="14" />Write</button>
        <button :aria-pressed="mobilePane==='preview'" @click="mobilePane='preview'"><Monitor :size="14" />Preview<span class="notes-count">{{previewItems.length}}</span></button>
        <button :aria-pressed="mobilePane==='transcript'" @click="transcriptVisible=true;mobilePane='transcript'"><AudioLines :size="14" />Transcript<i v-if="linked" class="notes-live-dot" /></button>
      </nav>
      <div v-if="privateDocument" class="notes-workspace" :class="{'has-transcript':showTranscript}">
        <aside v-if="showTranscript" class="notes-transcript-pane" :class="{'is-mobile-active':mobilePane==='transcript'}" aria-label="Private transcript">
          <header class="notes-pane-heading"><div><AudioLines :size="15" /><h3>Transcript</h3><span v-if="linked" class="notes-connected"><i class="notes-live-dot" />Live</span></div><div class="notes-transcript-toolbar" role="group" aria-label="Transcript actions">
            <button class="notes-icon-button" :disabled="!!shared.session||active||producer.active" :aria-expanded="audioSettings" aria-label="Audio settings" title="Audio settings" @click="audioSettings=!audioSettings"><SlidersHorizontal :size="15" /></button>
            <button class="notes-icon-button" :disabled="!transcript" aria-label="Copy transcript" title="Copy transcript" @click="copyTranscript"><Copy :size="14" /></button><button class="notes-icon-button" :disabled="!transcript||!canEdit||clearing" aria-label="Clear transcript" title="Clear transcript" @click="clearTranscript"><Trash2 :size="14" /></button></div></header>
          <div class="notes-transcript-controls" aria-label="Notes transcript connection">
            <template v-if="shared.session">
              <div class="notes-connection-summary"><i :class="{'notes-live-dot':linked}" /><span>{{linked?'Linked to live transcript':'Listening is running'}}</span></div>
              <div class="notes-connection-actions">
                <button v-if="linked" class="notes-quiet-button" :disabled="linkBusy||!canEdit" @click="unlinkTranscript"><Unlink :size="13" />Unlink transcript</button>
                <button v-else :disabled="linkBusy||!canEdit||shared.session.state==='finishing'||active" @click="linkTranscript"><Link :size="13" />{{linkBusy?'Linking…':'Link live transcript'}}</button>
                <button v-if="shared.session.ownerId===identity.me?.id" class="notes-quiet-button" :disabled="shared.busy||producer.finishing" @click="shared.stop()"><Square :size="11" />{{producer.finishing?'Finishing…':'Stop shared listening'}}</button>
              </div>
              <p class="notes-hint">{{linked?'New speech is collected here, even when you close Notes.':'Link to collect new speech in this note.'}}</p>
            </template>
            <template v-else>
              <div class="notes-start-row">
                <button v-if="producer.active" :disabled="producer.finishing" @click="producer.stop(false)"><Square :size="12" />Cancel start</button>
                <button v-else class="notes-listen-button" :disabled="!active&&(!canEdit||!modelReady||source==='microphone'&&(!canUse||missing))" @click="active?stopListening():startListening()"><Square v-if="active" :size="12" /><Mic v-else :size="14" />{{starting?'Cancel start':active?'Stop local listening':provider==='assemblyai'?'Start shared listening':'Start local listening'}}</button>
              </div>
              <p class="notes-input-summary">{{producer.starting?'Connecting…':active?busy?'Transcribing…':'Listening':source==='program'?'Program · Main mix':selectedLabel||'System default microphone'}}</p>
              <div v-if="audioSettings&&!active&&!producer.active" class="notes-audio-settings">
                <label>Recognition<select v-model="provider" aria-label="Notes recognition provider"><option value="assemblyai">AssemblyAI</option><option value="local">Local Whisper</option></select></label>
                <label>Listen to<select v-model="source" aria-label="Notes audio source"><option value="microphone">Microphone or audio interface</option><option value="program">Program · Main mix</option></select></label>
                <template v-if="source==='microphone'">
                  <label>Audio input<select v-model="deviceId" aria-label="Notes microphone"><option value="">System default microphone</option><option v-if="missing" :value="deviceId" disabled>{{selectedLabel}} · disconnected</option><option v-for="(device,index) in devices" :key="device.deviceId||index" :value="device.deviceId">{{device.label||`Audio input ${index+1}`}}</option></select></label>
                  <button class="notes-text-button" @click="refreshDevices(true)">Allow access / refresh inputs</button>
                  <label>Input processing<select v-model="processing" aria-label="Notes input processing"><option value="speech">Microphone · speech cleanup</option><option value="mixer">Mixer / line input · clean feed</option></select></label>
                </template>
                <p v-else class="notes-hint">Uses the running Program’s audio. Check Main in Studio first.</p>
                <p class="notes-hint">{{provider==='assemblyai'?'Audio is sent to AssemblyAI. One stream serves Scripture and linked Notes.':'Local transcription stops when you close this note.'}}</p>
              </div>
              <p v-if="source==='microphone'&&missing" class="notes-inline-error">The selected input disconnected. Choose another in Audio settings.</p>
              <p v-else-if="source==='microphone'&&inputError" class="notes-inline-error">{{inputError}}</p>
              <p v-if="!modelReady" class="notes-hint">{{provider==='assemblyai'?'AssemblyAI needs a station API key.':model?.error||'Install a local model in listening settings.'}} You can keep writing.</p>
            </template>
            <SegmentedMeter v-if="active||linked" label="Notes input level" :percent="Math.min(100,inputLevel*400)" />
          </div>
          <div v-if="linked" class="notes-live-words" aria-label="Notes live transcript"><span><i class="notes-live-dot" />Live words</span><p>{{interim||'Waiting for the next phrase…'}}</p></div>
          <section v-if="linked&&scripture" class="notes-scripture" aria-label="Detected scripture"><div><strong>{{scripture.reference}}</strong><button class="notes-text-button" :disabled="!canEdit" @click="useReference">Use reference</button></div><p>{{scripture.text}}</p></section>
          <div class="notes-transcript-copy"><span>Completed phrases</span><span>{{privateDocument.segments.length}}</span></div>
          <textarea ref="transcriptElement" class="notes-transcript" :value="transcript" readonly aria-label="Private transcript text" placeholder="Your transcript will appear here. Select a phrase to add it to your notes." @select="selectTranscript" @keyup="selectTranscript" @mouseup="selectTranscript" />
          <footer class="notes-insert-footer"><span>{{selectedText?'Selection ready':uncertain?`${uncertain} passages need checking`:'Select the words you want to use'}}</span><button :disabled="!selectedText||!canEdit" @click="useSelection"><ArrowDownToLine :size="13" />Insert selection</button></footer>
        </aside>
        <section class="notes-writing-pane" :class="{'is-mobile-active':mobilePane==='write'}" aria-label="Notes editor">
          <div class="notes-pane-heading"><div><NotebookPen :size="15" /><h3>Your notes</h3></div><span class="notes-small-label">PRIVATE DRAFT</span></div>
          <label class="notes-title-label"><span>Title</span><input v-model="draft.title" maxlength="500" aria-label="Notes slide title" placeholder="Give this thought a title" /></label>
          <div class="notes-layout-switch" role="group" aria-label="Notes slide layout"><button v-for="layout in layouts" :key="layout.value" :aria-label="`${layout.label} layout`" :aria-pressed="draft.layout===layout.value" :disabled="grouping==='pointers'" @click="draft.layout=layout.value"><component :is="layout.icon" :size="13" /><span>{{layout.label}}</span></button></div>
          <label class="notes-body-label"><span>{{grouping==='pointers'?'One thought per line':'Write your message'}}</span><textarea ref="bodyElement" v-model="draft.body" maxlength="20000" aria-label="Notes draft text" :placeholder="grouping==='pointers'?'Write one point on each line. Each becomes its own slide.':'Type as the speaker talks, or insert a phrase from the transcript…'" @select="rememberCursor" @keyup="rememberCursor" @click="rememberCursor" @blur="rememberCursor" /></label>
          <div class="notes-writing-meta"><span>{{draft.body.trim()?draft.body.trim().split(/\s+/).length:0}} words</span><span v-if="grouping==='pointers'">{{lines.length}} {{lines.length===1?'point':'points'}}</span><span v-else>Preview updates as you type</span></div>
          <label class="notes-reference-label"><span>Reference or speaker <small>optional</small></span><input v-model="draft.reference" maxlength="500" aria-label="Notes slide reference" placeholder="Scripture reference or attribution" /></label>
        </section>
        <aside class="notes-preview-pane" :class="{'is-mobile-active':mobilePane==='preview'}" aria-label="Notes slide design">
          <header class="notes-pane-heading"><div><Monitor :size="15" /><h3>Slide preview</h3></div><span class="notes-preview-live"><i />Updates live</span></header>
          <div class="notes-build-row"><label><Layers :size="13" /><select v-model="grouping" aria-label="Notes slide grouping"><option value="single">One slide</option><option value="pointers">One slide per line</option></select></label><span>{{previewIndex+1}} / {{previewItems.length}}</span></div>
          <div class="notes-preview-stage" aria-label="Slide preview"><PreviewSurface v-if="previewItem" :item="previewItem" :expandable="true" /><div v-if="!draft.body.trim()" class="notes-empty-preview"><NotebookPen :size="23" /><span>Your words take shape here</span></div></div>
          <p v-if="lines.length>100" class="notes-inline-error">Use up to 100 points. The first 100 are previewed.</p>
          <div v-if="previewItems.length>1" class="notes-filmstrip" aria-label="Slide previews">
            <button class="notes-filmstrip-arrow" :disabled="previewIndex===0" aria-label="Previous preview slide" @click="previewIndex--"><ChevronLeft :size="15" /></button>
            <div class="notes-thumbnails"><button v-for="entry in thumbnails" :key="entry.item.id" :aria-label="`Preview slide ${entry.index+1}`" :aria-pressed="previewIndex===entry.index" @click="previewIndex=entry.index"><PreviewSurface :item="entry.item" :design-width="1920" thumbnail /><span>{{entry.index+1}}</span></button></div>
            <button class="notes-filmstrip-arrow" :disabled="previewIndex===previewItems.length-1" aria-label="Next preview slide" @click="previewIndex++"><ChevronRight :size="15" /></button>
          </div>
          <div class="notes-preview-caption"><span>{{grouping==='pointers'?'Each non-empty line becomes a slide.':'Exactly how your slide will appear.'}}</span><span v-if="changesToApply" class="notes-unapplied">Draft changes</span><span v-else><Check :size="11" />Up to date</span></div>
          <div class="notes-style-section">
            <button class="notes-style-heading" :aria-expanded="styleOpen" @click="styleOpen=!styleOpen"><span><Palette :size="14" />Style</span><span>{{backgroundName}}<ChevronDown :size="13" :class="{'is-expanded':styleOpen}" /></span></button>
            <div v-if="styleOpen" class="notes-style-content">
              <div class="notes-themes" role="group" aria-label="Slide themes"><button v-for="theme in themes" :key="theme.name" :aria-label="`Use ${theme.name} theme`" :aria-pressed="isTheme(theme)" @click="useTheme(theme)"><i :style="{background:theme.gradient||theme.color}"><span>Aa</span><Check v-if="isTheme(theme)" :size="10" /></i><span>{{theme.name}}</span></button></div>
              <div class="notes-style-row"><div class="notes-alignments" role="group" aria-label="Text alignment"><button :aria-pressed="textAlign==='left'" aria-label="Align left" @click="setAlignment('left')"><AlignLeft :size="15" /></button><button :aria-pressed="textAlign==='center'" aria-label="Align center" @click="setAlignment('center')"><AlignCenter :size="15" /></button><button :aria-pressed="textAlign==='right'" aria-label="Align right" @click="setAlignment('right')"><AlignRight :size="15" /></button></div><label class="notes-size-label"><Type :size="14" /><select v-model="textSize" aria-label="Notes text size"><option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option><option value="xl">Extra large</option><option value="2xl">Display</option></select></label><button class="notes-image-button" @click="imagePickerOpen=true"><Image :size="14" />Image</button></div>
              <label v-if="draft.background?.kind==='image'||draft.background?.kind==='video'" class="notes-overlay-label"><span>Background dimming</span><input v-model.number="draft.background.overlayOpacity" type="range" min="0" max="0.9" step="0.05" aria-label="Notes background dimming" /></label>
            </div>
          </div>
        </aside>
      </div>
      <footer class="notes-footer"><div class="notes-footer-status" role="status"><Check v-if="notice" :size="13" /><span>{{notice||'Your draft saves automatically. Update when the slide is ready.'}}</span></div><div class="notes-footer-actions"><span class="notes-shortcut">⌘ / Ctrl ↵</span><button class="notes-update-button" :disabled="!canUpdate" @click="updateSlides"><LoaderCircle v-if="updating" :size="15" class="notes-spin" /><Check v-else :size="15" />{{updating?'Updating…':previewItems.length>1?'Update slides':'Update slide'}}</button></div></footer>
    </DialogContent>
  </Dialog>
  <MediaImagePicker v-model:open="imagePickerOpen" :selected-path="draft.background?.src" :accepted-kinds="['image']" title="Choose a slide background" @select="chooseImage" />
</template>

<style scoped>
:global(.notes-workspace-dialog) { width:1460px;max-width:calc(100vw - 40px);height:min(900px,calc(100dvh - 40px));max-height:calc(100dvh - 40px);padding:0!important;gap:0;overflow:hidden;border-radius:16px;background:#181a1e;box-shadow:0 32px 100px #0009;transition-property:opacity,transform; }
.notes-header { display:flex;flex-direction:row;align-items:center;gap:13px;padding:20px 54px 19px 26px;flex:0 0 auto;border-bottom:1px solid #ffffff0d; }
.notes-heading-icon { display:grid;place-items:center;width:40px;height:40px;flex-shrink:0;border:1px solid #a6d8ed19;border-radius:11px;background:linear-gradient(145deg,#29424c55,#1b2d3618);color:#b0dce9; }
.notes-heading-copy { min-width:0; }.notes-heading-copy :deep([data-slot="dialog-title"]) { font-size:17px;letter-spacing:-.25px;font-weight:650; }.notes-heading-copy :deep([data-slot="dialog-description"]) { color:#9299a6;font-size:11px;margin-top:5px; }
.notes-header-actions { display:flex;align-items:center;gap:18px;margin-left:auto; }.notes-save-state { display:flex;align-items:center;gap:6px;color:#8d99a6;font-size:10px;white-space:nowrap; }
button { display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 10px;border:1px solid #ffffff15;border-radius:7px;font-size:11px;line-height:16px;color:#cdd3dd;background:#ffffff03;cursor:pointer;transition:background .15s,border-color .15s,color .15s; }button:disabled { opacity:.38;cursor:not-allowed; }button:not(:disabled):hover { background:#ffffff0a;border-color:#ffffff2d;color:#f2f6fa; }button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible { outline:2px solid #99cddd;outline-offset:2px; }
.notes-transcript-toggle { padding:8px 12px; }.notes-transcript-toggle[aria-pressed="true"] { background:#283e485e;color:#b5e3f2;border-color:#8bd0e540; }.notes-live-dot { display:inline-block;width:5px;height:5px;flex-shrink:0;border-radius:50%;background:#8ec9a6;box-shadow:0 0 0 3px #8ec9a610; }
.notes-workspace { display:grid;grid-template-columns:minmax(310px,.95fr) minmax(360px,1.05fr);flex:1;min-height:0;overflow:hidden; }.notes-workspace.has-transcript { grid-template-columns:minmax(240px,.72fr) minmax(300px,.96fr) minmax(360px,1.05fr); }
.notes-writing-pane,.notes-preview-pane,.notes-transcript-pane { display:flex;flex-direction:column;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin; }.notes-writing-pane { padding:22px 26px 24px;gap:20px; }.notes-preview-pane { padding:22px 25px 24px;border-left:1px solid #ffffff0b;background:#121418;gap:16px; }.notes-transcript-pane { border-right:1px solid #ffffff0b;padding:22px 18px 0;background:#15171a;gap:14px; }
.notes-pane-heading { display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:22px;flex-shrink:0; }.notes-pane-heading>div { display:flex;align-items:center;gap:8px;color:#aab4c2; }.notes-pane-heading h3 { font-size:12px;font-weight:600;color:#e0e5ec; }.notes-small-label { font-size:8px;font-weight:600;letter-spacing:1.15px;color:#687482; }.notes-connected { display:flex;align-items:center;gap:5px;font-size:9px;color:#9fd3b5;margin-left:3px; }.notes-icon-button { width:30px;height:30px;padding:0;flex-shrink:0; }.notes-preview-live { display:flex;align-items:center;gap:5px;font-size:9px;color:#8d9e97;white-space:nowrap; }.notes-preview-live i { width:5px;height:5px;background:#85aa96;border-radius:50%; }
label { display:flex;flex-direction:column;gap:7px;min-width:0;color:#a6adb9;font-size:10px; }input:not([type="range"]),select,textarea { width:100%;min-width:0;border:1px solid #ffffff10;border-radius:7px;padding:9px 11px;background:#101215;color:#e7eaf0;font-size:12px;line-height:1.5;outline:none;transition:border-color .15s; }input:hover,textarea:hover,select:hover { border-color:#ffffff25; }input:focus,textarea:focus,select:focus { border-color:#8bd0e56b; }select { cursor:pointer; }
.notes-title-label>span,.notes-body-label>span,.notes-reference-label>span { font-weight:500; }.notes-title-label input { font-size:19px;line-height:1.4;letter-spacing:-.4px;padding:10px 0;border:0;border-bottom:1px solid #ffffff17;border-radius:0;background:transparent;font-weight:550; }.notes-title-label input:focus { border-color:#8bd0e5; }
.notes-layout-switch { display:flex;align-items:center;gap:3px;padding:3px;border:1px solid #ffffff0c;background:#111316;border-radius:8px;flex-shrink:0; }.notes-layout-switch button { padding:7px 4px;flex:1;border:1px solid transparent;background:none;font-size:10px;white-space:nowrap; }.notes-layout-switch button[aria-pressed="true"] { background:#26333d;border-color:#9fd9ed27;color:#bae8f7; }.notes-layout-switch button:disabled { opacity:.45; }
.notes-body-label { flex:1;min-height:160px;gap:9px; }.notes-body-label textarea { resize:none;min-height:155px;flex:1;padding:15px 15px;font-size:14px;line-height:1.85;background:#131519;border-color:#ffffff0c; }.notes-body-label textarea::placeholder { color:#66717e; }.notes-writing-meta { display:flex;justify-content:space-between;gap:8px;font-size:9px;color:#77818e;margin-top:-10px;flex-shrink:0; }.notes-reference-label { flex-shrink:0; }.notes-reference-label>span { display:flex;gap:6px;align-items:baseline; }.notes-reference-label small { font-size:9px;color:#626d7c;font-weight:400; }.notes-reference-label input { font-size:11px; }
.notes-build-row { display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:10px;color:#7f8a99;flex-shrink:0; }.notes-build-row label { display:flex;flex-direction:row;align-items:center;gap:7px; }.notes-build-row select { width:auto;padding:7px 27px 7px 9px;font-size:11px;background:#1c1f25; }.notes-build-row>span { font-variant-numeric:tabular-nums; }
.notes-preview-stage { position:relative;padding:5px;background:#1d2026;border:1px solid #ffffff13;border-radius:11px;box-shadow:0 16px 35px #0004;flex-shrink:0; }.notes-preview-stage :deep(.aspect-video) { border-radius:6px;border-color:#ffffff0a; }.notes-empty-preview { pointer-events:none;position:absolute;inset:5px;display:flex;align-items:center;justify-content:center;gap:9px;color:#d2dde8b3;font-size:12px;border-radius:6px;background:#080c1490;backdrop-filter:blur(3px); }
.notes-preview-caption { display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:9px;color:#727e8d;margin-top:-4px;flex-shrink:0; }.notes-preview-caption>span:last-child { display:flex;align-items:center;gap:4px;white-space:nowrap;color:#8ea69a; }.notes-preview-caption .notes-unapplied { color:#c7b78b!important; }
.notes-filmstrip { display:flex;gap:7px;align-items:center;flex-shrink:0; }.notes-filmstrip-arrow { width:23px;height:40px;padding:0;border:0;background:transparent;flex-shrink:0; }.notes-thumbnails { display:flex;gap:7px;flex:1;min-width:0; }.notes-thumbnails>button { position:relative;display:block;min-width:0;flex:1;padding:2px;border-radius:5px;border-color:#ffffff14;overflow:hidden; }.notes-thumbnails>button[aria-pressed="true"] { border-color:#b3e2f3;box-shadow:0 0 0 1px #b3e2f330; }.notes-thumbnails>button>span { position:absolute;bottom:4px;left:5px;font-size:8px;color:#eef5fb;background:#0009;border-radius:2px;padding:0 3px;line-height:13px; }.notes-thumbnails :deep(.aspect-video) { border:0;border-radius:2px;pointer-events:none; }
.notes-style-section { border-top:1px solid #ffffff0d;margin-top:3px;flex-shrink:0; }.notes-style-heading { display:flex;justify-content:space-between;width:100%;border:0;padding:15px 0 13px;background:transparent!important; }.notes-style-heading>span { display:flex;align-items:center;gap:7px; }.notes-style-heading>span:last-child { font-size:10px;color:#727f91; }.notes-style-heading .is-expanded { transform:rotate(180deg); }.notes-style-content { display:flex;flex-direction:column;gap:15px; }.notes-themes { display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px; }.notes-themes button { display:flex;flex-direction:column;gap:6px;padding:0;border:0;background:transparent!important;font-size:8px;color:#8590a0; }.notes-themes button>i { position:relative;display:grid;place-items:center;width:100%;aspect-ratio:1.35;border-radius:6px;border:1px solid #ffffff19;color:#e0e7ef;font-size:16px;font-weight:600;font-style:normal;box-shadow:inset 0 0 20px #0001; }.notes-themes button[aria-pressed="true"] { color:#bce6f6; }.notes-themes button[aria-pressed="true"]>i { border-color:#b5e6f8;box-shadow:0 0 0 2px #a3ddf322; }.notes-themes svg { position:absolute;right:4px;bottom:4px; }
.notes-style-row { display:flex;align-items:center;gap:8px; }.notes-alignments { display:flex;padding:2px;border:1px solid #ffffff12;background:#191c22;border-radius:6px; }.notes-alignments button { border:0;padding:6px 8px;border-radius:4px;background:transparent; }.notes-alignments button[aria-pressed="true"] { background:#354450;color:#d2eff8; }.notes-size-label { display:flex;align-items:center;flex-direction:row;gap:6px;flex:1;color:#8d9aab; }.notes-size-label select { font-size:10px;padding:7px 5px;background:#191c22; }.notes-image-button { font-size:10px;padding:8px 9px; }.notes-overlay-label { display:flex;flex-direction:row;align-items:center;gap:14px;color:#778496;font-size:10px; }.notes-overlay-label input { flex:1;min-width:0;accent-color:#a8d7e8; }
.notes-transcript-controls { display:flex;flex-direction:column;gap:7px;flex-shrink:0; }.notes-start-row { display:flex;gap:7px;align-items:center; }.notes-listen-button { flex:1;background:#233c3540;border-color:#7cba992e;color:#add3bd; }.notes-input-summary { font-size:9px;color:#7c8796;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }.notes-audio-settings { display:flex;flex-direction:column;gap:11px;padding:12px;margin-top:3px;background:#101215;border:1px solid #ffffff0d;border-radius:8px; }.notes-audio-settings select { font-size:10px; }.notes-hint { color:#6f7c8e;font-size:9px;line-height:1.6; }.notes-text-button { align-self:flex-start;padding:0;border:0;background:transparent!important;color:#a5d2e3;font-size:10px; }.notes-quiet-button { font-size:9px;padding:5px 7px;border-color:#ffffff0e;background:transparent; }.notes-connection-summary { display:flex;align-items:center;gap:7px;color:#c1cdc8;font-size:10px; }.notes-connection-actions { display:flex;gap:6px;flex-wrap:wrap; }.notes-meter { width:100%;height:3px;background:#ffffff0b;border-radius:5px;overflow:hidden; }.notes-meter i { display:block;height:100%;background:#86c6ad;transition:width .12s; }
.notes-live-words { padding:0;flex-shrink:0; }.notes-live-words>span { display:flex;align-items:center;gap:6px;font-size:8px;text-transform:uppercase;letter-spacing:.7px;color:#96bacb; }.notes-live-words p { font-size:11px;line-height:1.65;color:#c8d5df;margin-top:7px;min-height:34px;max-height:100px;overflow:auto; }.notes-scripture { padding:10px 11px;border:1px solid #82bca12b;background:#82bca106;border-radius:7px;flex-shrink:0; }.notes-scripture>div { display:flex;justify-content:space-between;align-items:center;gap:5px; }.notes-scripture strong { font-size:12px;color:#b4d7c4; }.notes-scripture>p { font-size:10px;line-height:1.6;color:#9caaa7;margin-top:7px;max-height:70px;overflow:auto; }
.notes-transcript-copy { display:flex;justify-content:space-between;font-size:9px;color:#778292;flex-shrink:0;padding-top:3px; }.notes-transcript { flex:1;min-height:140px;resize:none;border:0;border-radius:0;background:transparent;padding:0 2px;font-size:12px;line-height:1.8;color:#c2cad6;scrollbar-width:thin; }.notes-transcript::placeholder { color:#566373; }.notes-transcript:focus { outline:0; }.notes-insert-footer { display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;padding:12px 0 16px;border-top:1px solid #ffffff0b; }.notes-insert-footer>span { color:#6e7b8e;font-size:9px; }.notes-insert-footer>button { margin-left:auto;font-size:10px;padding:7px 9px; }
.notes-footer { display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 26px;border-top:1px solid #ffffff0d;background:#1b1d22;flex:0 0 auto; }.notes-footer-status { display:flex;align-items:center;gap:7px;color:#8593a4;font-size:10px;min-width:0; }.notes-footer-status svg { color:#9ec8ae;flex-shrink:0; }.notes-footer-actions { display:flex;align-items:center;gap:14px;flex-shrink:0; }.notes-shortcut { color:#626f80;font-size:10px;white-space:nowrap; }.notes-update-button { min-width:123px;background:#ddfb73!important;color:#182013!important;border-color:#ddfb73;box-shadow:inset 0 1px #ffffff50;font-size:12px;font-weight:600;padding:10px 14px; }.notes-update-button:not(:disabled):hover { background:#e7ffa1!important; }.notes-update-button:disabled { opacity:.4; }
.notes-error-banner { display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 26px;background:#b84e4e12;border-bottom:1px solid #b84e4e25;color:#f4aaaa;font-size:11px;flex-shrink:0; }.notes-inline-error { color:#efaaa9;font-size:10px;line-height:1.5; }.notes-loading { display:flex;flex:1;align-items:center;justify-content:center;gap:12px;color:#8493a5;font-size:12px; }.notes-spin { animation:notes-spin 1s linear infinite; }@keyframes notes-spin { to { transform:rotate(360deg); } }.notes-mobile-tabs { display:none; }
@media(min-width:761px) and (max-width:1220px) { .notes-workspace.has-transcript { grid-template-columns:minmax(210px,.7fr) minmax(260px,.95fr) minmax(300px,1.05fr); }.has-transcript .notes-writing-pane { padding:20px 17px; }.has-transcript .notes-preview-pane { padding:20px 17px; }.has-transcript .notes-transcript-pane { padding:20px 14px 0; }.has-transcript .notes-layout-switch button { font-size:9px;gap:4px; }.has-transcript .notes-layout-switch svg { display:none; }.has-transcript .notes-style-row { flex-wrap:wrap; }.has-transcript .notes-image-button { margin-left:auto; }.has-transcript .notes-save-state { display:none; } }
@media(max-width:960px) and (min-width:761px) { :global(.notes-workspace-dialog) { max-width:calc(100vw - 24px); }.notes-workspace.has-transcript { grid-template-columns:220px minmax(250px,1fr); }.has-transcript .notes-preview-pane { grid-column:2;border-top:1px solid #ffffff0b;overflow:visible; }.has-transcript .notes-transcript-pane { grid-row:1/3; }.notes-workspace.has-transcript { overflow-y:auto; }.has-transcript .notes-writing-pane { min-height:410px;overflow:visible; }.has-transcript .notes-preview-stage { max-width:410px;width:100%;align-self:center; }.notes-header { padding:18px 48px 17px 20px; }.notes-save-state { display:none; } }
@media(max-width:760px) { :global(.notes-workspace-dialog) { width:100%;max-width:calc(100vw - 12px);height:calc(100dvh - 12px);max-height:calc(100dvh - 12px);border-radius:12px; }.notes-header { padding:15px 44px 13px 16px;gap:10px; }.notes-heading-icon { width:33px;height:33px;border-radius:8px; }.notes-heading-copy :deep([data-slot="dialog-title"]) { font-size:14px; }.notes-heading-copy :deep([data-slot="dialog-description"]) { font-size:9px;line-height:1.4;max-width:210px;margin-top:3px; }.notes-header-actions { display:none; }.notes-mobile-tabs { display:flex;padding:8px 14px;gap:5px;border-bottom:1px solid #ffffff0b;flex-shrink:0; }.notes-mobile-tabs button { flex:1;border:0;background:transparent;font-size:11px;padding:7px 4px;color:#7e8b9d; }.notes-mobile-tabs button[aria-pressed="true"] { color:#b8e1ef;background:#28404b60; }.notes-count { font-size:9px;min-width:15px;height:15px;border-radius:4px;background:#ffffff08; }.notes-workspace,.notes-workspace.has-transcript { display:block;overflow:hidden; }.notes-writing-pane,.notes-preview-pane,.notes-transcript-pane { display:none;height:100%;border:0;padding:18px 18px; }.notes-workspace .is-mobile-active { display:flex; }.notes-writing-pane { gap:17px; }.notes-body-label { min-height:160px; }.notes-body-label textarea { font-size:14px; }.notes-preview-pane { gap:15px; }.notes-transcript-pane { gap:12px; }.notes-insert-footer { padding-bottom:0; }.notes-title-label input { font-size:19px; }.notes-layout-switch button { font-size:10px; }.notes-footer { gap:10px;padding:12px 15px; }.notes-footer-status { font-size:9px;line-height:1.5; }.notes-shortcut { display:none; }.notes-footer-actions { gap:0; }.notes-update-button { min-width:112px;padding:9px 10px;font-size:11px; }.notes-style-row { flex-wrap:wrap; }.notes-size-label { flex:1;min-width:95px; }.notes-error-banner { padding:9px 16px;font-size:10px; }.notes-empty-preview { font-size:11px; } }
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important;transition:none!important; } }

.notes-pane-heading > .notes-transcript-toolbar { gap:2px;flex-shrink:0;padding:3px;border:1px solid #ffffff12;border-radius:9px;background:#ffffff03; }
.notes-transcript-toolbar .notes-icon-button { border:0;background:transparent;border-radius:6px; }
.notes-transcript-toolbar .notes-icon-button:hover:not(:disabled),.notes-transcript-toolbar .notes-icon-button[aria-expanded="true"] { background:#ffffff0b; }
.notes-transcript-toolbar .notes-icon-button:last-child { margin-left:4px;position:relative; }
.notes-transcript-toolbar .notes-icon-button:last-child::before { content:'';position:absolute;left:-4px;top:6px;bottom:6px;width:1px;background:#ffffff12; }
.notes-start-row > button { flex:1; }

.notes-layout-switch button[aria-pressed="true"], .notes-alignments button[aria-pressed="true"] { background:var(--surface-3); color:var(--text-primary); border-color:var(--border-glow); }
.notes-layout-switch button[aria-pressed="true"] { box-shadow:none; }
.notes-themes button[aria-pressed="true"] { color:var(--accent); }
.notes-themes button[aria-pressed="true"]>i { border-color:var(--accent); box-shadow:none; }
.notes-listen-button { background:var(--surface-3); color:var(--text-primary); border-color:var(--border-hair); }
.notes-overlay-label input { accent-color:#eceef0; }

.notes-heading-icon { background:var(--surface-3); border-color:var(--border-hair); color:var(--text-primary); }
.notes-transcript-toggle[aria-pressed="true"] { background:var(--surface-3); color:var(--text-primary); border-color:var(--border-glow); }
.notes-thumbnails>button[aria-pressed="true"] { border-color:var(--accent); box-shadow:none; }
.notes-text-button { color:var(--accent); }

.notes-mobile-tabs button[aria-pressed="true"] { color:var(--text-primary); background:var(--surface-3); box-shadow:none; }
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible { outline-color:var(--accent); }
</style>
