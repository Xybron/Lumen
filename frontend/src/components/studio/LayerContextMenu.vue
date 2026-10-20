<script setup lang="ts">
import { computed } from 'vue';
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuLabel } from 'reka-ui';
import { ChevronRight, SlidersHorizontal, Pencil, Copy, Eye, EyeOff, Lock, Unlock, Trash2, Layers, AlignHorizontalJustifyCenter, LayoutTemplate } from 'lucide-vue-next';
import { useStudioStore } from '@/stores/studio';
import type { LayerAlignment, LayerArrangeAction, LayerPreset } from '@/lib/studio/layer-layout';

const props = defineProps<{ layerId: string | null }>();
const emit = defineEmits<{ inspect: []; rename: []; 'open-change': [open: boolean] }>();
const studio = useStudioStore();
const layer = computed(() => studio.selectedScene?.layers.find(item => item.id === props.layerId) ?? null);
const index = computed(() => studio.selectedScene?.layers.findIndex(item => item.id === props.layerId) ?? -1);
const atFront = computed(() => index.value === (studio.selectedScene?.layers.length ?? 0) - 1);
const atBack = computed(() => index.value === 0);
const alignments: { value: LayerAlignment; label: string }[] = [
  { value: 'left', label: 'Align left' }, { value: 'center', label: 'Align center' }, { value: 'right', label: 'Align right' },
  { value: 'top', label: 'Align top' }, { value: 'middle', label: 'Align middle' }, { value: 'bottom', label: 'Align bottom' },
];
const presets: { value: LayerPreset; label: string }[] = [
  { value: 'center', label: 'Center on canvas' }, { value: 'full', label: 'Fill canvas' }, { value: 'lower-third', label: 'Lower third' },
  { value: 'upper-third', label: 'Upper third' },
];
function run(operation: Promise<unknown>) { void operation.catch(() => {}); }
function onOpen(open: boolean) {
  if (open && layer.value) studio.selectedLayerId = layer.value.id;
  emit('open-change', open);
}
function arrange(action: LayerArrangeAction) { if (layer.value) run(studio.arrangeLayer(layer.value.id, action)); }
</script>

<template>
  <ContextMenuRoot @update:open="onOpen">
    <ContextMenuTrigger as-child :disabled="!layer"><slot /></ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent v-if="layer" class="studio-layer-menu" data-studio-layer-menu :collision-padding="8" :loop="true" @keydown.stop>
        <ContextMenuLabel class="layer-menu-label">{{ layer.name }}</ContextMenuLabel>
        <ContextMenuItem class="layer-menu-item" @select="emit('inspect')"><SlidersHorizontal :size="13" />Edit properties</ContextMenuItem>
        <ContextMenuItem class="layer-menu-item" @select="emit('rename')"><Pencil :size="13" />Rename<kbd>F2</kbd></ContextMenuItem>
        <ContextMenuItem class="layer-menu-item" @select="run(studio.duplicateLayer(layer.id))"><Copy :size="13" />Duplicate</ContextMenuItem>
        <ContextMenuSeparator class="layer-menu-separator" />
        <ContextMenuSub>
          <ContextMenuSubTrigger class="layer-menu-item" :disabled="layer.locked"><Layers :size="13" />Arrange<ChevronRight class="layer-menu-chevron" :size="13" /></ContextMenuSubTrigger>
          <ContextMenuPortal><ContextMenuSubContent class="studio-layer-menu" data-studio-layer-menu :side-offset="4" :collision-padding="8" @keydown.stop>
            <ContextMenuItem class="layer-menu-item" :disabled="atFront" @select="arrange('forward')">Bring forward</ContextMenuItem>
            <ContextMenuItem class="layer-menu-item" :disabled="atBack" @select="arrange('backward')">Send backward</ContextMenuItem>
            <ContextMenuSeparator class="layer-menu-separator" />
            <ContextMenuItem class="layer-menu-item" :disabled="atFront" @select="arrange('front')">Bring to front</ContextMenuItem>
            <ContextMenuItem class="layer-menu-item" :disabled="atBack" @select="arrange('back')">Send to back</ContextMenuItem>
          </ContextMenuSubContent></ContextMenuPortal>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger class="layer-menu-item" :disabled="layer.locked"><AlignHorizontalJustifyCenter :size="13" />Align to canvas<ChevronRight class="layer-menu-chevron" :size="13" /></ContextMenuSubTrigger>
          <ContextMenuPortal><ContextMenuSubContent class="studio-layer-menu" data-studio-layer-menu :side-offset="4" :collision-padding="8" @keydown.stop>
            <ContextMenuItem v-for="alignment in alignments" :key="alignment.value" class="layer-menu-item" @select="run(studio.alignLayer(layer.id, alignment.value))">{{ alignment.label }}</ContextMenuItem>
          </ContextMenuSubContent></ContextMenuPortal>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger class="layer-menu-item" :disabled="layer.locked"><LayoutTemplate :size="13" />Placement presets<ChevronRight class="layer-menu-chevron" :size="13" /></ContextMenuSubTrigger>
          <ContextMenuPortal><ContextMenuSubContent class="studio-layer-menu" data-studio-layer-menu :side-offset="4" :collision-padding="8" @keydown.stop>
            <ContextMenuItem v-for="preset in presets" :key="preset.value" class="layer-menu-item" @select="run(studio.presetLayer(layer.id, preset.value))">{{ preset.label }}</ContextMenuItem>
          </ContextMenuSubContent></ContextMenuPortal>
        </ContextMenuSub>
        <ContextMenuSeparator class="layer-menu-separator" />
        <ContextMenuItem class="layer-menu-item" @select="run(studio.updateLayer(layer.id, { visible: !layer.visible }))"><Eye v-if="layer.visible" :size="13" /><EyeOff v-else :size="13" />{{ layer.visible ? 'Hide layer' : 'Show layer' }}</ContextMenuItem>
        <ContextMenuItem class="layer-menu-item" @select="run(studio.updateLayer(layer.id, { locked: !layer.locked }))"><Lock v-if="layer.locked" :size="13" /><Unlock v-else :size="13" />{{ layer.locked ? 'Unlock layer' : 'Lock layer' }}</ContextMenuItem>
        <ContextMenuSeparator class="layer-menu-separator" />
        <ContextMenuItem class="layer-menu-item layer-menu-danger" :disabled="layer.locked" @select="run(studio.removeLayer(layer.id))"><Trash2 :size="13" />Delete<kbd>⌫</kbd></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>

<!-- Reka portals do not inherit this component's scope attribute. Keep the
     portalled surface global, with every descendant limited to its menu. -->
<style>
.studio-layer-menu { z-index: 110; min-width: 216px; max-width: min(280px, calc(100vw - 24px)); max-height: var(--reka-context-menu-content-available-height, calc(100vh - 24px)); overflow-y: auto; padding: 5px; background: #222226; border: 1px solid #ffffff14; border-radius: 11px; color: #f4f4f5dc; box-shadow: 0 12px 42px #0008, 0 2px 8px #0005; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; outline: none; }
.studio-layer-menu .layer-menu-label { padding: 7px 9px; font-size: 10px; color: #f4f4f560; font-weight: 500; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-layer-menu .layer-menu-item { position: relative; display: flex; align-items: center; gap: 9px; min-height: 31px; padding: 6px 9px; border-radius: 6px; outline: none; font-size: 11px; line-height: 1.4; cursor: default; user-select: none; }
.studio-layer-menu .layer-menu-item[data-highlighted], .studio-layer-menu .layer-menu-item[data-state='open'] { background: #7dd3fc1a; color: #d2f0ff; }
.studio-layer-menu .layer-menu-item[data-disabled] { opacity: .32; pointer-events: none; }
.studio-layer-menu .layer-menu-item > svg { flex-shrink: 0; color: #f4f4f57a; }
.studio-layer-menu .layer-menu-item kbd, .studio-layer-menu .layer-menu-chevron { margin-left: auto; color: #f4f4f550; font: inherit; font-size: 10px; }
.studio-layer-menu .layer-menu-separator { height: 1px; margin: 4px; background: #ffffff0c; }
.studio-layer-menu .layer-menu-danger { color: #f3a7a1; }
.studio-layer-menu .layer-menu-danger[data-highlighted] { background: #f88d8515; color: #ffb6b0; }
</style>
