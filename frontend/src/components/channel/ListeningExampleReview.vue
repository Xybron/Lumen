<script setup lang="ts">
import {ref,computed,watch} from 'vue';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {useWorshipStore} from '@/stores/worship';
const props=withDefaults(defineProps<{channelId:string;enabled:boolean;showControls?:boolean}>(),{showControls:true}),store=useWorshipStore();
const samples=computed(()=>store.examples[props.channelId]??[]),selected=ref<any>(null),open=ref(false),busy=ref(false),error=ref('');
watch(()=>props.channelId,id=>void store.refreshListeningExamples(id).catch(()=>{}),{immediate:true});
const transcript=ref(''),reference=ref(''),speaker=ref(''),notes=ref(''),reviewed=ref(false);
function edit(sample:any){selected.value=sample;transcript.value=sample.transcript??'';reference.value=sample.reviewReference??'';speaker.value=sample.speaker??'';notes.value=sample.notes??'';reviewed.value=false;error.value='';open.value=true;}
async function save(){
  busy.value=true;error.value='';
  try{selected.value=await store.reviewListeningExample(props.channelId,selected.value.id,{transcript:transcript.value,reference:reference.value,speaker:speaker.value,notes:notes.value,reviewed:reviewed.value});open.value=false;}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}
}
async function remove(){busy.value=true;try{await store.deleteListeningExample(props.channelId,selected.value.id);open.value=false;}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
defineExpose({edit});
</script>
<template>
  <div v-if="showControls&&(enabled||samples.length)" class="listening-examples">
    <button v-if="enabled" class="w-button" :disabled="store.exampleBusy[channelId]" @click="store.saveListeningExample(channelId)">{{store.exampleBusy[channelId]?'Saving…':'Save last 12 seconds for review'}}</button>
    <small v-if="enabled">Saves a short audio clip locally only when clicked. No automatic training.</small>
    <details v-if="samples.length"><summary>Saved listening examples ({{samples.length}})</summary><button v-for="sample in samples" :key="sample.id" class="w-button" @click="edit(sample)">{{sample.reviewed?'Reviewed':'Review'}} · {{new Date(sample.createdAt).toLocaleTimeString()}}</button></details>
  </div>
  <Dialog v-model:open="open"><DialogContent class="w-dialog"><DialogHeader><DialogTitle>Review microphone example</DialogTitle><DialogDescription>Listen to the whole clip. Correct only words you can hear. Leave uncertain clips unreviewed.</DialogDescription></DialogHeader>
    <template v-if="selected">
      <audio controls :src="`/api/worship/listening/examples/${selected.id}/audio`" style="width:100%" />
      <p class="w-muted">Machine transcript: {{selected.asrTranscript||'(No words recognised)'}}</p>
      <label class="w-label">Speaker name or label<input v-model="speaker" aria-label="Example speaker" class="w-input" maxlength="100" /></label>
      <label class="w-label">Words actually spoken in this clip<textarea v-model="transcript" aria-label="Corrected transcript" class="w-input" rows="4" maxlength="12000" /></label>
      <label class="w-label">Expected scripture references<input v-model="reference" aria-label="Expected scripture references" class="w-input" placeholder="John 3:16; leave blank if none" maxlength="300" /></label>
      <label class="w-label">Conditions or uncertainty<textarea v-model="notes" aria-label="Example notes" class="w-input" placeholder="Singing, another speaker, unclear words, microphone used…" maxlength="2000" /></label>
      <label><input v-model="reviewed" type="checkbox" /> I listened to the entire clip and checked its words and references.</label>
      <p v-if="error" role="alert" class="w-error">{{error}}</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap"><button class="w-button primary" :disabled="busy||!speaker.trim()" @click="save">Save {{reviewed?'reviewed example':'draft'}}</button><a class="w-button" :href="`/api/worship/listening/examples/${selected.id}`" download>Download labels</a><button class="w-button" :disabled="busy" @click="remove">Delete example</button></div>
    </template>
  </DialogContent></Dialog>
</template>
<style scoped>.listening-examples{display:flex;flex-direction:column;gap:8px;padding:10px 0}.listening-examples small{color:var(--muted-foreground);font-size:11px}.listening-examples details button{margin:4px}.w-label input,.w-label textarea{display:block;width:100%;margin-top:5px}</style>
