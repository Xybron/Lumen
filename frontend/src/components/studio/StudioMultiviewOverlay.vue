<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useFullscreen } from '@vueuse/core';
import { Grid2X2, GripVertical, ArrowUpRight, Maximize2, Minimize2, Minus, RotateCcw, MoveDiagonal2 } from 'lucide-vue-next';
import { useMultiview, useMultiviewWindow } from '@/composables/useMultiview';
import StudioMultiview from '@/components/studio/StudioMultiview.vue';
import { sceneShortcutProblem } from '@/lib/studio/scene-shortcuts';

const route = useRoute(), multiview = useMultiview();
const { element, style, dragging, resizing, begin, move, finish, cancel, reset, keyboard } = useMultiviewWindow();
const { isFullscreen, toggle, exit } = useFullscreen(element);
const board = ref<InstanceType<typeof StudioMultiview> | null>(null);
async function toggleFullscreen() {
  try {
    await toggle();
    await nextTick();
    board.value?.focus();
  } catch { /* The current window may not support fullscreen. */ }
}
async function collapse(restoreFocus = true) {
  if (isFullscreen.value) await exit().catch(() => {});
  multiview.collapse();
  if (restoreFocus) { await nextTick(); document.querySelector<HTMLButtonElement>('[data-multiview-trigger]')?.focus({ preventScroll: true }); }
}
watch(() => route.name, (name, previous) => {
  if (name === 'studio' && previous !== 'studio') void collapse(false);
}, { immediate: true });
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing ||
    (event.target as Element | null)?.closest('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"]')) return;
  if (event.key === 'Escape' && (dragging.value || resizing.value)) { event.preventDefault(); event.stopPropagation(); cancel(); }
  else if (event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); void toggleFullscreen(); }
  else if (event.key === 'Escape' && !isFullscreen.value) { event.preventDefault(); event.stopPropagation(); void collapse(); }
}
function isolateKeys(event: KeyboardEvent) {
  // Header/root focus must not advance or publish a channel underneath this
  // window. Only explicit configured scene chords reach the global listener.
  if (sceneShortcutProblem(event) !== null) event.stopPropagation();
}
</script>
<template>
  <section v-if="multiview.open.value" ref="element" class="floating-multiview" :class="{ 'multiview-dragging': dragging, 'multiview-resizing': resizing }"
    :style="style" role="region" aria-label="Floating Multiview" tabindex="-1" data-testid="floating-multiview" @keydown.capture="keydown" @keydown="isolateKeys">
    <header class="multiview-window-header">
      <button class="multiview-window-title" aria-label="Move Multiview" title="Drag to move · Arrow keys to nudge · Home to reset"
        :disabled="isFullscreen" @pointerdown="begin($event)" @pointermove="move" @pointerup="finish" @pointercancel="cancel" @lostpointercapture="finish" @keydown="keyboard($event)" @dblclick="reset">
        <GripVertical :size="13" /><Grid2X2 :size="15" /><span>Multiview</span>
      </button>
      <span class="multiview-window-hint">Space · Cut<span>⇧ Space · Fade</span></span>
      <button class="multiview-window-action" aria-label="Reset Multiview position" title="Reset position and size" @click="reset"><RotateCcw :size="13" /></button>
      <a class="multiview-window-action" href="/studio/multiview" target="_blank" rel="noopener" aria-label="Open Multiview in new window" title="Open separate view"><ArrowUpRight :size="15" /></a>
      <button class="multiview-window-action" :aria-label="isFullscreen ? 'Exit Multiview fullscreen' : 'Fullscreen Multiview'" title="Fullscreen · F" @click="toggleFullscreen"><Minimize2 v-if="isFullscreen" :size="14" /><Maximize2 v-else :size="14" /></button>
      <button class="multiview-window-action" aria-label="Collapse Multiview" title="Back to toolbar · Escape" @click="collapse()"><Minus :size="16" /></button>
    </header>
    <StudioMultiview ref="board" :standalone="isFullscreen" />
    <button v-if="!isFullscreen" class="multiview-window-resize" aria-label="Resize Multiview" title="Drag to resize · Arrow keys to resize" @pointerdown="begin($event, 'resize')" @pointermove="move" @pointerup="finish" @pointercancel="cancel" @lostpointercapture="finish" @keydown="keyboard($event, true)"><MoveDiagonal2 :size="12" /></button>
  </section>
</template>
<style scoped>
.floating-multiview { position: fixed; z-index: 42; display: flex; flex-direction: column; min-width: 0; overflow: hidden; background: #151619; border: 1px solid #ffffff24; border-radius: 12px; box-shadow: 0 20px 64px #0009, 0 2px 8px #0006; outline: none; }
.floating-multiview:focus-visible { border-color: var(--accent, #7dd3fc); }
.floating-multiview:fullscreen { inset: 0 !important; width: 100vw !important; height: 100vh !important; border: 0; border-radius: 0; background: #101113; }
.floating-multiview > :deep(.studio-multiview) { flex: 1; overflow: hidden; }
.floating-multiview :deep(.multiview-scenes-scroll) { flex: 1; }
.multiview-window-header { display: flex; align-items: center; gap: 2px; min-height: 40px; flex-shrink: 0; padding: 0 7px; border-bottom: 1px solid #ffffff0d; }
.multiview-window-title { display: flex; align-items: center; gap: 7px; color: #e8e9eb; font-size: 12px; font-weight: 600; min-width: 0; touch-action: none; cursor: grab; padding: 9px 4px; }
.multiview-window-title > svg:first-child { color: #74777e; }
.multiview-window-title:disabled { cursor: default; }
.multiview-dragging, .multiview-dragging .multiview-window-title { cursor: grabbing; user-select: none; }
.multiview-window-hint { margin: 0 auto 0 10px; display: flex; gap: 10px; font-size: 9px; color: #73767d; white-space: nowrap; }
.multiview-window-action { display: grid; place-items: center; width: 28px; height: 28px; flex-shrink: 0; border-radius: 5px; color: #a7aab1; }
.multiview-window-action:hover { background: #ffffff0b; color: #eef0f3; }
.multiview-window-title:focus-visible, .multiview-window-action:focus-visible, .multiview-window-resize:focus-visible { outline: 2px solid var(--accent, #7dd3fc); outline-offset: -2px; }
.multiview-window-resize { position: absolute; right: 0; bottom: 0; display: grid; place-items: center; width: 18px; height: 18px; color: #777b83; cursor: nwse-resize; touch-action: none; background: #1c1e22c9; border-radius: 5px 0 0; }
.multiview-resizing { user-select: none; }
@media (max-width: 650px) { .multiview-window-hint { font-size: 0; } .multiview-window-hint span { display: none; } }
</style>
