<script setup lang="ts">
import { Volume2, VolumeX } from 'lucide-vue-next';
import { useStudioStore } from '@/stores/studio';
import StudioPropertyInput from './StudioPropertyInput.vue';

const studio = useStudioStore();
function run(promise: Promise<unknown>) { void promise.catch(() => {}); }
function volume(value: string) {
  if (studio.saving) return;
  const amount = Number(value);
  run(studio.edit(draft => { draft.masterVolume = amount; }));
}
function toggleMute() {
  if (!studio.saving) run(studio.edit(draft => { draft.masterMuted = !draft.masterMuted; }));
}
</script>

<template>
  <div v-if="studio.state" class="master-strip" aria-label="Output audio" data-testid="output-audio-control">
    <Volume2 :size="13" aria-hidden="true" /><b>Output</b><div class="audio-meter" role="meter" aria-label="Final output audio level" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round((studio.status.levels.master ?? 0) * 100)"><span :style="{ width: (studio.status.levels.master ?? 0) * 100 + '%' }" /></div>
    <StudioPropertyInput type="range" identity="master-volume" aria-label="Master volume" min="0" max="1" step="0.01" :value="studio.state.masterVolume" :pending="!!studio.saving" :disabled="!!studio.saving" @commit="volume" />
    <button class="s-icon" :class="{ muted: studio.state.masterMuted }" aria-label="Toggle master mute" :aria-pressed="studio.state.masterMuted" :disabled="!!studio.saving" :title="studio.state.masterMuted ? 'Unmute final output' : 'Mute final output'" @click="toggleMute"><VolumeX v-if="studio.state.masterMuted" :size="14" /><Volume2 v-else :size="14" /></button>
  </div>
</template>

<style scoped>
.master-strip { flex-shrink: 0; min-width: 0; }
.master-strip > svg { flex-shrink: 0; }
.master-strip .audio-meter { min-width: 20px; }
.master-strip > input { width: 64px; flex-shrink: 0; }
</style>
