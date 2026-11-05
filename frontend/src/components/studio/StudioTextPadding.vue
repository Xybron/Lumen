<script setup lang="ts">
import { computed, ref } from 'vue';
import { Link, Unlink, RotateCcw } from 'lucide-vue-next';
import { useStudioStore } from '@/stores/studio';
import { textPaddingForLayer, type TextPaddingInsets } from '@/lib/studio/text-padding';
import StudioPropertyInput from './StudioPropertyInput.vue';
import type { SceneLayer } from '../../../../shared/production';

const props = defineProps<{ layer: SceneLayer; sceneId: string }>();
const studio = useStudioStore();
const padding = computed(() => textPaddingForLayer(props.layer));
const equalSides = computed(() => Object.values(padding.value).every(value => Math.abs(value - padding.value.top) < .001));
const linkIntent = ref<boolean | null>(null);
let linkEdit = 0;
const linked = computed(() => linkIntent.value ?? props.layer.textPadding?.linked ?? equalSides.value);
const sides = [
  { key: 'top', label: 'Top' }, { key: 'right', label: 'Right' },
  { key: 'bottom', label: 'Bottom' }, { key: 'left', label: 'Left' },
] as const;
// Capture the mode alongside the layer identity so a queued edit keeps the
// operator's original intent if they link sides or change scenes immediately.
const identity = computed(() => `${props.sceneId}:${props.layer.id}:${linked.value ? 'linked' : 'separate'}`);
function limit(side: keyof TextPaddingInsets) {
  const width = props.layer.width * 19.2, height = props.layer.height * 10.8;
  const opposite = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' } as const;
  return Math.max(0, Math.min(3840, linked.value ? (Math.min(width, height) - 1) / 2
    : (side === 'left' || side === 'right' ? width : height) - padding.value[opposite[side]] - 1));
}
function commit(side: keyof TextPaddingInsets, input: string, target: string) {
  const [sceneId, layerId, mode] = target.split(':');
  void studio.updateLayerTextPadding(layerId, { side, value: Number(input), linked: mode === 'linked' }, sceneId).catch(() => {});
}
function toggle() {
  const next = !linked.value, edit = ++linkEdit;
  // Reflect the choice immediately even when another save is ahead of it.
  // A following side edit then captures the mode the operator just selected.
  linkIntent.value = next;
  void studio.updateLayerTextPadding(props.layer.id, { linked: next }, props.sceneId).catch(() => {}).finally(() => {
    if (linkEdit === edit) linkIntent.value = null;
  });
}
function reset() {
  ++linkEdit; linkIntent.value = null;
  void studio.updateLayerTextPadding(props.layer.id, null, props.sceneId).catch(() => {});
}
</script>

<template>
  <section class="text-padding" aria-label="Text padding">
    <div class="text-padding-heading"><span>Text padding</span><span class="padding-unit">px</span><button type="button" class="s-icon" aria-label="Reset text padding" title="Restore original text spacing" :disabled="!layer.textPadding" @click="reset"><RotateCcw :size="12" /></button></div>
    <div class="padding-map">
      <div class="padding-map-outline" aria-hidden="true" />
      <label v-for="side in sides" :key="side.key" :class="['padding-side', `padding-${side.key}`]">
        <span>{{ side.label }}</span>
        <StudioPropertyInput type="number" :aria-label="`${side.label} text padding`" :identity="identity" :pending="!!studio.saving" :value="Math.round(padding[side.key] * 1000) / 1000" min="0" :max="limit(side.key)" step="1" @commit="(value, target) => commit(side.key, value, target)" />
      </label>
      <button type="button" class="padding-link" :aria-label="linked ? 'Unlink text padding sides' : 'Link text padding sides'" :aria-pressed="linked" :title="linked ? 'Adjust each side separately' : 'Link all four sides'" @click="toggle"><Link v-if="linked" :size="16" /><Unlink v-else :size="16" /></button>
    </div>
    <p class="padding-mode">{{ linked ? equalSides ? 'All sides linked' : 'Next edit applies to all sides' : 'Adjust each side' }}</p>
    <p class="padding-help">Space inside the text frame. Background stays full size.</p>
  </section>
</template>

<style scoped>
.text-padding { min-width: 0; margin-top: 16px; padding-top: 13px; border-top: 1px solid #ffffff0c; }
.text-padding-heading { display: flex; align-items: center; gap: 5px; color: #f4f4f5a6; font-size: 10px; margin-bottom: 12px; }
.padding-unit { margin-left: auto; color: #f4f4f566; font-size: 9px; }
.text-padding-heading .s-icon { width: 23px; height: 23px; }
.padding-map { position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(3, auto); gap: 8px; align-items: center; }
.padding-map-outline { position: absolute; inset: 20px 26px; border: 1px dashed #7dd3fc30; border-radius: 9px; pointer-events: none; }
.padding-side { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; color: #f4f4f580; font-size: 9px; text-align: center; }
.padding-side input { width: 100%; min-width: 0; max-width: 100%; height: 31px; padding: 5px 3px; border: 1px solid #ffffff0e; border-radius: 6px; background: #202224; color: #f4f4f5; text-align: center; font: inherit; font-size: 11px; font-variant-numeric: tabular-nums; outline: none; appearance: textfield; -moz-appearance: textfield; }
.padding-side input::-webkit-inner-spin-button, .padding-side input::-webkit-outer-spin-button { appearance: none; margin: 0; }
.padding-side input:focus-visible { border-color: #7dd3fc; box-shadow: 0 0 0 2px #7dd3fc15; }
.padding-top { grid-area: 1 / 2; }
.padding-right { grid-area: 2 / 3; }
.padding-bottom { grid-area: 3 / 2; }
.padding-left { grid-area: 2 / 1; }
.padding-link { position: relative; grid-area: 2 / 2; justify-self: center; display: grid; place-items: center; width: 34px; height: 34px; margin-top: 15px; border: 1px solid #ffffff15; border-radius: 8px; color: #f4f4f580; background: #1c1e20; }
.padding-link[aria-pressed="true"] { color: #7dd3fc; border-color: #7dd3fc50; background: #20313a; }
.padding-link:hover { border-color: #7dd3fc80; }
.padding-link:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
.padding-mode { margin: 11px 0 0; color: #f4f4f580; font-size: 9px; text-align: center; }
.padding-help { margin: 10px 0 0; color: #f4f4f566; font-size: 9px; line-height: 1.6; }
.text-padding :disabled { opacity: .4; cursor: default; }
</style>
