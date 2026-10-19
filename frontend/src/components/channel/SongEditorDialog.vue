<script setup lang="ts">
import { ref, watch } from 'vue';
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { worshipRequest } from '@/lib/worship/api';
import type { Song,SongSection } from '../../../../shared/worship';
const props=defineProps<{song:Song|null;initialSections?:SongSection[]}>(),open=defineModel<boolean>('open');
const emit=defineEmits<{saved:[song:Song]}>();
const title=ref(''),author=ref(''),copyright=ref(''),sections=ref<SongSection[]>([]),busy=ref(false),error=ref('');
function add(){sections.value.push({id:crypto.randomUUID(),label:sections.value.length?'Chorus':'Verse 1',text:''});}
watch(open,value=>{if(value){title.value=props.song?.title??'';author.value=props.song?.author??'';copyright.value=props.song?.copyright??'';sections.value=JSON.parse(JSON.stringify(props.song?.sections??props.initialSections??[]));if(!sections.value.length)add();error.value='';}});
function move(i:number,d:number){const to=i+d;if(to<0||to>=sections.value.length)return;const [s]=sections.value.splice(i,1);sections.value.splice(to,0,s);}
async function save(){busy.value=true;error.value='';try{const song=await worshipRequest<Song>('/songs',{method:'POST',body:JSON.stringify({...(props.song?{id:props.song.id,revision:props.song.revision}:{}),title:title.value,author:author.value,copyright:copyright.value,sections:sections.value})});emit('saved',song);open.value=false;}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
</script>
<template>
  <Dialog v-model:open="open"><DialogContent class="w-dialog max-w-2xl"><DialogHeader><DialogTitle>{{song?'Edit song':'Add a song'}}</DialogTitle><DialogDescription>Keep each section to a few lines for clear projection. Use lyrics you have permission to display.</DialogDescription></DialogHeader>
    <form class="w-song-form" @submit.prevent="save"><label>Song title<input v-model="title" required maxlength="160" placeholder="Song title" /></label><div class="w-form-pair"><label>Writer / artist<input v-model="author" maxlength="300" /></label><label>Copyright / licence credit<input v-model="copyright" maxlength="1500" /></label></div>
      <div v-for="(section,i) in sections" :key="section.id" class="w-song-section"><div><input v-model="section.label" required maxlength="80" :aria-label="`Section ${i+1} label`" /><button type="button" class="w-icon" :disabled="i===0" aria-label="Move section up" @click="move(i,-1)"><ArrowUp :size="14" /></button><button type="button" class="w-icon" :disabled="i===sections.length-1" aria-label="Move section down" @click="move(i,1)"><ArrowDown :size="14" /></button><button type="button" class="w-icon" :disabled="sections.length===1" aria-label="Delete section" @click="sections.splice(i,1)"><Trash2 :size="14" /></button></div><textarea v-model="section.text" required maxlength="4000" rows="4" :aria-label="`Section ${i+1} lyrics`" placeholder="Paste or type the lyrics for this section…" /></div>
      <button type="button" class="w-button" :disabled="sections.length>=100" @click="add"><Plus :size="14" />Add section</button><p v-if="error" class="w-error" role="alert">{{error}}</p><button class="w-button primary" :disabled="busy">{{busy?'Saving…':'Save song'}}</button>
    </form>
  </DialogContent></Dialog>
</template>
