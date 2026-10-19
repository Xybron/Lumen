<script setup lang="ts">
import { ref } from 'vue';
import { Download, Check, Upload, BookOpen } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useWorshipStore } from '@/stores/worship';
import { worshipRequest } from '@/lib/worship/api';
const open=defineModel<boolean>('open');
const store=useWorshipStore(),file=ref<File|null>(null),confirmed=ref(false),replace=ref(false),busy=ref(false),error=ref(''),success=ref('');
function choose(e:Event){file.value=(e.target as HTMLInputElement).files?.[0]??null;error.value='';success.value='';}
async function importFile(){
  if(!file.value||!confirmed.value)return;busy.value=true;error.value='';success.value='';
  try{if(file.value.size>20*1024*1024)throw new Error('The library file must be smaller than 20 MB.');const input=JSON.parse(await file.value.text());
    await worshipRequest('/versions/import',{method:'POST',body:JSON.stringify({...input,replace:replace.value})});await store.refreshVersions();success.value='Edition imported and indexed for offline search.';
  }catch(e){error.value=(e as Error).message;}finally{busy.value=false;}
}
function template(){const body={version:{id:'NIV',name:'New International Version',language:'en',attribution:'Include the required publisher copyright notice here.'},verses:[{book:43,chapter:3,verse:16,text:'Replace with the verse text from your authorised digital edition.'}]};const url=URL.createObjectURL(new Blob([JSON.stringify(body,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='lumen-bible-format.json';a.click();URL.revokeObjectURL(url);}
</script>
<template>
  <Dialog v-model:open="open"><DialogContent class="w-dialog max-w-2xl"><DialogHeader><DialogTitle>Bible library</DialogTitle><DialogDescription>Exact texts, indexed on this station. No generated or substituted verses.</DialogDescription></DialogHeader>
    <div class="w-editions"><div v-for="version in store.versions" :key="version.id" class="w-edition"><BookOpen :size="18" /><div><b>{{version.id}}</b><span>{{version.name}}</span></div><small :class="{installed:version.installed}"><Check v-if="version.installed" :size="12" />{{version.installed?`${version.verseCount.toLocaleString()} verses`:'Import required'}}</small></div></div>
    <div class="w-import"><h3>Import an authorised edition</h3><p>KJV is included. NKJV, NIV, NLT, Amplified, Good News and TPT require a digital text you have permission to use. An import can contain a complete edition or a licensed subset; unavailable verses are never filled in.</p>
      <button class="w-button" @click="template"><Download :size="14" />Download JSON format</button><small>Book IDs follow the 66-book order: Genesis = 1, John = 43, Revelation = 66. Include publisher attribution.</small>
      <input aria-label="Bible JSON file" type="file" accept=".json,application/json" @change="choose" />
      <label class="w-check"><input v-model="confirmed" type="checkbox" />I have permission to use and display this text.</label>
      <label class="w-check"><input v-model="replace" type="checkbox" />Replace the installed edition with the same ID.</label>
      <p v-if="error" class="w-error" role="alert">{{error}}</p><p v-if="success" class="w-success" role="status">{{success}}</p>
      <button class="w-button primary" :disabled="!file||!confirmed||busy" @click="importFile"><Upload :size="14" />{{busy?'Indexing edition…':'Import edition'}}</button>
    </div>
  </DialogContent></Dialog>
</template>
