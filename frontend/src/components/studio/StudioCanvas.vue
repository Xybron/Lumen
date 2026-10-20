<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useMediaQuery, useResizeObserver } from '@vueuse/core';
import { Lock } from 'lucide-vue-next';
import ScenePoster from './ScenePoster.vue';
import StudioMonitor from './StudioMonitor.vue';
import LayerContextMenu from './LayerContextMenu.vue';
import { useStudioStore } from '@/stores/studio';
import { useAnimationPreview } from '@/composables/useAnimationPreview';
import { canvasSnapTargets, moveRect, resizeRect, type CanvasRect, type ResizeHandle, type SnapGuide } from '@/lib/studio/canvas-geometry';
import type { SceneLayer, StudioScene, StudioSource } from '../../../../shared/production';

const props = defineProps<{ scene: StudioScene | null; sources: StudioSource[]; engineRunning: boolean }>();
const emit = defineEmits<{ inspect: [] }>();
const studio = useStudioStore();
const motion = useAnimationPreview();
const isAnimationPreview = computed(() => motion.sceneId.value === props.scene?.id && motion.elapsedMs.value !== null);
const frame = ref<HTMLElement | null>(null), previewReady = ref(false), menuOpen = ref(false);
const frameSize = ref({ width: 0, height: 0 }), coarsePointer = useMediaQuery('(pointer: coarse)');
const handleSize = computed(() => coarsePointer.value ? 12 : 8);
useResizeObserver(frame, entries => {
  const bounds = entries[0]?.contentRect;
  if (bounds) frameSize.value = { width: bounds.width, height: bounds.height };
});
interface Interaction {
  pointerId: number; sceneId: string; layerId: string; startX: number; startY: number;
  initial: CanvasRect; rect: CanvasRect; handle: ResizeHandle | null; moved: boolean;
}
const interaction = ref<Interaction | null>(null), guides = ref<SnapGuide[]>([]);
const handles: { key: ResizeHandle; label: string }[] = [
  { key: 'nw', label: 'Resize layer top left' }, { key: 'n', label: 'Resize layer top' },
  { key: 'ne', label: 'Resize layer top right' }, { key: 'e', label: 'Resize layer right' },
  { key: 'se', label: 'Resize layer' }, { key: 's', label: 'Resize layer bottom' },
  { key: 'sw', label: 'Resize layer bottom left' }, { key: 'w', label: 'Resize layer left' },
];
const draftScene = computed(() => {
  if (!props.scene || !interaction.value) return props.scene;
  const draft = interaction.value;
  return { ...props.scene, layers: props.scene.layers.map(layer => layer.id === draft.layerId ? { ...layer, ...draft.rect } : layer) };
});
const animationScene = computed(() => {
  const scene = draftScene.value, override = motion.override.value;
  if (!scene || !override || override.sceneId !== scene.id) return scene;
  return { ...scene, layers: scene.layers.map(layer => layer.id === override.layerId ? { ...layer, animation: override.animation } : layer) };
});
const layers = computed(() => props.scene?.layers.filter(layer => layer.visible) ?? []);
const selectedLayer = computed(() => props.scene?.layers.find(layer => layer.id === studio.selectedLayerId) ?? null);
const dimensions = computed(() => {
  const rect = interaction.value?.rect ?? selectedLayer.value;
  return rect ? `${Math.round(rect.width * 19.2)} × ${Math.round(rect.height * 10.8)}` : '';
});

function run(operation: Promise<unknown>) { void operation.catch(() => {}); }
function geometry(layer: SceneLayer): CanvasRect { return { x: layer.x, y: layer.y, width: layer.width, height: layer.height }; }
function layerStyle(layer: SceneLayer) {
  const rect = interaction.value?.layerId === layer.id ? interaction.value.rect : layer;
  return { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` };
}
function handleStyle(layer: SceneLayer, handle: ResizeHandle) {
  const rect = interaction.value?.layerId === layer.id ? interaction.value.rect : layer;
  const { width, height } = frameSize.value;
  if (!width || !height) return {};
  const x = rect.x * width / 100, y = rect.y * height / 100;
  const px = x + rect.width * width / 100 * (handle.includes('w') ? 0 : handle.includes('e') ? 1 : .5);
  const py = y + rect.height * height / 100 * (handle.includes('n') ? 0 : handle.includes('s') ? 1 : .5);
  // Do not invent crop-edge handles for an off-canvas anchor. Only genuine
  // canvas-edge handles are nudged inward so their full target remains usable.
  if (px < -.5 || px > width + .5 || py < -.5 || py > height + .5) return { visibility: 'hidden' as const };
  const inset = handleSize.value / 2 + 1;
  return { left: `${Math.max(inset, Math.min(width - inset, px)) - x}px`,
    top: `${Math.max(inset, Math.min(height - inset, py)) - y}px` };
}
function nameStyle(layer: SceneLayer) {
  const rect = interaction.value?.layerId === layer.id ? interaction.value.rect : layer;
  const { width, height } = frameSize.value;
  if (!width || !height) return {};
  const x = rect.x * width / 100, y = rect.y * height / 100;
  const right = x + rect.width * width / 100, bottom = y + rect.height * height / 100;
  if (right < 0 || bottom < 0 || x > width || y > height) return { visibility: 'hidden' as const };
  const left = Math.max(4, Math.min(width - 36, x));
  const top = Math.max(4, Math.min(height - 22, y >= 20 ? y - 20 : y + 4));
  return { left: `${left - x}px`, top: `${top - y}px`, maxWidth: `${Math.min(240, width - left - 4)}px` };
}
function select(layer: SceneLayer) { studio.selectedLayerId = layer.id; }
function begin(event: PointerEvent, layer: SceneLayer, handle: ResizeHandle | null = null) {
  if (event.button !== 0 || !event.isPrimary || menuOpen.value || !props.scene) return;
  event.preventDefault(); event.stopPropagation();
  select(layer);
  frame.value?.focus({ preventScroll: true });
  if (layer.locked) return;
  cancel();
  const initial = geometry(layer);
  interaction.value = { pointerId: event.pointerId, sceneId: props.scene.id, layerId: layer.id,
    startX: event.clientX, startY: event.clientY, initial, rect: initial, handle, moved: false };
  frame.value?.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  const current = interaction.value, bounds = frame.value?.getBoundingClientRect();
  if (!current || event.pointerId !== current.pointerId || !bounds?.width || !bounds.height) return;
  event.preventDefault();
  const dx = (event.clientX - current.startX) / bounds.width * 100;
  const dy = (event.clientY - current.startY) / bounds.height * 100;
  if (!current.moved && Math.abs(event.clientX - current.startX) + Math.abs(event.clientY - current.startY) < 2) return;
  const options = { shift: event.shiftKey, snap: !event.altKey,
    targets: canvasSnapTargets(props.scene?.layers ?? [], current.layerId),
    tolerance: { x: 5 / bounds.width * 100, y: 5 / bounds.height * 100 } };
  const result = current.handle ? resizeRect(current.initial, dx, dy, current.handle, options) : moveRect(current.initial, dx, dy, options);
  current.rect = result.rect; current.moved = true; guides.value = result.guides;
}
function release(pointerId: number) {
  if (frame.value?.hasPointerCapture(pointerId)) frame.value.releasePointerCapture(pointerId);
}
function finish(event: PointerEvent) {
  const current = interaction.value;
  if (!current || current.pointerId !== event.pointerId) return;
  // Clear the local draft before releasing capture: lostpointercapture is also
  // used for cancellation and must not discard a successful drop.
  interaction.value = null; guides.value = []; release(current.pointerId);
  if (current.moved && current.sceneId === props.scene?.id && studio.selectedLayerId === current.layerId &&
    props.scene.layers.some(layer => layer.id === current.layerId && !layer.locked) &&
    Object.keys(current.initial).some(key => current.initial[key as keyof CanvasRect] !== current.rect[key as keyof CanvasRect])) {
    run(studio.updateLayer(current.layerId, current.rect, current.sceneId));
  }
}
function cancel() {
  const current = interaction.value;
  interaction.value = null; guides.value = [];
  if (current) release(current.pointerId);
}
function cancelPointer(event: PointerEvent) { if (interaction.value?.pointerId === event.pointerId) cancel(); }
function clearSelection() { cancel(); studio.selectedLayerId = null; frame.value?.focus({ preventScroll: true }); }
function opened(open: boolean) { menuOpen.value = open; if (open) cancel(); }
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || menuOpen.value ||
    (event.target as HTMLElement).closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [data-studio-layer-menu]')) return;
  if (isAnimationPreview.value) {
    // Normal buttons keep their native Space/Enter behaviour during rehearsal.
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); motion.stop(); }
    if (event.code === 'Space' && props.scene) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) {
        if (motion.playing.value) motion.pause();
        else motion.play(props.scene.id, motion.layerId.value, motion.durationMs.value);
      }
    }
    return;
  }
  if (interaction.value) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    // Never commit an old scene while the visible selection is still moving.
    if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); }
    return;
  }
  const layer = selectedLayer.value;
  if (!layer) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearSelection(); return; }
  if (event.key === 'F2' && !event.repeat) { event.preventDefault(); event.stopPropagation(); emit('inspect'); return; }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'd') {
    event.preventDefault(); event.stopPropagation(); if (!event.repeat) run(studio.duplicateLayer(layer.id)); return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault(); event.stopPropagation(); if (!event.repeat && !layer.locked) run(studio.removeLayer(layer.id)); return;
  }
  const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
  if (!direction) return;
  event.preventDefault(); event.stopPropagation();
  if (layer.locked) return;
  const step = event.shiftKey ? 10 : 1;
  const handle = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-handle]')?.dataset.handle as ResizeHandle | undefined;
  if (handle && props.scene) {
    const sceneId = props.scene.id, layerId = layer.id;
    // Compute against the queued document, not the last server response, so a
    // held arrow key cannot lose steps while a previous edit is being saved.
    run(studio.edit(state => {
      const current = state.scenes.find(scene => scene.id === sceneId)?.layers.find(item => item.id === layerId);
      if (current && !current.locked) Object.assign(current, resizeRect(current, direction[0] * step / 19.2, direction[1] * step / 10.8, handle, { snap: false }).rect);
    }));
  } else run(studio.nudgeLayer(layer.id, direction[0] * step, direction[1] * step));
}

watch(() => props.scene?.id, id => { cancel(); if (motion.sceneId.value && motion.sceneId.value !== id) { motion.stop(); motion.setOverride(null); } });
watch(() => studio.selectedLayerId, id => {
  if (interaction.value && interaction.value.layerId !== id) cancel();
  if (motion.layerId.value && motion.layerId.value !== id) { motion.stop(); motion.setOverride(null); }
});
watch(() => selectedLayer.value?.id, id => {
  if (!id && motion.layerId.value) { motion.stop(); motion.setOverride(null); }
});
watch(() => selectedLayer.value?.locked, locked => { if (locked) cancel(); });
watch(() => selectedLayer.value?.visible, visible => { if (!visible) cancel(); });
onBeforeUnmount(() => { cancel(); motion.stop(); motion.setOverride(null); });
</script>

<template>
  <div ref="frame" class="monitor-frame preview-frame studio-canvas" tabindex="0" role="group" aria-label="Preview canvas"
    :class="{ 'is-interacting': !!interaction }" :style="{ '--canvas-handle-size': `${handleSize}px` }" @keydown="keydown" @pointermove="move" @pointerup="finish" @pointercancel="cancelPointer" @lostpointercapture="cancelPointer" @pointerdown.self="clearSelection">
    <ScenePoster v-if="animationScene && (!previewReady || isAnimationPreview)" :scene="animationScene" :sources="sources"
      :animation-time="isAnimationPreview ? motion.elapsedMs.value : null" :animation-layer-id="motion.layerId.value"
      :preview-media="isAnimationPreview" :stream-for-source="studio.sourceStream" :class="{ 'animation-preview': isAnimationPreview }" :data-animation-preview="isAnimationPreview ? '' : undefined" />
    <StudioMonitor output-id="preview" @ready="previewReady = $event" />
    <div v-show="!isAnimationPreview" class="canvas-selection" @pointerdown.self="clearSelection">
      <LayerContextMenu v-for="layer in layers" :key="layer.id" :layer-id="layer.id" @inspect="emit('inspect')" @rename="emit('inspect')" @open-change="opened">
        <div :class="['layer-hitbox', { selected: studio.selectedLayerId === layer.id, locked: layer.locked }]" :style="layerStyle(layer)"
          role="button" tabindex="0" :aria-label="`Select ${layer.name}`" :aria-pressed="studio.selectedLayerId === layer.id" :data-layer-id="layer.id"
          @pointerdown="begin($event, layer)" @focus.self="select(layer)" @keydown.enter.prevent.stop="select(layer)">
          <template v-if="studio.selectedLayerId === layer.id">
            <span class="selection-name" :style="nameStyle(layer)">{{ layer.name }}<Lock v-if="layer.locked" :size="9" /></span>
            <template v-if="!layer.locked"><button v-for="handle in handles" :key="handle.key" :class="['resize-handle', `handle-${handle.key}`]" :style="handleStyle(layer, handle.key)" :data-handle="handle.key" :aria-label="handle.label" @pointerdown.stop="begin($event, layer, handle.key)" /></template>
            <span v-if="interaction?.layerId === layer.id" class="selection-dimensions">{{ dimensions }}</span>
          </template>
        </div>
      </LayerContextMenu>
      <span v-for="(guide, index) in guides" :key="`${guide.axis}-${index}`" :class="['snap-guide', `guide-${guide.axis}`]" :data-axis="guide.axis" :data-value="guide.value"
        :style="guide.axis === 'x' ? { left: `${guide.value}%` } : { top: `${guide.value}%` }" aria-hidden="true" />
    </div>
    <div v-if="isAnimationPreview" class="animation-preview-badge"><span>LOCAL REHEARSAL</span><button aria-label="Stop animation preview" @click="motion.stop">Return to layout</button></div>
    <span v-else-if="!engineRunning" class="draft-badge">DESIGN PREVIEW</span>
  </div>
</template>

<style scoped>
.studio-canvas { outline: none; isolation: isolate; }
.studio-canvas:focus-visible { box-shadow: 0 0 0 3px #7dd3fc30; }
.animation-preview { z-index: 1; pointer-events: none; }
.animation-preview-badge { position: absolute; bottom: 8px; left: 8px; right: 8px; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #b4e6fc; font-size: 8px; letter-spacing: .7px; }
.animation-preview-badge > span { padding: 4px 6px; background: #10242ee6; border-radius: 4px; }
.animation-preview-badge button { border: 1px solid #7dd3fc33; border-radius: 5px; background: #10242eeb; color: #b4e6fc; padding: 5px 7px; font-size: 9px; letter-spacing: 0; }
.canvas-selection { position: absolute; inset: 0; touch-action: none; }
.layer-hitbox { position: absolute; touch-action: none; cursor: move; border: 1px solid transparent; outline: none; }
.layer-hitbox:hover { border-color: #7dd3fc70; }
.layer-hitbox.selected { border-color: #7dd3fc; }
.layer-hitbox:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
.layer-hitbox.locked { cursor: default; }
.selection-name { position: absolute; top: -20px; left: -1px; display: flex; align-items: center; gap: 5px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 5px; border-radius: 3px 3px 0 0; background: #7dd3fc; color: #10212c; font-size: 9px; line-height: 14px; pointer-events: none; }
.resize-handle { position: absolute; width: var(--canvas-handle-size, 8px); height: var(--canvas-handle-size, 8px); min-width: 0; padding: 0; margin: 0; border: 1px solid #16445b; border-radius: 1px; background: #dbf3ff; z-index: 2; touch-action: none; transform: translate(-50%, -50%); right: auto; bottom: auto; }
.resize-handle:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
.handle-nw { left: 0; top: 0; cursor: nwse-resize !important; }
.handle-n { left: 50%; top: 0; cursor: ns-resize !important; }
.handle-ne { left: 100%; top: 0; cursor: nesw-resize !important; }
.handle-e { left: 100%; top: 50%; cursor: ew-resize !important; }
.handle-se { left: 100%; top: 100%; cursor: nwse-resize !important; }
.handle-s { left: 50%; top: 100%; cursor: ns-resize !important; }
.handle-sw { left: 0; top: 100%; cursor: nesw-resize !important; }
.handle-w { left: 0; top: 50%; cursor: ew-resize !important; }
.snap-guide { position: absolute; display: block; pointer-events: none; background: #f077d0; z-index: 4; box-shadow: 0 0 3px #f077d050; }
.guide-x { top: 0; bottom: 0; width: 1px; }
.guide-y { left: 0; right: 0; height: 1px; }
.selection-dimensions { position: absolute; left: 50%; bottom: -24px; transform: translateX(-50%); background: #182932; color: #b9eaff; border: 1px solid #7dd3fc55; border-radius: 4px; font-size: 9px; line-height: 18px; padding: 0 5px; white-space: nowrap; pointer-events: none; }
.is-interacting, .is-interacting * { user-select: none; }
</style>
