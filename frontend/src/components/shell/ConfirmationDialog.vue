<script setup lang="ts">
import { computed,nextTick,ref,shallowRef,watch } from 'vue';
import { useRoute } from 'vue-router';
import { CircleHelp,Radio,Trash2,ShieldCheck } from 'lucide-vue-next';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { currentConfirmation,settleConfirmation } from '@/composables/useConfirmation';
import { useIdentityStore } from '@/stores/identity';

const route=useRoute(),identity=useIdentityStore(),cancelButton=ref<HTMLButtonElement>();
// Retain text through the closing animation rather than removing the accessible
// title/description while the portaled modal is still on screen.
const displayed=shallowRef(currentConfirmation.value);
const icon=computed(()=>displayed.value?.tone==='danger'?Trash2:displayed.value?.tone==='live'?Radio:CircleHelp);
let originRoute=route.fullPath;
watch(currentConfirmation,value=>{if(value){displayed.value=value;originRoute=route.fullPath;}},{flush:'sync'});
function close(accepted=false){if(displayed.value)settleConfirmation(displayed.value.id,accepted);}
watch(()=>route.fullPath,()=>close());
watch(()=>identity.me?.id,()=>close());
function opening(event:Event){event.preventDefault();cancelButton.value?.focus({preventScroll:true});}
function closing(event:Event){
  event.preventDefault();const target=displayed.value?.returnFocus,sourceRoute=originRoute;
  void nextTick(()=>requestAnimationFrame(()=>{
    if(!currentConfirmation.value&&route.fullPath===sourceRoute&&target?.isConnected&&!target.closest('[inert],[aria-hidden="true"]'))target.focus({preventScroll:true});
  }));
}
function keys(event:KeyboardEvent){
  // App publication chords must never become native button activation here.
  if(event.key==='Enter'&&(event.ctrlKey||event.metaKey||event.altKey)||event.isComposing){event.preventDefault();event.stopPropagation();}
}
</script>

<template>
  <Dialog :open="!!currentConfirmation" @update:open="open=>{if(!open)close();}">
    <DialogContent v-if="displayed" :key="displayed.id" class="lumen-confirmation" :class="`confirmation-${displayed.tone??'default'}`" :show-close-button="false" @open-auto-focus="opening" @close-auto-focus="closing" @keydown.capture="keys">
      <div class="confirmation-heading"><span class="confirmation-icon"><component :is="icon" :size="19" :stroke-width="1.6" /></span><DialogHeader><DialogTitle>{{displayed.title}}</DialogTitle><DialogDescription>{{displayed.description}}</DialogDescription></DialogHeader></div>
      <ul v-if="displayed.details?.length" class="confirmation-details"><li v-for="detail in displayed.details" :key="detail">{{detail}}</li></ul>
      <p v-if="displayed.note" class="confirmation-note"><ShieldCheck v-if="displayed.tone==='live'" :size="14" /><span>{{displayed.note}}</span></p>
      <div class="confirmation-actions"><button ref="cancelButton" type="button" class="confirmation-button confirmation-cancel" @click="close()">{{displayed.cancelLabel??'Cancel'}}</button><button type="button" class="confirmation-button confirmation-accept" :disabled="currentConfirmation?.id!==displayed.id" @click="close(true)">{{displayed.confirmLabel}}</button></div>
    </DialogContent>
  </Dialog>
</template>
