<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import { ArrowRightLeft, Circle, Layers, VolumeX } from 'lucide-vue-next';
import StudioMonitor from './StudioMonitor.vue';
import ScenePoster from './ScenePoster.vue';
import MultiviewAtlas from './MultiviewAtlas.vue';
import { useStudioStore } from '@/stores/studio';
import { useIdentityStore } from '@/stores/identity';
import { useAnimationPreview } from '@/composables/useAnimationPreview';
import { useSceneShortcutPreferences } from '@/composables/useSceneShortcuts';
import { useStudioTransitions } from '@/composables/useStudioTransitions';
import { sceneShortcutLabel, sceneShortcutProblem, sceneShortcutSurfaceBlocked } from '@/lib/studio/scene-shortcuts';
import { multiviewSlots } from '../../../../shared/multiview-layout';
import { multiviewDisplaySize } from '@/lib/studio/multiview-atlas';
import type { StudioScene } from '../../../../shared/production';
import '@/styles/multiview.css';

const props = withDefaults(defineProps<{ standalone?: boolean }>(), { standalone: false });

const studio = useStudioStore(), identity = useIdentityStore(), motion = useAnimationPreview();
const shortcuts = useSceneShortcutPreferences();
const { fadeDurationInput, setFadeDuration, take, canTake } = useStudioTransitions();
const board = ref<HTMLElement | null>(null);
const shelf = ref<HTMLElement | null>(null), shelfHeight = ref(0);
const boardSize = ref({ width: 0, height: 0 });
useResizeObserver(board, entries => {
  const size = entries[0]?.contentRect;
  if (size) boardSize.value = { width: size.width, height: size.height };
});
useResizeObserver(shelf, entries => { shelfHeight.value = entries[0]?.contentRect.height ?? 0; });
const centerControls = computed(() => props.standalone && boardSize.value.width >= 760);
const displayColumns = computed(() => centerControls.value ? 4 : 2);
const previewReady = ref(false), programReady = ref(false), atlasReady = ref(false);
const engineRunning = computed(() => studio.status.state === 'running');
const scenes = computed(() => studio.state?.scenes ?? []);
const slots = computed(() => multiviewSlots(scenes.value));
const displaySize = computed(() => multiviewDisplaySize(scenes.value.length, displayColumns.value));
// Keep the monitor row dominant without starving the scene shelf on unusually
// wide/short displays. Normal desktop proportions retain exact 16:9 frames;
// shorter windows contain the feed, rather than cropping or stretching it.
const monitorHeight = computed(() => {
  const width = Math.max(0, (boardSize.value.width - (centerControls.value ? 116 : 10)) / 2);
  return Math.max(0, Math.min(width * 9 / 16, Math.max(90, (boardSize.value.height - 100) * .68)));
});
const canSelect = computed(() => identity.ready && identity.isAuthenticated && identity.can('*', 'author') &&
  !!studio.state && !studio.saving && !studio.engineBusy && motion.elapsedMs.value === null);
const mac = /Mac|iPhone|iPad/.test(navigator.platform);

function focus() { board.value?.focus({ preventScroll: true }); }
defineExpose({ focus });
// Native disabled controls lose focus in Chromium. Hand keyboard ownership to
// the stable board before Vue disables the clicked scene/transition button, so
// the next Space still reaches Multiview instead of the channel behind it.
watch([canTake, canSelect], ([takeEnabled, selectEnabled]) => {
  const active = document.activeElement;
  if (!board.value?.contains(active)) return;
  if ((!takeEnabled && active?.matches('.multiview-transition')) ||
    (!selectEnabled && active?.matches('.multiview-scene'))) focus();
}, { flush: 'pre' });

function shortcut(sceneId: string) {
  const binding = shortcuts.bindings.value.find(item => item.sceneId === sceneId);
  return binding ? sceneShortcutLabel(binding, mac) : '';
}
function sceneLabel(scene: StudioScene, index: number) {
  return `${index + 1}. ${scene.name}${studio.state?.previewSceneId === scene.id ? ', in Preview' : ''}${studio.state?.program?.id === scene.id ? ', on Program' : ''}. Select for Preview${shortcut(scene.id) ? `. Scene shortcut: ${shortcut(scene.id)}` : ''}`;
}
function selectScene(scene: StudioScene) {
  if (!canSelect.value || studio.state?.previewSceneId === scene.id) return;
  // Selecting is deliberately separate from taking. A stray double-click must
  // never put a new scene on air, even while a Preview save is in flight.
  void studio.selectScene(scene.id).catch(() => {});
}
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  // Only explicit scene shortcuts remain global. Other modified keys keep
  // native editing, but must not publish/advance a channel behind Multiview.
  if (event.ctrlKey || event.metaKey || event.altKey) {
    if (sceneShortcutProblem(event) !== null) event.stopPropagation();
    return;
  }
  // F / Escape belong to the shell's fullscreen and collapse controls.
  if (event.key.toLowerCase() === 'f' || event.key === 'Escape') return;
  // Channel navigation must not respond behind a focused Multiview panel.
  event.stopPropagation();
  if (event.isComposing) return;
  const target = event.target instanceof Element ? event.target : null;
  if (sceneShortcutSurfaceBlocked(target, document, motion.elapsedMs.value !== null)) return;
  if (event.code === 'Space') {
    // Consume held-key repeats too: a native Space activation on keyup must
    // never sneak an extra click through a focused scene/transition button.
    event.preventDefault();
    if (!event.repeat && canTake.value) take(event.shiftKey ? 'fade' : 'cut');
    return;
  }
  if (event.repeat) return;
  if (!event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
    event.preventDefault();
    const scene = scenes.value[Number(event.code.slice(-1)) - 1];
    if (scene) selectScene(scene);
  }
}
function focusBoard(event: PointerEvent) {
  if (event.target instanceof Element && !event.target.closest('button, input, a, select, textarea')) board.value?.focus({ preventScroll: true });
}
</script>

<template>
  <section ref="board" class="studio-multiview" :class="{ 'is-standalone': standalone, 'has-center-controls': centerControls }" :style="{ '--multiview-monitor-height': `${monitorHeight}px`, '--multiview-shelf-height': `${Math.max(1, shelfHeight - 1)}px` }" tabindex="0" role="region"
    aria-label="Multiview scene switcher" data-testid="studio-multiview" @keydown="keydown" @pointerdown="focusBoard">
    <div class="multiview-buses">
      <div class="multiview-bus is-preview" data-testid="multiview-preview">
        <div class="multiview-bus-label"><b><span />Preview</b><span>{{ studio.selectedScene?.name ?? 'No scene selected' }}</span></div>
        <div class="multiview-monitor">
          <ScenePoster v-if="(!previewReady || !engineRunning) && studio.selectedScene" :scene="studio.selectedScene" :sources="studio.state?.sources" />
          <StudioMonitor v-if="engineRunning" output-id="preview" :audible="false" @ready="previewReady = $event" />
          <div v-if="!studio.selectedScene" class="multiview-monitor-empty"><Layers :size="22" :stroke-width="1.25" /><span>Select a scene below</span></div>
          <span v-else-if="!engineRunning || !previewReady" class="multiview-feed-state">{{ engineRunning ? 'Connecting…' : 'Engine offline · design preview' }}</span>
        </div>
      </div>
      <div class="multiview-transitions" role="group" aria-label="Preview to Program transitions">
        <div class="multiview-transition-actions">
          <button class="multiview-transition" :disabled="!canTake" aria-label="Cut in Multiview" aria-keyshortcuts="Space" title="Cut Preview to Program and return the previous Program to Preview (Space)" @click="take('cut')"><span>Cut</span><ArrowRightLeft :size="13" /><kbd>Space</kbd></button>
          <button class="multiview-transition is-fade" :disabled="!canTake" aria-label="Fade in Multiview" aria-keyshortcuts="Shift+Space" title="Fade Preview to Program and return the previous Program to Preview (Shift + Space)" @click="take('fade')"><span>Fade</span><ArrowRightLeft :size="13" /><kbd>⇧ Space</kbd></button>
        </div>
        <label class="multiview-duration"><span class="multiview-duration-label">Fade duration</span><input v-model="fadeDurationInput" type="number" min="100" max="3000" step="50" aria-label="Multiview fade duration" @change="setFadeDuration" @blur="setFadeDuration" @keydown.enter="setFadeDuration" /><span>ms</span></label>
      </div>
      <div class="multiview-bus is-program" data-testid="multiview-program">
        <div class="multiview-bus-label"><b><span />Program</b><span>{{ studio.state?.program?.name ?? 'Nothing live' }}</span></div>
        <div class="multiview-monitor">
          <ScenePoster v-if="(!programReady || !engineRunning) && studio.state?.program" :scene="studio.state.program" :sources="studio.state.sources" />
          <StudioMonitor v-if="engineRunning" output-id="program" :audible="false" @ready="programReady = $event" />
          <div v-if="!studio.state?.program" class="multiview-monitor-empty"><Circle :size="20" :stroke-width="1.25" /><span>No scene on Program</span></div>
          <span v-else-if="!engineRunning || !programReady" class="multiview-feed-state">{{ engineRunning ? 'Connecting…' : 'Engine offline · last composition' }}</span>
        </div>
      </div>
    </div>

    <div class="multiview-scenes-heading"><span>Scenes <b>{{ scenes.length }}</b></span><span>{{ !engineRunning ? 'Engine offline' : atlasReady ? 'Live thumbnails' : 'Connecting thumbnails…' }}</span></div>
    <div ref="shelf" class="multiview-scenes-scroll">
      <div class="multiview-atlas" :style="{ aspectRatio: `${displaySize.width} / ${displaySize.height}` }">
        <MultiviewAtlas v-if="engineRunning" :scene-count="scenes.length" :columns="displayColumns" @ready="atlasReady = $event" />
        <div class="multiview-scene-grid" :style="{ gridTemplateColumns: `repeat(${displayColumns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${displaySize.rows}, minmax(0, 1fr))` }">
          <template v-for="(scene, index) in slots" :key="scene?.id ?? `empty-${index}`">
            <button v-if="scene" class="multiview-scene" :class="{ 'is-preview': studio.state?.previewSceneId === scene.id, 'is-program': studio.state?.program?.id === scene.id }"
              :data-testid="`multiview-scene-${scene.id}`" :data-scene-id="scene.id" :disabled="!canSelect" :aria-label="sceneLabel(scene, index)" :aria-pressed="studio.state?.previewSceneId === scene.id"
              :title="`${scene.name} · Select for Preview${shortcut(scene.id) ? ` · ${shortcut(scene.id)} takes this scene` : ''}`" @click="selectScene(scene)">
              <ScenePoster v-if="!engineRunning || !atlasReady" :scene="scene" :sources="studio.state?.sources" />
              <span class="multiview-scene-number">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="multiview-scene-status"><span v-if="studio.state?.previewSceneId === scene.id" class="is-preview">Preview</span><span v-if="studio.state?.program?.id === scene.id" class="is-program">Program</span></span>
              <span class="multiview-scene-caption"><b>{{ scene.name }}</b><kbd v-if="shortcut(scene.id)">{{ shortcut(scene.id) }}</kbd></span>
            </button>
            <div v-else class="multiview-scene is-empty" data-testid="multiview-empty-slot" aria-label="Empty scene slot" aria-disabled="true"><Layers :size="19" :stroke-width="1.25" /><span>Empty scene slot</span><small>Create scenes in Studio</small></div>
          </template>
        </div>
      </div>
    </div>
    <div class="multiview-footnote"><span>Select a scene, then Cut or Fade</span><span title="Multiview is always silent. Audio routing stays in Studio."><VolumeX :size="11" />Silent monitor</span></div>
  </section>
</template>
