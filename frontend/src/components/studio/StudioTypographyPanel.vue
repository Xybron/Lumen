<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown, Italic, Underline, AlignLeft, AlignCenter, AlignRight } from 'lucide-vue-next';
import { useStudioStore } from '@/stores/studio';
import { FONT_FAMILIES } from '@/lib/studio/text-style';
import StudioPropertyInput from './StudioPropertyInput.vue';
import type { SceneLayer } from '../../../../shared/production';

const props = defineProps<{ layer: SceneLayer; sceneId: string }>();
const studio = useStudioStore();
const identity = computed(() => `${props.sceneId}:${props.layer.id}`);
const strokeOn = computed(() => !!props.layer.textStroke?.width);
const shadowOn = computed(() => !!props.layer.textShadow);
const alignments = [
  { value: 'left', label: 'Align text left', icon: AlignLeft },
  { value: 'center', label: 'Align text center', icon: AlignCenter },
  { value: 'right', label: 'Align text right', icon: AlignRight },
] as const;
const weights = [[400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']] as const;
function patch(value: Partial<SceneLayer>, target = identity.value) {
  const [sceneId, layerId] = target.split(':');
  void studio.updateLayer(layerId, value, sceneId).catch(() => {});
}
function toggle(key: 'italic' | 'underline') {
  const sceneId = props.sceneId, layerId = props.layer.id;
  void studio.edit(draft => {
    const layer = draft.scenes.find(scene => scene.id === sceneId)?.layers.find(item => item.id === layerId);
    if (layer && !layer.locked) layer[key] = !layer[key];
  }).catch(() => {});
}
function effect<K extends 'textStroke' | 'textShadow'>(key: K, value: Partial<NonNullable<SceneLayer[K]>>, target = identity.value) {
  const [sceneId, layerId] = target.split(':');
  void studio.updateLayerTextEffect(layerId, key, value, sceneId).catch(() => {});
}
function textColor(value: string, target: string) {
  const [sceneId, layerId] = target.split(':');
  const current = studio.state?.scenes.find(scene => scene.id === sceneId)?.layers.find(layer => layer.id === layerId)?.color ?? '';
  patch({ color: value + (current.length === 9 && current.slice(7).toLowerCase() !== '00' ? current.slice(7) : '') }, target);
}
</script>

<template>
  <details class="inspector-group typography-panel" open>
    <summary><ChevronDown :size="12" /><span>Typography</span></summary>
    <label class="studio-field">Font
      <select aria-label="Font family" :value="layer.fontFamily ?? 'system'" @change="patch({ fontFamily: ($event.target as HTMLSelectElement).value as SceneLayer['fontFamily'] })">
        <option v-for="font in FONT_FAMILIES" :key="font.value" :value="font.value" :style="{ fontFamily: font.css }">{{ font.label }}</option>
      </select>
    </label>
    <div class="field-grid">
      <label class="studio-field">Size<StudioPropertyInput type="number" min="12" max="300" :identity="identity" :pending="!!studio.saving" :value="layer.fontSize" @commit="(value, target) => patch({ fontSize: Number(value) }, target)" /></label>
      <label class="studio-field">Weight<select aria-label="Weight" :value="layer.fontWeight" @change="patch({ fontWeight: Number(($event.target as HTMLSelectElement).value) })"><option v-if="!weights.some(([weight]) => weight === layer.fontWeight)" :value="layer.fontWeight">{{ layer.fontWeight }}</option><option v-for="[value, label] in weights" :key="value" :value="value">{{ label }}</option></select></label>
    </div>
    <div class="typography-style-row">
      <div class="typography-segments" role="group" aria-label="Text style">
        <button type="button" aria-label="Italic" title="Italic" :aria-pressed="!!layer.italic" @click="toggle('italic')"><Italic :size="15" /></button>
        <button type="button" aria-label="Underline" title="Underline" :aria-pressed="!!layer.underline" @click="toggle('underline')"><Underline :size="15" /></button>
      </div>
      <select aria-label="Text case" title="Text case" :value="layer.textTransform ?? 'none'" @change="patch({ textTransform: ($event.target as HTMLSelectElement).value as SceneLayer['textTransform'] })"><option value="none">Original case</option><option value="uppercase">UPPERCASE</option><option value="lowercase">lowercase</option></select>
    </div>
    <div class="field-grid typography-alignment">
      <div class="studio-field">Alignment<div class="typography-segments" role="group" aria-label="Text alignment"><button v-for="alignment in alignments" :key="alignment.value" type="button" :aria-label="alignment.label" :title="alignment.label" :aria-pressed="layer.align === alignment.value" @click="patch({ align: alignment.value })"><component :is="alignment.icon" :size="15" /></button></div></div>
      <label class="studio-field">Vertical<select aria-label="Vertical text alignment" :value="layer.verticalAlign ?? 'middle'" @change="patch({ verticalAlign: ($event.target as HTMLSelectElement).value as SceneLayer['verticalAlign'] })"><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select></label>
    </div>
    <div class="field-grid">
      <label class="studio-field" title="Multiple of the font size">Line height · ×<StudioPropertyInput aria-label="Line height" type="number" min="0.8" max="2.5" step="0.05" :identity="identity" :pending="!!studio.saving" :value="layer.lineHeight ?? 1.24" @commit="(value, target) => patch({ lineHeight: Number(value) }, target)" /></label>
      <label class="studio-field">Spacing · px<StudioPropertyInput aria-label="Letter spacing" type="number" min="-5" max="20" step="0.5" :identity="identity" :pending="!!studio.saving" :value="layer.letterSpacing ?? 0" @commit="(value, target) => patch({ letterSpacing: Number(value) }, target)" /></label>
    </div>
    <label class="studio-field color-field">Text color<StudioPropertyInput aria-label="Text color" type="color" live :identity="identity" :pending="!!studio.saving" :value="layer.color.slice(0, 7)" @commit="textColor" /><code>{{ layer.color }}</code></label>
    <details class="typography-effects">
      <summary><ChevronDown :size="12" /><span>Text effects</span><small v-if="strokeOn || shadowOn">On</small></summary>
      <label class="studio-check"><input type="checkbox" aria-label="Text outline" :checked="strokeOn" @change="patch({ textStroke: ($event.target as HTMLInputElement).checked ? { color: '#000000', width: 2 } : undefined })" />Outline</label>
      <div v-if="strokeOn" class="field-grid">
        <label class="studio-field">Width · px<StudioPropertyInput aria-label="Outline width" type="number" min="0" max="10" step="0.5" :identity="identity" :pending="!!studio.saving" :value="layer.textStroke!.width" @commit="(value, target) => effect('textStroke', { width: Number(value) }, target)" /></label>
        <label class="studio-field color-field">Color<StudioPropertyInput aria-label="Outline color" type="color" live :identity="identity" :pending="!!studio.saving" :value="layer.textStroke!.color.slice(0, 7)" @commit="(value, target) => effect('textStroke', { color: value }, target)" /></label>
      </div>
      <label class="studio-check"><input type="checkbox" aria-label="Text shadow" :checked="shadowOn" @change="patch({ textShadow: ($event.target as HTMLInputElement).checked ? { color: '#000000b3', blur: 6, offsetX: 0, offsetY: 2 } : undefined })" />Shadow</label>
      <template v-if="shadowOn">
        <div class="field-grid">
          <label class="studio-field">Blur · px<StudioPropertyInput aria-label="Shadow blur" type="number" min="0" max="30" :identity="identity" :pending="!!studio.saving" :value="layer.textShadow!.blur" @commit="(value, target) => effect('textShadow', { blur: Number(value) }, target)" /></label>
          <label class="studio-field color-field">Color<StudioPropertyInput aria-label="Shadow color" type="color" live :identity="identity" :pending="!!studio.saving" :value="layer.textShadow!.color.slice(0, 7)" @commit="(value, target) => effect('textShadow', { color: value }, target)" /></label>
          <label class="studio-field">X · px<StudioPropertyInput aria-label="Horizontal shadow offset" type="number" min="-30" max="30" :identity="identity" :pending="!!studio.saving" :value="layer.textShadow!.offsetX" @commit="(value, target) => effect('textShadow', { offsetX: Number(value) }, target)" /></label>
          <label class="studio-field">Y · px<StudioPropertyInput aria-label="Vertical shadow offset" type="number" min="-30" max="30" :identity="identity" :pending="!!studio.saving" :value="layer.textShadow!.offsetY" @commit="(value, target) => effect('textShadow', { offsetY: Number(value) }, target)" /></label>
        </div>
      </template>
    </details>
  </details>
</template>

<style scoped>
.typography-panel{min-width:0}.studio-field,.typography-effects{min-width:0;max-width:100%}
.field-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.typography-style-row{display:flex;align-items:center;gap:8px;margin-bottom:12px;min-width:0}
.typography-style-row>select{flex:1;min-width:0;background:var(--surface-2);border:1px solid transparent;border-radius:6px;padding:7px 8px;color:var(--text-primary);font-size:11px;min-height:32px}
.typography-segments{display:flex;align-items:center;gap:2px;min-width:0;background:var(--surface-2);border-radius:6px;padding:2px}
.typography-segments button{display:grid;place-items:center;min-width:29px;min-height:28px;flex:1;border-radius:4px;color:var(--text-muted)}
.typography-segments button[aria-pressed=true]{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.typography-segments button:hover{background:var(--surface-3)}
.typography-effects{border-top:1px solid var(--border-hair);margin-top:4px;padding-top:12px}
.typography-effects>summary{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:var(--text-muted);list-style:none;margin-bottom:12px}
.typography-effects>summary::-webkit-details-marker{display:none}.typography-effects>summary>svg{transform:rotate(-90deg)}.typography-effects[open]>summary>svg{transform:none}.typography-effects small{margin-left:auto;color:var(--accent);font-size:10px}
.typography-effects .color-field{grid-template-columns:minmax(0,1fr) 28px;align-content:start;gap:8px;padding-top:4px}
.typography-effects .studio-check input{accent-color:var(--accent)}
@media(pointer:coarse){.typography-segments button{min-height:40px}.typography-style-row>select{font-size:16px;min-height:40px}}
</style>
