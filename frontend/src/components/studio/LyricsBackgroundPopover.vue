<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Image as ImageIcon, Film, Layers, ChevronDown, X, Upload, FolderOpen, Trash2, VolumeX, LoaderCircle } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, type MediaLibraryFile } from '@/lib/api';
import { mediaAccept, mediaAssetUrl, mediaDisplayName, mediaExtensions, mediaFilesForKind, MAX_MEDIA_BYTES } from '@/lib/studio/media-library';
import { ensureScenePosterMedia, scenePosterMedia } from '@/lib/studio/scene-poster-media';
import { useStudioStore } from '@/stores/studio';
import StudioPropertyInput from './StudioPropertyInput.vue';
import type { SceneLayer } from '../../../../shared/production';

const props=defineProps<{layer:SceneLayer;sceneId:string}>();
const studio=useStudioStore(),open=ref(false),choosing=ref(false),files=ref<MediaLibraryFile[]>([]),loading=ref(false),busy=ref(false),progress=ref(0),error=ref(''),phase=ref('');
type Kind='none'|'color'|'image'|'video';
const savedKind=()=>props.layer.mediaBackground?.kind??(props.layer.background.length===9&&props.layer.background.endsWith('00')?'none':'color');
const kind=ref<Kind>(savedKind()),fileInput=ref<HTMLInputElement>();
const media=computed(()=>props.layer.mediaBackground),locked=computed(()=>props.layer.locked);
const runtimeError=computed(()=>studio.status.state==='running'&&media.value?studio.status.backgroundErrors?.[media.value.url]??'':'');
const mediaKind=computed(()=>kind.value==='video'?'video':'image');
const available=computed(()=>mediaFilesForKind(files.value,mediaKind.value));
const selected=computed(()=>files.value.find(file=>file.path.replace(/^\//,'')===media.value?.url.replace(/^\//,'')));
const filename=computed(()=>media.value?mediaDisplayName(media.value.url.split('/').pop()??'Background'):savedKind()==='none'?'Transparent':'Solid color');
const poster=computed(()=>media.value?(selected.value?.thumbnail?mediaAssetUrl(selected.value.thumbnail):scenePosterMedia(media.value.url,media.value.kind)):undefined);
const hasMedia=computed(()=>!!media.value&&media.value.kind===kind.value);
const identity=computed(()=>`${props.sceneId}:${props.layer.id}`);
let epoch=0,controller:AbortController|undefined,listController:AbortController|undefined;
watch(()=>media.value?.url,url=>{if(url)ensureScenePosterMedia([url]);},{immediate:true});
function cancel(){epoch++;controller?.abort();controller=undefined;busy.value=false;phase.value='';}
function invalidate(){cancel();listController?.abort();listController=undefined;loading.value=false;}
watch([()=>props.sceneId,()=>props.layer.id,()=>props.layer.locked],()=>{open.value=false;invalidate();kind.value=savedKind();});
watch(open,value=>{if(value){kind.value=savedKind();error.value='';choosing.value=false;void loadFiles();}else invalidate();});
onBeforeUnmount(invalidate);
async function loadFiles(){listController?.abort();const request=new AbortController();listController=request;loading.value=true;try{const result=await api.listMedia('backgrounds',request.signal);if(!request.signal.aborted)files.value=result;}catch{if(!request.signal.aborted)error.value='Could not load backgrounds. Try opening this panel again.';}finally{if(listController===request)loading.value=false;}}
async function patch(value:Partial<SceneLayer>,target=identity.value){if(locked.value||target!==identity.value)return;try{await studio.updateLayer(props.layer.id,value,props.sceneId);}catch{error.value='Could not save this background. Please try again.';}}
function changeType(next:Kind){cancel();kind.value=next;error.value='';choosing.value=next==='image'||next==='video';if(next==='none'||next==='color'){choosing.value=false;void patch({mediaBackground:null,background:next==='none'?'#00000000':props.layer.background.slice(0,7),channelStyle:'overlay'});}}
async function mediaSetting(value:Partial<NonNullable<SceneLayer['mediaBackground']>>,target=identity.value){
  if(!media.value||locked.value||target!==identity.value)return;
  try{await studio.updateLayerMediaBackground(props.layer.id,value,props.sceneId);}
  catch{error.value='Could not save this background. Please try again.';}
}
function thumb(file:MediaLibraryFile){return file.thumbnail?mediaAssetUrl(file.thumbnail):mediaExtensions.image.test(file.name)?mediaAssetUrl(file.path):undefined;}
async function readyVideo(url:string,signal:AbortSignal){
  if(!/\.mov$/i.test(url))return url;
  phase.value='Preparing video for playback…';
  for(let attempt=0;attempt<150;attempt++){
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const status=await api.sourceVideoStatus(url);
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    if(status.status==='ready'&&status.path)return status.path;
    if(status.status==='failed'||status.status==='missing')throw new Error('This video could not be prepared. Try an MP4 (H.264) file.');
    await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},2000);signal.addEventListener('abort',abort,{once:true});});
  }
  throw new Error('This video is still being prepared. Choose it from the library again shortly.');
}
async function applyFile(file:MediaLibraryFile,type:'image'|'video',token:number,signal:AbortSignal,target:string){
  const url=type==='video'?await readyVideo(file.path,signal):file.path;
  if(token!==epoch||signal.aborted||target!==identity.value||!open.value)return;
  await patch({mediaBackground:{kind:type,url,fit:media.value?.fit??'cover',dim:media.value?.dim??.35,loop:media.value?.loop??true},background:'#00000000',channelStyle:'overlay'},target);
  if(token===epoch){kind.value=type;choosing.value=false;}
}
async function choose(file:MediaLibraryFile){
  if(locked.value)return;cancel();const token=epoch,request=new AbortController(),target=identity.value,type=mediaKind.value;controller=request;busy.value=true;error.value='';
  try{await applyFile(file,type,token,request.signal,target);}catch(cause){if(!request.signal.aborted&&token===epoch)error.value=(cause as Error).message.includes('video')?(cause as Error).message:'Could not use this background. Please try again.';}finally{if(token===epoch){busy.value=false;phase.value='';}}
}
async function upload(event:Event){
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file||locked.value)return;
  const type=mediaExtensions.video.test(file.name)?'video':mediaExtensions.image.test(file.name)?'image':null;
  if(!type){error.value='Choose a JPG, PNG, WebP, GIF, MP4, WebM, MOV or M4V file.';return;}
  if(!file.size||file.size>MAX_MEDIA_BYTES){error.value=file.size?'Choose a file smaller than 512 MB.':'This file is empty. Choose another file.';return;}
  cancel();const token=epoch,request=new AbortController(),target=identity.value;controller=request;busy.value=true;progress.value=0;phase.value='Uploading…';error.value='';
  try{
    const result=await api.uploadMedia('backgrounds',file,{signal:request.signal,sourceVideo:type==='video',onProgress:value=>{if(token===epoch){progress.value=value;phase.value=value===100?'Saving to library…':'Uploading…';}}});
    if(request.signal.aborted||token!==epoch)return;
    const entry={name:result.path.split('/').pop()??file.name,path:result.path,thumbnail:result.thumbnail};files.value=[entry,...files.value.filter(f=>f.path!==entry.path)];
    await applyFile(entry,type,token,request.signal,target);
  }catch(cause){if(!request.signal.aborted&&token===epoch)error.value=(cause as Error).message.includes('video')?(cause as Error).message:'Could not upload this background. Check your connection and try again.';}finally{if(token===epoch){busy.value=false;phase.value='';}}
}
</script>
<template>
  <section class="lyrics-background-section">
    <header><b>Background</b><small>This scene</small></header>
    <Popover v-model:open="open">
      <PopoverTrigger as-child><button class="lyrics-background-trigger" aria-label="Edit lyrics background" :title="filename" :disabled="locked"><span class="lyrics-background-swatch" :class="{'is-transparent':savedKind()==='none'}" :style="{backgroundColor:layer.background}"><img v-if="poster" :src="poster" alt="" /><Film v-else-if="media?.kind==='video'" :size="16" /></span><span><b :title="filename">{{filename}}</b><small>{{media?`${media.kind==='video'?'Video':'Image'} · ${media.fit==='cover'?'Fill':'Fit'}`:'Background'}}</small></span><ChevronDown :size="14" /></button></PopoverTrigger>
      <PopoverContent side="left" align="start" :side-offset="12" :collision-padding="12" class="lyrics-background-popover" aria-label="Lyrics background settings" @keydown.space.stop>
        <header><b>Background</b><button class="s-icon" aria-label="Close background settings" @click="open=false"><X :size="15" /></button></header>
        <fieldset :disabled="locked" class="lyrics-background-fields">
          <div class="lyrics-background-types" role="group" aria-label="Background type"><button v-for="type in (['none','color','image','video'] as const)" :key="type" :aria-pressed="kind===type" @click="changeType(type)">{{type[0].toUpperCase()+type.slice(1)}}</button></div>
          <p v-if="kind==='none'" class="lyrics-background-note"><Layers :size="15" />Transparent. Shows the layers underneath.</p>
          <label v-else-if="kind==='color'" class="studio-field color-field">Color<StudioPropertyInput type="color" live :identity="identity" :pending="!!studio.saving" :value="layer.background.slice(0,7)" @commit="(value,target)=>patch({background:value,mediaBackground:null},target)" /></label>
          <template v-else>
            <div v-if="hasMedia" class="lyrics-background-preview"><img v-if="poster" :src="poster" alt="Selected background" /><Film v-else-if="kind==='video'" :size="30" /><ImageIcon v-else :size="30" /><span>{{kind==='video'?'Video · Silent':'Image'}}</span></div>
            <div v-if="hasMedia" class="lyrics-background-file"><b :title="filename">{{filename}}</b><button class="s-icon" aria-label="Remove background" @click="changeType('none')"><Trash2 :size="14" /></button></div>
            <div class="lyrics-background-actions"><button class="s-button" :disabled="busy" @click="choosing=!choosing"><FolderOpen :size="14" />Choose media</button><button class="s-button" :disabled="busy" @click="fileInput?.click()"><Upload :size="14" />Upload</button><input ref="fileInput" type="file" :accept="mediaAccept.image+','+mediaAccept.video" aria-label="Upload lyrics background" class="lyrics-background-file-input" :disabled="busy||locked" @change="upload" /></div>
            <div v-if="choosing||!hasMedia" class="lyrics-background-library"><span v-if="loading" role="status"><LoaderCircle class="w-spin" :size="15" />Loading backgrounds…</span><p v-else-if="!available.length" class="lyrics-background-note">No {{kind==='video'?'videos':'images'}} yet. Upload one to get started.</p><div v-else class="lyrics-background-grid"><button v-for="file in available" :key="file.path" :disabled="busy" :title="mediaDisplayName(file.name)" :aria-label="'Use background '+mediaDisplayName(file.name)" :aria-pressed="media?.url===file.path" @click="choose(file)"><img v-if="thumb(file)" :src="thumb(file)" loading="lazy" decoding="async" alt="" /><Film v-else :size="24" /><span>{{mediaDisplayName(file.name)}}</span></button></div></div>
            <template v-if="hasMedia"><label class="lyrics-background-property">Scale<select aria-label="Background fit" :value="media!.fit" @change="mediaSetting({fit:($event.target as HTMLSelectElement).value as 'cover'|'contain'})"><option value="cover">Fill</option><option value="contain">Fit</option></select></label><label class="studio-field">Dim background <span>{{Math.round(media!.dim*100)}}%</span><StudioPropertyInput type="range" live min="0" max="1" step="0.01" aria-label="Dim background" :identity="identity" :pending="!!studio.saving" :value="media!.dim" @commit="(value,target)=>mediaSetting({dim:Number(value)},target)" /></label><template v-if="kind==='video'"><label class="studio-check"><input type="checkbox" aria-label="Loop background video" :checked="media!.loop" @change="mediaSetting({loop:($event.target as HTMLInputElement).checked})" />Loop video</label><p class="lyrics-background-note"><VolumeX :size="13" />Background audio is off</p></template></template>
          </template>
        </fieldset>
        <div v-if="busy" class="lyrics-background-progress" role="status"><span>{{phase||'Loading background…'}} <template v-if="phase.startsWith('Uploading')">{{progress}}%</template></span><button class="s-button" @click="cancel">Cancel</button></div>
        <p v-if="error||runtimeError" class="lyrics-background-error" role="alert">{{error||runtimeError}}</p>
      </PopoverContent>
    </Popover>
    <p v-if="runtimeError&&!open" class="lyrics-background-error" role="alert">{{runtimeError}}</p>
  </section>
</template>
<style scoped>
.lyrics-background-section{min-width:0;max-width:100%;border-top:1px solid var(--border-hair);padding:15px 0}.lyrics-background-section>header,.lyrics-background-popover>header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;font-size:12px}.lyrics-background-section>header small{font-size:10px;color:var(--text-subtle)}
.lyrics-background-trigger{width:100%;max-width:100%;min-width:0;overflow:hidden;display:flex;align-items:center;gap:10px;border:1px solid var(--border-hair);border-radius:7px;padding:9px;background:var(--surface-2);text-align:left;color:var(--text-primary)}.lyrics-background-trigger>span:nth-child(2){flex:1 1 0%;min-width:0}.lyrics-background-trigger b{display:block;font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lyrics-background-trigger small{display:block;font-size:10px;color:var(--text-subtle);margin-top:3px}.lyrics-background-swatch{width:34px;height:34px;border-radius:4px;overflow:hidden;display:grid;place-items:center;flex-shrink:0}.lyrics-background-swatch img{width:100%;height:100%;object-fit:cover}.is-transparent{background-image:conic-gradient(#ffffff14 25%,transparent 0 50%,#ffffff14 0 75%,transparent 0);background-size:12px 12px}
:global([data-slot="popover-content"].lyrics-background-popover.panel){width:300px;max-width:calc(100vw - 24px);max-height:min(720px,var(--reka-popover-content-available-height,calc(100dvh - 24px)));overscroll-behavior:contain;overflow-y:auto;background:var(--surface-1);border:1px solid var(--border-glow);border-radius:10px;padding:16px;box-shadow:0 16px 48px #0008;gap:0;color:var(--text-primary)}.lyrics-background-fields{border:0;padding:0;margin:0;min-width:0}.lyrics-background-types{display:flex;gap:3px;background:var(--surface-0,#111215);border-radius:6px;padding:3px;margin-bottom:14px}.lyrics-background-types button{flex:1;min-width:0;padding:7px 3px;font-size:11px;border-radius:4px;color:var(--text-muted)}.lyrics-background-types button[aria-pressed=true]{color:var(--text-primary);background:var(--surface-3)}.lyrics-background-preview{aspect-ratio:16/9;border-radius:6px;background:var(--surface-2);display:grid;place-items:center;position:relative;overflow:hidden;color:var(--text-subtle)}.lyrics-background-preview img{width:100%;height:100%;object-fit:cover}.lyrics-background-preview>span{position:absolute;bottom:7px;left:7px;border-radius:4px;padding:3px 6px;background:#000a;color:#fff;font-size:10px}.lyrics-background-file{min-width:0;max-width:100%;display:flex;align-items:center;gap:8px;margin:10px 0}.lyrics-background-file b{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:500}.lyrics-background-actions{display:flex;gap:6px;margin:12px 0}.lyrics-background-actions .s-button{flex:1;justify-content:center;font-size:11px}.lyrics-background-file-input{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.lyrics-background-grid{min-width:0;max-width:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;max-height:200px;overflow:auto;margin:12px 0}.lyrics-background-grid button{min-width:0;border:1px solid var(--border-hair);border-radius:6px;padding:5px;text-align:left}.lyrics-background-grid button[aria-pressed=true]{border-color:var(--accent)}.lyrics-background-grid img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:3px}.lyrics-background-grid span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;margin-top:5px}.lyrics-background-property{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;margin:16px 0;color:var(--text-muted)}.lyrics-background-property select{width:110px;padding:7px;background:var(--surface-2);color:var(--text-primary);border-radius:5px}.lyrics-background-note{display:flex;align-items:center;gap:7px;color:var(--text-subtle);font-size:11px;line-height:1.6;margin:12px 0}.lyrics-background-error{font-size:11px;line-height:1.5;color:var(--warning,#e8b59b);margin-top:12px}.lyrics-background-progress{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;margin-top:12px}.lyrics-background-fields:disabled{opacity:.5}
.lyrics-background-fields :deep(input[type="range"]){appearance:none;height:4px;border-radius:4px;background:#ffffff24;padding:0;accent-color:var(--accent);cursor:pointer}.lyrics-background-fields :deep(input[type="range"]::-webkit-slider-thumb){appearance:none;width:12px;height:12px;background:var(--accent);border:0;border-radius:50%}.lyrics-background-fields :deep(input[type="range"]::-moz-range-thumb){width:12px;height:12px;background:var(--accent);border:0;border-radius:50%}.lyrics-background-popover .studio-check input{accent-color:var(--accent)}
@media(pointer:coarse){.lyrics-background-types button,.lyrics-background-popover .s-button,.lyrics-background-popover .s-icon,.lyrics-background-popover .studio-check{min-height:44px}.lyrics-background-property select{min-height:44px;font-size:16px}}
</style>
