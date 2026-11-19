<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Clapperboard, Maximize2, Minimize2, Grid2X2 } from 'lucide-vue-next';
import { useIdentityStore } from '@/stores/identity';
import { useStudioStore } from '@/stores/studio';
import { useContentStore } from '@/stores/content';
import { sceneShortcutProblem, sceneShortcutSurfaceBlocked } from '@/lib/studio/scene-shortcuts';
import { Skeleton, LoadingSkeleton } from '@/components/ui/skeleton';
import StudioMultiview from '@/components/studio/StudioMultiview.vue';
import LoginGate from '@/components/shell/LoginGate.vue';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';
import { useAppFullscreen } from '@/composables/useAppFullscreen';

const identity = useIdentityStore(), studio = useStudioStore(), content = useContentStore();
const root = ref<HTMLElement | null>(null);
const opening = ref(true);
const { isFullscreen, toggle } = useAppFullscreen();
const board = ref<InstanceType<typeof StudioMultiview> | null>(null);
async function toggleFullscreen() {
  try {
    await toggle();
    await nextTick();
    board.value?.focus();
  } catch { /* The current window may not support fullscreen. */ }
}
async function init() {
  try { await Promise.all([studio.load(), content.load()]); }
  finally { opening.value = false; }
}
onMounted(async () => { await identity.load(); if (identity.isAuthenticated && identity.can('*', 'author')) await init(); });
watch(() => identity.isAuthenticated, authenticated => { if (authenticated && identity.ready && identity.can('*', 'author')) void init(); });
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
    sceneShortcutSurfaceBlocked(event.target instanceof Element ? event.target : null, document, false)) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); void toggleFullscreen(); }
}
function isolateKeys(event: KeyboardEvent) { if (sceneShortcutProblem(event) !== null) event.stopPropagation(); }
onMounted(() => window.addEventListener('keydown', keydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', keydown, true));
</script>
<template>
  <LoginGate v-if="identity.ready && !identity.isAuthenticated" />
  <div v-else-if="identity.ready && !identity.can('*', 'author')" class="multiview-page-gate"><h1>Studio access required</h1><p>Multiview includes private scene previews and needs Studio author access.</p><RouterLink to="/">Back to channels</RouterLink></div>
  <main v-else ref="root" class="multiview-page" data-testid="standalone-multiview" @keydown="isolateKeys">
    <WorkspaceHeader>
      <div class="multiview-page-name"><Grid2X2 :size="15" />Multiview<span :class="{ running: studio.status.state === 'running' }" /> <Skeleton v-if="!identity.ready || opening" class="multiview-loading-status" :width="76" :height="9" /><small v-else>{{ studio.status.state === 'running' ? `${studio.status.fps} fps` : 'Engine offline' }}</small></div>
      <div class="multiview-page-actions"><RouterLink to="/studio"><Clapperboard :size="15" />Studio</RouterLink><button :aria-label="isFullscreen ? 'Exit Multiview fullscreen' : 'Fullscreen Multiview'" title="Fullscreen · F" @click="toggleFullscreen"><Minimize2 v-if="isFullscreen" :size="15" /><Maximize2 v-else :size="15" /><span>Fullscreen</span></button></div>
    </WorkspaceHeader>
    <LoadingSkeleton v-if="!identity.ready || opening" class="multiview-loading" label="Opening Multiview">
      <div class="multiview-loading-buses" aria-hidden="true">
        <div v-for="n in 2" :key="n" class="multiview-loading-bus"><div class="multiview-loading-label"><Skeleton :width="70" :height="10" /><Skeleton width="28%" :height="9" /></div><Skeleton class="multiview-loading-monitor" height="auto" :radius="6" /></div>
        <div class="multiview-loading-controls"><Skeleton :height="38" /><Skeleton :height="38" /><Skeleton :height="30" /></div>
      </div>
      <div class="multiview-loading-label multiview-loading-heading" aria-hidden="true"><Skeleton :width="92" :height="11" /><Skeleton :width="140" :height="9" /></div>
      <div class="multiview-loading-scenes" aria-hidden="true"><div v-for="n in 8" :key="n" class="multiview-loading-scene"><Skeleton class="multiview-loading-thumbnail" height="auto" :radius="6" /><Skeleton :width="n%2 ? '55%' : '72%'" :height="9" /></div></div>
    </LoadingSkeleton>
    <StudioMultiview v-else ref="board" standalone />
  </main>
</template>
<style scoped>
.multiview-loading { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 16px; padding: 16px; overflow: hidden; }
.multiview-loading-buses { display: grid; grid-template-columns: minmax(0,1fr) 96px minmax(0,1fr); gap: 12px; align-items: center; }
.multiview-loading-bus { min-width: 0; }
.multiview-loading-bus:nth-child(2) { grid-column: 3; }
.multiview-loading-label { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.multiview-loading-monitor { aspect-ratio: 16 / 9; max-height: 48vh; }
.multiview-loading-controls { grid-column: 2; grid-row: 1; display: flex; flex-direction: column; gap: 10px; }
.multiview-loading-heading { margin: 0; padding-top: 14px; border-top: 1px solid var(--border-hair); }
.multiview-loading-scenes { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 16px 12px; overflow: hidden; }
.multiview-loading-scene { display: flex; flex-direction: column; min-width: 0; gap: 9px; }
.multiview-loading-thumbnail { aspect-ratio: 16 / 9; }
@media (max-width: 759px) {
  .multiview-loading { padding: 12px; gap: 12px; }
  .multiview-loading-buses { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
  .multiview-loading-bus:nth-child(2) { grid-column: 2; }
  .multiview-loading-controls { grid-column: 1/-1; grid-row: 2; flex-direction: row; }
  .multiview-loading-controls > :deep(.skeleton) { width: 84px; }
  .multiview-loading-scenes { grid-template-columns: repeat(2,minmax(0,1fr)); }
}

.multiview-page { display: flex; flex-direction: column; height: 100dvh; background: #101113; overflow: hidden; }
.multiview-page-name { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #d1d3d9; }
.multiview-page-name > span:not(.multiview-loading-status) { width: 5px; height: 5px; border-radius: 50%; background: #71747b; margin-left: 8px; }
.multiview-page-name > span.running { background: #8fb99f; }
.multiview-page-name small { font-size: 11px; color: #83878f; font-weight: 400; }
.multiview-page-actions { margin-left: auto; display: flex; gap: 7px; }
.multiview-page-actions a, .multiview-page-actions button { display: flex; align-items: center; gap: 7px; color: #b9bdc5; border: 1px solid #ffffff16; border-radius: 7px; padding: 7px 10px; font-size: 12px; }
.multiview-page-actions a:hover, .multiview-page-actions button:hover { background: #ffffff07; color: #fff; }
.multiview-page-gate { height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #b6bac3; background: #101113; font-size: 14px; padding: 24px; text-align: center; }
.multiview-page-gate a { color: #7dd3fc; }
@media (max-width: 650px) { .multiview-page-name { font-size: 12px; } .multiview-page-name small, .multiview-loading-status, .multiview-page-actions button span { display: none; } .multiview-page-actions a, .multiview-page-actions button { padding: 7px; } }
</style>
