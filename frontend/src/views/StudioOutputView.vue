<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useFullscreen, useIdle, useEventListener, useWakeLock } from '@vueuse/core';
import { Volume2, Maximize } from 'lucide-vue-next';
import StudioMonitor from '@/components/studio/StudioMonitor.vue';
import { studioApi } from '@/lib/studio/api';
import { requestDisplayFullscreen } from '@/lib/studio/display-outputs';
const route = useRoute();
const outputId = computed(() => String(route.params.outputId));
const root = ref<HTMLElement | null>(null), ready = ref(false), audible = ref(false), name = ref('Lumen output');
const isProgram = computed(() => outputId.value === 'program');
const fullscreenMessage = ref('');
const outputName = computed(() => isProgram.value ? 'Program' : name.value);
const { exit, isFullscreen } = useFullscreen(root), { idle } = useIdle(2500);
const wake = useWakeLock();
async function fullscreen() {
  if (isFullscreen.value) { await exit(); return; }
  if (root.value) { const result = await requestDisplayFullscreen(root.value); fullscreenMessage.value = result.message; }
}
useEventListener(window, 'keydown', e => { if (e.key.toLowerCase() === 'f') { e.preventDefault(); void fullscreen(); } });
onMounted(async () => {
  await wake.request('screen').catch(() => {});
  if (!isProgram.value) {
    const state = await studioApi.get().catch(() => null);
    if (state) name.value = state.outputs.find(o => o.id === outputId.value)?.name ?? 'Output not found';
  }
});
onBeforeUnmount(() => { void wake.release(); });
</script>
<template>
  <div ref="root" class="production-output" :class="{ 'cursor-hidden': idle }" @dblclick="fullscreen">
    <StudioMonitor :output-id="outputId" :audible="audible" @ready="ready = $event" @blocked="audible = false" />
    <div v-if="!ready" class="output-wait"><span>{{ outputName }}</span><small>{{ isProgram ? 'Waiting for the live Program feed' : 'Waiting for the production engine' }}</small></div>
    <div v-show="!idle" class="output-controls"><span v-if="fullscreenMessage" role="status">{{ fullscreenMessage }}</span><button @click="audible = !audible"><Volume2 :size="16" />{{ audible ? 'Mute output' : 'Enable sound' }}</button><button @click="fullscreen"><Maximize :size="16" /> Fullscreen</button></div>
  </div>
</template>
<style scoped>
.production-output { position: relative; height: 100vh; width: 100vw; background: #000; }
.output-wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: #8b949e; }
.output-wait small { color: #505961; }
.output-controls { position: absolute; bottom: 22px; right: 22px; display: flex; gap: 8px; }
.output-controls button { background: #1c2228dd; border: 1px solid #ffffff22; border-radius: 9px; color: #d5dbe1; padding: 10px 14px; display: flex; gap: 8px; font-size: 12px; align-items: center; }
</style>
