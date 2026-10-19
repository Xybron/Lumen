<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useFullscreen } from '@vueuse/core';
import { Clapperboard, Maximize2, Minimize2, Grid2X2 } from 'lucide-vue-next';
import { useIdentityStore } from '@/stores/identity';
import { useStudioStore } from '@/stores/studio';
import { useContentStore } from '@/stores/content';
import { sceneShortcutProblem, sceneShortcutSurfaceBlocked } from '@/lib/studio/scene-shortcuts';
import StudioMultiview from '@/components/studio/StudioMultiview.vue';
import LoginGate from '@/components/shell/LoginGate.vue';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';

const identity = useIdentityStore(), studio = useStudioStore(), content = useContentStore();
const root = ref<HTMLElement | null>(null);
const { isFullscreen, toggle } = useFullscreen(document.documentElement);
const board = ref<InstanceType<typeof StudioMultiview> | null>(null);
async function toggleFullscreen() {
  try {
    await toggle();
    await nextTick();
    board.value?.focus();
  } catch { /* The current window may not support fullscreen. */ }
}
async function init() { studio.reconnect(); await Promise.all([studio.load(), content.load()]); }
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
  <div v-else-if="!identity.ready" class="multiview-page-gate">Opening Multiview…</div>
  <div v-else-if="!identity.can('*', 'author')" class="multiview-page-gate"><h1>Studio access required</h1><p>Multiview includes private scene previews and needs Studio author access.</p><RouterLink to="/">Back to channels</RouterLink></div>
  <main v-else ref="root" class="multiview-page" data-testid="standalone-multiview" @keydown="isolateKeys">
    <WorkspaceHeader>
      <div class="multiview-page-name"><Grid2X2 :size="15" />Multiview<span :class="{ running: studio.status.state === 'running' }" /> <small>{{ studio.status.state === 'running' ? `${studio.status.fps} fps` : 'Engine offline' }}</small></div>
      <div class="multiview-page-actions"><RouterLink to="/studio"><Clapperboard :size="15" />Studio</RouterLink><button :aria-label="isFullscreen ? 'Exit Multiview fullscreen' : 'Fullscreen Multiview'" title="Fullscreen · F" @click="toggleFullscreen"><Minimize2 v-if="isFullscreen" :size="15" /><Maximize2 v-else :size="15" /><span>Fullscreen</span></button></div>
    </WorkspaceHeader>
    <StudioMultiview ref="board" standalone />
  </main>
</template>
<style scoped>
.multiview-page { display: flex; flex-direction: column; height: 100dvh; background: #101113; overflow: hidden; }
.multiview-page-name { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #d1d3d9; }
.multiview-page-name > span { width: 5px; height: 5px; border-radius: 50%; background: #71747b; margin-left: 8px; }
.multiview-page-name > span.running { background: #8fb99f; }
.multiview-page-name small { font-size: 11px; color: #83878f; font-weight: 400; }
.multiview-page-actions { margin-left: auto; display: flex; gap: 7px; }
.multiview-page-actions a, .multiview-page-actions button { display: flex; align-items: center; gap: 7px; color: #b9bdc5; border: 1px solid #ffffff16; border-radius: 7px; padding: 7px 10px; font-size: 12px; }
.multiview-page-actions a:hover, .multiview-page-actions button:hover { background: #ffffff07; color: #fff; }
.multiview-page-gate { height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #b6bac3; background: #101113; font-size: 14px; padding: 24px; text-align: center; }
.multiview-page-gate a { color: #7dd3fc; }
@media (max-width: 650px) { .multiview-page-name { font-size: 12px; } .multiview-page-name small, .multiview-page-actions button span { display: none; } .multiview-page-actions a, .multiview-page-actions button { padding: 7px; } }
</style>
