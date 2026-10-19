<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Layers, Type, Square, Film, Plus, Eye, EyeOff, Lock, Unlock, Copy, Trash2, ArrowUp, ArrowDown, SlidersHorizontal, GripVertical } from 'lucide-vue-next';
import { useStudioStore } from '@/stores/studio';
import LayerContextMenu from './LayerContextMenu.vue';

const emit = defineEmits<{ 'add-source': []; inspect: [] }>();
const studio = useStudioStore();
const panel = ref<HTMLElement | null>(null);
const layers = computed(() => [...(studio.selectedScene?.layers ?? [])].reverse());
const renamingId = ref<string | null>(null), renameValue = ref('');
const draggingId = ref<string | null>(null);
const dropTarget = ref<{ id: string; placement: 'before' | 'after' } | null>(null);
const selectedIndex = computed(() => layers.value.findIndex(layer => layer.id === studio.selectedLayerId));
function run(operation: Promise<unknown>) { void operation.catch(() => {}); }
function clearDrag() { draggingId.value = null; dropTarget.value = null; }
watch(() => studio.selectedScene?.id, () => { renamingId.value = null; clearDrag(); });
async function beginRename(id: string) {
  const layer = studio.selectedScene?.layers.find(item => item.id === id);
  if (!layer) return;
  studio.selectedLayerId = id;
  renameValue.value = layer.name;
  renamingId.value = id;
  await nextTick();
  const input = panel.value?.querySelector<HTMLInputElement>('.layer-rename-input');
  input?.focus(); input?.select();
}
function finishRename() {
  const id = renamingId.value;
  if (!id) return;
  const name = renameValue.value.trim().slice(0, 100);
  renamingId.value = null;
  if (name && name !== studio.selectedScene?.layers.find(layer => layer.id === id)?.name) run(studio.updateLayer(id, { name }));
  void focusRow(id);
}
async function focusRow(id: string) {
  await nextTick();
  panel.value?.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}
function startDrag(event: DragEvent, id: string) {
  if (renamingId.value || (event.target as HTMLElement).closest('button, input') || studio.selectedScene?.layers.find(layer => layer.id === id)?.locked) { event.preventDefault(); return; }
  studio.selectedLayerId = id;
  draggingId.value = id;
  if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-lumen-layer', id); event.dataTransfer.setData('text/plain', id); }
}
function overLayer(event: DragEvent, id: string) {
  if (!draggingId.value || draggingId.value === id) { dropTarget.value = null; return; }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropTarget.value = { id, placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' };
}
function dropLayer(event: DragEvent, id: string) {
  const moving = draggingId.value, target = dropTarget.value;
  if (moving && target?.id === id) { event.preventDefault(); run(studio.reorderLayer(moving, id, target.placement)); }
  clearDrag();
}
function leaveList(event: DragEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) dropTarget.value = null;
}
function rowKey(event: KeyboardEvent, id: string) {
  if ((event.target as HTMLElement).closest('button, input')) return;
  if (event.key === 'F2') { event.preventDefault(); if (!event.repeat) void beginRename(id); return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); if (!event.repeat) run(studio.duplicateLayer(id)); return; }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (!event.repeat) run(studio.removeLayer(id)); return; }
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); run(studio.arrangeLayer(id, event.key === 'ArrowUp' ? 'forward' : 'backward')); return; }
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const current = layers.value.findIndex(layer => layer.id === id);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? layers.value.length - 1 : Math.min(layers.value.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)));
    const layer = layers.value[next];
    if (layer) { studio.selectedLayerId = layer.id; void focusRow(layer.id); }
    return;
  }
  if (event.key === 'Enter') { event.preventDefault(); studio.selectedLayerId = id; emit('inspect'); }
  if (event.code === 'Space') { event.preventDefault(); studio.selectedLayerId = id; }
}
</script>

<template>
  <section ref="panel" class="tool-panel layers-panel" aria-label="Layers">
    <div class="tool-heading"><h2><Layers :size="14" />Layers <small class="panel-count">{{ layers.length }}</small></h2><div>
      <button class="s-icon" title="Add text" aria-label="Add text layer" :disabled="!studio.selectedScene" @click="run(studio.addLayer({ kind: 'text', name: 'Text' }))"><Type :size="14" /></button>
      <button class="s-icon" title="Add shape" aria-label="Add shape layer" :disabled="!studio.selectedScene" @click="run(studio.addLayer({ kind: 'shape', name: 'Shape', background: '#b7cfad', x: 10, y: 70, width: 40, height: 15, radius: 12 }))"><Square :size="13" /></button>
      <button class="s-icon" title="Add source" aria-label="Add source layer" @click="emit('add-source')"><Plus :size="15" /></button>
    </div></div>
    <div class="layer-list" role="tree" aria-label="Scene layers" @dragleave="leaveList">
      <LayerContextMenu v-for="layer in layers" :key="layer.id" :layer-id="layer.id" @inspect="emit('inspect')" @rename="beginRename(layer.id)">
        <div :class="['layer-row', { selected: studio.selectedLayerId === layer.id, hidden: !layer.visible, 'layer-dragging': draggingId === layer.id, 'drop-before': dropTarget?.id === layer.id && dropTarget.placement === 'before', 'drop-after': dropTarget?.id === layer.id && dropTarget.placement === 'after' }]"
          :data-layer-id="layer.id" data-studio-layer-row role="treeitem" :aria-selected="studio.selectedLayerId === layer.id" :aria-label="layer.name + ', ' + layer.kind + ' layer'" :tabindex="studio.selectedLayerId === layer.id || (selectedIndex < 0 && layer.id === layers[0]?.id) ? 0 : -1"
          :draggable="!layer.locked && renamingId !== layer.id" @dragstart="startDrag($event, layer.id)" @dragover="overLayer($event, layer.id)" @drop="dropLayer($event, layer.id)" @dragend="clearDrag" @click="studio.selectedLayerId = layer.id" @focus="studio.selectedLayerId = layer.id" @keydown.stop="rowKey($event, layer.id)">
          <GripVertical class="layer-grip" :size="11" aria-hidden="true" />
          <component :is="layer.kind === 'text' ? Type : layer.kind === 'shape' ? Square : Film" :size="13" aria-hidden="true" />
          <input v-if="renamingId === layer.id" v-model="renameValue" class="layer-rename-input" aria-label="Layer name" maxlength="100" @click.stop @pointerdown.stop @keydown.stop @keydown.enter.prevent="finishRename" @keydown.esc.prevent="renamingId = null; focusRow(layer.id)" @blur="finishRename" />
          <span v-else class="layer-name" title="Double-click to rename" @dblclick.stop="beginRename(layer.id)">{{ layer.name }}</span>
          <button class="s-icon layer-row-action layer-lock-action" :class="{ 'is-locked': layer.locked }" :aria-label="(layer.locked ? 'Unlock ' : 'Lock ') + layer.name" :title="layer.locked ? 'Unlock layer' : 'Lock layer'" @click.stop="run(studio.updateLayer(layer.id, { locked: !layer.locked }))"><Lock v-if="layer.locked" :size="11" /><Unlock v-else :size="11" /></button>
          <button class="s-icon layer-row-action" :aria-label="(layer.visible ? 'Hide ' : 'Show ') + layer.name" :title="layer.visible ? 'Hide layer' : 'Show layer'" @click.stop="run(studio.updateLayer(layer.id, { visible: !layer.visible }))"><Eye v-if="layer.visible" :size="12" /><EyeOff v-else :size="12" /></button>
        </div>
      </LayerContextMenu>
      <div v-if="!layers.length" class="panel-empty"><Layers :size="22" /><span>A blank canvas.<br />Add a source, text, or shape.</span></div>
    </div>
    <div class="layer-panel-footer">
      <span>{{ studio.selectedLayer?.locked ? 'Unlock to edit' : 'Top layer appears in front' }}</span>
      <div class="layer-footer-actions">
        <button class="s-icon" aria-label="Move layer forward" title="Move layer forward · ⌥↑" :disabled="!studio.selectedLayer || studio.selectedLayer.locked || selectedIndex <= 0" @click="studio.selectedLayer && run(studio.arrangeLayer(studio.selectedLayer.id, 'forward'))"><ArrowUp :size="13" /></button>
        <button class="s-icon" aria-label="Move layer backward" title="Move layer backward · ⌥↓" :disabled="!studio.selectedLayer || studio.selectedLayer.locked || selectedIndex >= layers.length - 1" @click="studio.selectedLayer && run(studio.arrangeLayer(studio.selectedLayer.id, 'backward'))"><ArrowDown :size="13" /></button>
        <span class="layer-action-divider" />
        <button class="s-icon" aria-label="Layer properties" title="Layer properties" :disabled="!studio.selectedLayer" @click="emit('inspect')"><SlidersHorizontal :size="13" /></button>
        <button class="s-icon" aria-label="Duplicate layer" title="Duplicate layer" :disabled="!studio.selectedLayer" @click="studio.selectedLayer && run(studio.duplicateLayer(studio.selectedLayer.id))"><Copy :size="13" /></button>
        <button class="s-icon layer-delete-action" aria-label="Delete layer" title="Delete layer" :disabled="!studio.selectedLayer || studio.selectedLayer.locked" @click="studio.selectedLayer && run(studio.removeLayer(studio.selectedLayer.id))"><Trash2 :size="13" /></button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.layer-list { padding: 6px; }
.layer-row { position: relative; gap: 7px; min-height: 37px; border-radius: 6px; }
.layer-row:focus-visible { outline: 1px solid #7dd3fcaa; outline-offset: -1px; }
.layer-grip { flex-shrink: 0; color: #f4f4f53a; cursor: grab; opacity: 0; }
.layer-row:hover .layer-grip, .layer-row:focus-within .layer-grip, .layer-row.selected .layer-grip { opacity: 1; }
.layer-row[draggable='false'] .layer-grip { cursor: default; opacity: .2; }
.layer-row .layer-name { min-width: 0; flex: 1; color: #f4f4f5bf; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.layer-row .layer-rename-input { min-width: 0; width: 0; flex: 1; padding: 4px 5px; background: #111114; color: #f4f4f5; border: 1px solid #7dd3fc88; border-radius: 4px; outline: none; font-size: 11px; }
.layer-row.hidden { opacity: 1; }
.layer-row.hidden .layer-name, .layer-row.hidden > svg:not(.layer-grip) { opacity: .4; }
.layer-row .layer-row-action { width: 23px; height: 25px; flex-shrink: 0; }
.layer-lock-action:not(.is-locked) { opacity: 0; }
.layer-row:hover .layer-lock-action, .layer-row:focus-within .layer-lock-action { opacity: 1; }
.layer-row.layer-dragging { opacity: .35; }
.layer-row.drop-before::before, .layer-row.drop-after::after { content: ''; position: absolute; left: 3px; right: 3px; height: 2px; border-radius: 2px; background: #7dd3fc; pointer-events: none; z-index: 1; }
.layer-row.drop-before::before { top: -2px; }.layer-row.drop-after::after { bottom: -2px; }
.layer-panel-footer { min-height: 40px; padding: 6px 10px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px; border-top: 1px solid #ffffff0a; }
.layer-panel-footer > span { font-size: 10px; color: var(--text-muted, #a0a2a8); }
.layer-footer-actions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.layer-footer-actions .s-icon { width: 27px; height: 27px; }
.layer-action-divider { width: 1px; height: 14px; margin: 0 3px; background: #ffffff12; }
.layer-delete-action:not(:disabled):hover { color: #f3a7a1; background: #f88d8512; }
@media (pointer: coarse) { .layer-lock-action:not(.is-locked), .layer-grip { opacity: .6; }.layer-row .layer-row-action { width: 30px; height: 30px; } }
</style>
