<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { WorshipTheme } from '../../../../shared/worship';
const props=defineProps<{ text:string; reference?:string; attribution?:string; theme:WorshipTheme }>();
const root=ref<HTMLElement>(),body=ref<HTMLElement>(),fontSize=ref(32),unit=ref(1);
let observer:ResizeObserver|undefined;
async function fit(){
  await nextTick();if(!root.value||!body.value)return;
  const width=root.value.clientWidth,height=root.value.clientHeight;
  unit.value=width/1920;
  let low=1,high=width*({sm:.026,md:.031,lg:.038,xl:.046,'2xl':.054}[props.theme.size]);
  const available=height*.65;
  for(let i=0;i<12;i++){const mid=(low+high)/2;body.value.style.fontSize=`${mid}px`;if(body.value.scrollHeight<=available&&body.value.scrollWidth<=body.value.clientWidth+1)low=mid;else high=mid;}
  fontSize.value=low;body.value.style.fontSize=`${low}px`;
}
watch(()=>[props.text,props.reference,props.attribution,props.theme],fit,{deep:true});
onMounted(()=>{observer=new ResizeObserver(fit);if(root.value)observer.observe(root.value);void fit();});
onBeforeUnmount(()=>observer?.disconnect());
</script>
<template>
  <div ref="root" class="cue-canvas" :style="{background:theme.background,color:theme.color,textAlign:theme.align}">
    <div class="cue-body-wrap"><div ref="body" class="cue-body" :style="{fontSize:fontSize+'px'}">{{ text }}</div></div>
    <div class="cue-reference" :style="{fontSize:Math.max(1,32*unit)+'px'}">{{ reference }}</div>
    <div class="cue-attribution" :style="{fontSize:Math.max(1,18*unit)+'px'}">{{ attribution }}</div>
  </div>
</template>
<style scoped>
.cue-canvas{position:absolute;inset:0;overflow:hidden}.cue-body-wrap{position:absolute;inset:9% 8% 26%;display:flex;align-items:center}.cue-body{width:100%;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.25;font-weight:500;letter-spacing:-.025em}.cue-reference{position:absolute;left:8%;right:8%;bottom:14%;font-weight:500;opacity:.85}.cue-attribution{position:absolute;left:8%;right:8%;bottom:4%;max-height:8%;overflow:hidden;line-height:1.2;opacity:.6}
</style>
