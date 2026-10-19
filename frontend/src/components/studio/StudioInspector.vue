<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { SlidersHorizontal, Trash2, Copy, ArrowUp, ArrowDown, Lock, Unlock, PanelRightClose, ChevronDown, Type, Square, Film, Layers, Play, Pause, Save, Library, SlidersHorizontal as AnimationSettings, AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useStudioStore } from '@/stores/studio';
import { useContentStore } from '@/stores/content';
import { useAnimationPreview } from '@/composables/useAnimationPreview';
import { layerGeometryInput, layerGeometryValue, type LayerAlignment } from '@/lib/studio/layer-layout';
import { ANIMATION_PRESETS, cloneAnimation, createAnimation } from '@/lib/studio/animation';
import LayerAnimationEditor from './LayerAnimationEditor.vue';
import AnimationPresetLibrary from './AnimationPresetLibrary.vue';
import StudioPropertyInput from './StudioPropertyInput.vue';
import type { LayerAnimation, SceneLayer, StudioScene } from '../../../../shared/production';
const studio = useStudioStore();
const preview = useAnimationPreview();
defineEmits<{ collapse: [] }>();
const layer = computed(() => studio.selectedLayer);
const scene = computed(() => studio.selectedScene);
const channelLayer = computed(() => layer.value?.kind === 'source' && studio.state?.sources.some(source => source.id === layer.value?.sourceId && source.kind === 'channel'));
const textChannelLayer = computed(() => {
  const source = studio.state?.sources.find(s => s.id === layer.value?.sourceId);
  return channelLayer.value && ['scripture', 'lyrics'].includes(useContentStore().content.channels.find(c => c.id === source?.channelId)?.kind ?? '');
});
const animationEditorOpen = ref(false);
const presetDialogOpen = ref(false), presetMode = ref<'save' | 'library'>('library'), presetBusy = ref(false);
const animationEditorPreset = ref<LayerAnimation['preset'] | null>(null);
const animation = computed(() => layer.value?.animation ?? createAnimation('fade'));
const animationEnabled = computed(() => !!layer.value?.animation?.enabled);
const layerPreviewPlaying = computed(() => preview.playing.value && preview.layerId.value === layer.value?.id);
watch([() => scene.value?.id, () => layer.value?.id], () => { animationEditorOpen.value = false; presetDialogOpen.value = false; });
const units = ref<'px' | '%'>('px');
try { if (localStorage.getItem('lumen.studio.layout-units') === '%') units.value = '%'; } catch { /* private browsing */ }
const layoutFields = [
  { key: 'x', label: 'X' }, { key: 'y', label: 'Y' }, { key: 'width', label: 'Width' }, { key: 'height', label: 'Height' },
] as const;
const alignments = [
  { value: 'left', label: 'Align left', icon: AlignHorizontalJustifyStart },
  { value: 'center', label: 'Align center', icon: AlignHorizontalJustifyCenter },
  { value: 'right', label: 'Align right', icon: AlignHorizontalJustifyEnd },
  { value: 'top', label: 'Align top', icon: AlignVerticalJustifyStart },
  { value: 'middle', label: 'Align middle', icon: AlignVerticalJustifyCenter },
  { value: 'bottom', label: 'Align bottom', icon: AlignVerticalJustifyEnd },
] as const;
const layerIndex = computed(() => scene.value?.layers.findIndex(item => item.id === layer.value?.id) ?? -1);
function fieldIdentity(field: string) { return `${scene.value?.id}:${layer.value?.id ?? 'scene'}:${field}`; }
function fieldLayer(identity?: string) {
  if (!identity) return layer.value;
  const [sceneId, layerId] = identity.split(':');
  return studio.state?.scenes.find(item => item.id === sceneId)?.layers.find(item => item.id === layerId);
}
function patch(value: Partial<SceneLayer>, identity?: string) {
  const target = fieldLayer(identity), sceneId = identity?.split(':')[0] ?? scene.value?.id;
  if (target) void studio.updateLayer(target.id, value, sceneId).catch(() => {});
}
function patchScene(value: Partial<StudioScene>, identity: string) { void studio.updateScene(value, identity.split(':')[0]).catch(() => {}); }
function number(event: Event) { return Number((event.target as HTMLInputElement).value); }
function text(event: Event) { return (event.target as HTMLInputElement).value; }
function geometryValue(key: 'x' | 'y' | 'width' | 'height') { return layer.value ? Math.round(layerGeometryValue(layer.value[key], key, units.value) * 1000) / 1000 : 0; }
function geometryInput(key: 'x' | 'y' | 'width' | 'height', input: string, identity: string) {
  const inputUnits = identity.endsWith(':px') ? 'px' : '%';
  const value = input === '' ? null : layerGeometryInput(Number(input), key, inputUnits);
  if (value !== null) patch({ [key]: value }, identity);
}
function colorValue(color: string, previous: string) {
  // Choosing a color turns an empty fill on. Preserve a deliberate partial
  // alpha, but do not leave the newly selected color completely invisible.
  return color + (previous.length === 9 && previous.slice(7).toLowerCase() !== '00' ? previous.slice(7) : '');
}
function colorInput(field: 'color' | 'background', color: string, identity: string) {
  const target = fieldLayer(identity);
  if (target) patch({ [field]: colorValue(color, target[field]) }, identity);
}
function sceneColorInput(color: string, identity: string) {
  const target = studio.state?.scenes.find(item => item.id === identity.split(':')[0]);
  if (target) patchScene({ background: colorValue(color, target.background) }, identity);
}
function setUnits(event: Event) {
  units.value = text(event) === '%' ? '%' : 'px';
  try { localStorage.setItem('lumen.studio.layout-units', units.value); } catch { /* private browsing */ }
}
function align(alignment: LayerAlignment) { if (layer.value) void studio.alignLayer(layer.value.id, alignment).catch(() => {}); }
function patchAnimation(value: Partial<LayerAnimation>, identity?: string) {
  const target = fieldLayer(identity);
  if (!target || target.locked) return;
  const current = target.animation ?? createAnimation('fade');
  patch({ animation: { ...current, ...value, keyframes: (value.keyframes ?? current.keyframes).map(frame => ({ ...frame })) } }, identity);
}
function setAnimationPreset(event: Event) {
  const preset = text(event);
  if (preset.startsWith('saved:')) {
    if (layer.value && !layer.value.locked && !studio.saving) void studio.applyAnimationPreset(preset.slice(6), layer.value.id, scene.value?.id).catch(() => {});
    return;
  }
  if (preset === 'none') { patchAnimation({ enabled: false }); return; }
  if (!animationEnabled.value && layer.value?.animation?.preset === preset) { patchAnimation({ enabled: true }); return; }
  if (preset === 'custom') {
    openAnimationEditor('custom');
    return;
  }
  const next = createAnimation(preset as LayerAnimation['preset']);
  patchAnimation({ ...next, durationMs: animation.value.durationMs, delayMs: animation.value.delayMs, easing: animation.value.easing, enabled: true });
}
function openAnimationEditor(initialPreset: LayerAnimation['preset'] | null = null) { animationEditorPreset.value = initialPreset; animationEditorOpen.value = true; }
function openPresetLibrary(mode: 'save' | 'library') { presetMode.value = mode; presetBusy.value = false; presetDialogOpen.value = true; }
async function applySavedAnimation(value: LayerAnimation) {
  if (!layer.value || layer.value.locked || studio.saving) return;
  try { await studio.updateLayer(layer.value.id, { animation: cloneAnimation(value) }, scene.value?.id); presetDialogOpen.value = false; }
  catch { /* The studio store reports save failures without closing the library. */ }
}
function animationTiming(key: 'durationMs' | 'delayMs', input: string, identity: string) {
  const value = input.trim() ? Number(input) : NaN;
  const safe = Number.isFinite(value) ? Math.round(Math.max(key === 'durationMs' ? 100 : 0, Math.min(10000, value))) : animation.value[key];
  patchAnimation({ [key]: safe }, identity);
}
function previewAnimation() {
  if (!scene.value || !layer.value || !animationEnabled.value) return;
  if (layerPreviewPlaying.value) preview.pause();
  else preview.play(scene.value.id, layer.value.id, animation.value.durationMs + animation.value.delayMs);
}
</script>
<template>
  <aside id="studio-inspector" class="studio-inspector" aria-label="Design inspector">
    <div class="inspector-heading">
      <SlidersHorizontal :size="14" /><h2>Design</h2><span class="inspector-scope">{{ layer ? 'Layer' : 'Scene' }}</span>
      <span v-if="studio.saving" class="saving-dot" title="Saving" />
      <button class="s-icon" aria-label="Collapse inspector" title="Collapse inspector" @click="$emit('collapse')"><PanelRightClose :size="16" /></button>
    </div>
    <div v-if="scene" class="inspector-body">
      <template v-if="layer">
        <div class="inspector-selection">
          <component :is="layer.kind === 'text' ? Type : layer.kind === 'source' ? Film : Square" :size="16" />
          <div><b>{{ layer.name }}</b><span>{{ layer.kind === 'source' ? 'Source layer' : layer.kind === 'text' ? 'Text layer' : 'Shape layer' }}</span></div>
          <button class="s-icon" :aria-label="layer.locked ? 'Unlock layer' : 'Lock layer'" @click="patch({ locked: !layer.locked })"><Lock v-if="layer.locked" :size="13" /><Unlock v-else :size="13" /></button>
        </div>
        <label class="studio-field">Name<StudioPropertyInput data-inspector-layer-name aria-label="Layer name" :identity="fieldIdentity('name')" :pending="!!studio.saving" :value="layer.name" trim nonempty maxlength="100" @commit="(value, identity) => patch({ name: value }, identity)" /></label>
        <fieldset :disabled="layer.locked" class="inspector-fields">
          <label v-if="layer.kind === 'source'" class="studio-field">Source<select :value="layer.sourceId" @change="patch({ sourceId: text($event) })"><option v-for="source in studio.state?.sources" :key="source.id" :value="source.id">{{ source.name }}</option></select></label>
          <p v-if="textChannelLayer" class="inspector-channel-note">Live text comes from its channel. Style and position it here; place images or looping video on layers below it.</p>
          <template v-else-if="channelLayer"><label class="studio-field">Channel presentation<select aria-label="Channel presentation" :value="layer.channelStyle ?? 'slide'" @change="patch({ channelStyle: text($event) as SceneLayer['channelStyle'] })"><option value="slide">Full slide · channel design</option><option value="overlay">Overlay · layer styling</option></select></label><p class="inspector-channel-note">{{ layer.channelStyle === 'overlay' ? 'Uses this layer’s fill and typography. Clearing the channel reveals the layers below it.' : 'Uses the presentation’s full slide design.' }}</p></template>
          <label v-if="layer.kind === 'text'" class="studio-field">Text<StudioPropertyInput multiline :identity="fieldIdentity('text')" :pending="!!studio.saving" :value="layer.text" rows="4" maxlength="8000" @commit="(value, identity) => patch({ text: value }, identity)" /></label>
          <details class="inspector-group" open>
            <summary><ChevronDown :size="12" /><span>Layout</span><small>1920 × 1080</small></summary>
            <div v-if="textChannelLayer" class="inspector-placement" role="group" aria-label="Channel text placement"><button class="s-button" @click="studio.presetLayer(layer.id, 'lower-third').catch(() => {})">Lower third</button><button class="s-button" @click="studio.presetLayer(layer.id, 'upper-third').catch(() => {})">Upper third</button><button class="s-button" @click="studio.presetLayer(layer.id, 'full').catch(() => {})">Full view</button></div>
            <div class="inspector-alignments" role="group" aria-label="Align layer to canvas"><button v-for="alignment in alignments" :key="alignment.value" class="s-icon" :aria-label="alignment.label" :title="alignment.label" @click="align(alignment.value)"><component :is="alignment.icon" :size="14" /></button></div>
            <div class="inspector-layout-units"><span>Position & size</span><select aria-label="Layout units" :value="units" @change="setUnits"><option value="px">px</option><option value="%">%</option></select></div>
            <div class="field-grid"><label v-for="field in layoutFields" :key="field.key" class="studio-field">{{ field.label }}<StudioPropertyInput type="number" :identity="fieldIdentity(`${field.key}:${units}`)" :pending="!!studio.saving" :value="geometryValue(field.key)" :step="units === 'px' ? 1 : 0.1" :min="layerGeometryValue(field.key === 'x' || field.key === 'y' ? -100 : 1, field.key, units)" :max="layerGeometryValue(field.key === 'x' || field.key === 'y' ? 100 : 200, field.key, units)" @commit="(value, identity) => geometryInput(field.key, value, identity)" /></label></div>
            <label v-if="layer.kind === 'source' && !textChannelLayer" class="studio-field">Image fit<select :value="layer.fit" @change="patch({ fit: text($event) as SceneLayer['fit'] })"><option value="cover">Fill frame (crop)</option><option value="contain">Fit inside frame</option></select></label>
          </details>
          <details v-if="layer.kind === 'text' || textChannelLayer || (channelLayer && layer.channelStyle === 'overlay')" class="inspector-group" open>
            <summary><ChevronDown :size="12" /><span>Typography</span></summary>
            <div class="field-grid"><label class="studio-field">Size<StudioPropertyInput type="number" min="12" max="300" :identity="fieldIdentity('fontSize')" :pending="!!studio.saving" :value="layer.fontSize" @commit="(value, identity) => patch({ fontSize: Number(value) }, identity)" /></label><label class="studio-field">Weight<select :value="layer.fontWeight" @change="patch({ fontWeight: number($event) })"><option :value="400">Regular</option><option :value="500">Medium</option><option :value="600">Semibold</option><option :value="700">Bold</option></select></label></div>
            <label class="studio-field">Alignment<select :value="layer.align" @change="patch({ align: text($event) as SceneLayer['align'] })"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
            <label class="studio-field color-field">Text color<StudioPropertyInput type="color" live :identity="fieldIdentity('color')" :pending="!!studio.saving" :value="layer.color.slice(0, 7)" @commit="(value, identity) => colorInput('color', value, identity)" /><code>{{ layer.color }}</code></label>
          </details>
          <details class="inspector-group" open>
            <summary><ChevronDown :size="12" /><span>Appearance</span></summary>
            <label class="studio-field">Opacity <span>{{ Math.round(layer.opacity * 100) }}%</span><StudioPropertyInput type="range" live min="0" max="1" step="0.01" :identity="fieldIdentity('opacity')" :pending="!!studio.saving" :value="layer.opacity" @commit="(value, identity) => patch({ opacity: Number(value) }, identity)" /></label>
            <label class="studio-field color-field">Fill<StudioPropertyInput type="color" live :identity="fieldIdentity('background')" :pending="!!studio.saving" :value="layer.background.slice(0, 7)" @commit="(value, identity) => colorInput('background', value, identity)" /><code>{{ layer.background }}</code></label>
            <label class="studio-check"><input type="checkbox" :checked="layer.background.length === 9 && layer.background.endsWith('00')" @change="patch({ background: ($event.target as HTMLInputElement).checked ? layer.background.slice(0, 7) + '00' : layer.background.slice(0, 7) })" /> Transparent fill</label>
            <label class="studio-field">Corner radius<StudioPropertyInput type="number" min="0" max="200" :identity="fieldIdentity('radius')" :pending="!!studio.saving" :value="layer.radius" @commit="(value, identity) => patch({ radius: Number(value) }, identity)" /></label>
          </details>
          <details class="inspector-group inspector-animation" open>
            <summary><ChevronDown :size="12" /><span>Animation</span><small>{{ animationEnabled ? 'On live' : 'None' }}</small></summary>
            <fieldset class="animation-quick-fields" :disabled="!!studio.saving">
              <label class="studio-field">Entrance<select aria-label="Animation preset" :value="animationEnabled ? animation.preset : 'none'" @change="setAnimationPreset"><option value="none">None</option><optgroup label="Built-in"><option v-for="preset in ANIMATION_PRESETS" :key="preset.value" :value="preset.value">{{ preset.label }}</option></optgroup><optgroup v-if="studio.animationPresets.length" label="My presets"><option v-for="preset in studio.animationPresets" :key="preset.id" :value="`saved:${preset.id}`">{{ preset.name }}</option></optgroup></select></label>
              <template v-if="animationEnabled">
                <div class="field-grid"><label class="studio-field">Duration · ms<StudioPropertyInput aria-label="Animation duration" type="number" min="100" max="10000" step="50" integer :identity="fieldIdentity('animationDuration')" :pending="!!studio.saving" :value="animation.durationMs" @commit="(value, identity) => animationTiming('durationMs', value, identity)" /></label><label class="studio-field">Delay · ms<StudioPropertyInput aria-label="Animation delay" type="number" min="0" max="10000" step="50" integer :identity="fieldIdentity('animationDelay')" :pending="!!studio.saving" :value="animation.delayMs" @commit="(value, identity) => animationTiming('delayMs', value, identity)" /></label></div>
                <label class="studio-field">Easing<select aria-label="Animation easing" :value="animation.easing" @change="patchAnimation({ easing: text($event) as LayerAnimation['easing'] })"><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in & out</option></select></label>
              </template>
            </fieldset>
            <div class="inspector-animation-actions"><button class="s-button" aria-label="Preview layer animation" :disabled="!animationEnabled" @click="previewAnimation"><Pause v-if="layerPreviewPlaying" :size="12" /><Play v-else :size="12" />{{ layerPreviewPlaying ? 'Pause' : 'Preview' }}</button><button class="s-button" aria-label="Open animation editor" @click="openAnimationEditor()"><AnimationSettings :size="12" />Editor</button></div>
            <p class="inspector-animation-note">Plays when this scene goes live. Preview never changes Program.</p>
          </details>
        </fieldset>
        <div class="inspector-animation-library-tools"><button class="s-button" aria-label="Save animation preset" :disabled="!layer.animation || !!studio.saving" @click="openPresetLibrary('save')"><Save :size="12" />Save preset</button><button class="s-button" aria-label="Animation preset library" @click="openPresetLibrary('library')"><Library :size="12" />My presets<span v-if="studio.animationPresets.length">{{ studio.animationPresets.length }}</span></button></div>
        <div class="inspector-layer-actions"><button class="s-button" :disabled="layer.locked || layerIndex >= (scene?.layers.length ?? 0) - 1" @click="studio.arrangeLayer(layer.id, 'forward').catch(() => {})" title="Bring forward" aria-label="Bring selected layer forward"><ArrowUp :size="14" /></button><button class="s-button" :disabled="layer.locked || layerIndex <= 0" @click="studio.arrangeLayer(layer.id, 'backward').catch(() => {})" title="Send backward" aria-label="Send selected layer backward"><ArrowDown :size="14" /></button><button class="s-button" @click="studio.duplicateLayer(layer.id).catch(() => {})" title="Duplicate layer" aria-label="Duplicate selected layer"><Copy :size="14" /></button><button class="s-button danger-text" :disabled="layer.locked" @click="studio.removeLayer(layer.id).catch(() => {})" title="Delete layer" aria-label="Delete selected layer"><Trash2 :size="14" /></button></div>
      </template>
      <template v-else>
        <div class="inspector-selection"><Layers :size="16" /><div><b>{{ scene.name }}</b><span>Scene settings · {{ scene.layers.length }} layers</span></div></div>
        <label class="studio-field">Scene name<StudioPropertyInput :identity="fieldIdentity('name')" :pending="!!studio.saving" :value="scene.name" trim nonempty maxlength="100" @commit="(value, identity) => patchScene({ name: value }, identity)" /></label>
        <details class="inspector-group" open><summary><ChevronDown :size="12" /><span>Canvas</span><small>16:9</small></summary><div class="scene-spec"><span>Resolution</span><b>1920 × 1080</b><span>Frame rate</span><b>30 fps</b><span>Publish changes</span><b>Cut or Fade</b></div></details>
        <details class="inspector-group" open><summary><ChevronDown :size="12" /><span>Appearance</span></summary><label class="studio-field color-field">Background<StudioPropertyInput type="color" live :identity="fieldIdentity('background')" :pending="!!studio.saving" :value="scene.background.slice(0, 7)" @commit="sceneColorInput" /><code>{{ scene.background }}</code></label></details>
        <div class="inspector-note"><span>Scene setup</span><p>Add sources, then arrange text and graphics in Preview.</p><p>Select a layer to edit its properties. Changes go live when you Cut or Fade to Program.</p></div>
      </template>
    </div>
    <div v-else class="inspector-body studio-help">Create a scene to begin.</div>
    <div class="inspector-footer"><span class="tiny-dot" />{{ studio.saving ? 'Saving changes…' : 'Changes saved to this station' }}</div>
    <LayerAnimationEditor v-if="scene && layer" v-model:open="animationEditorOpen" :scene="scene" :layer="layer" :sources="studio.state?.sources" :initial-preset="animationEditorPreset" />
    <Dialog v-model:open="presetDialogOpen"><DialogContent class="studio-dialog animation-preset-dialog" :class="{ 'animation-preset-save-dialog': presetMode === 'save' }" :show-close-button="!presetBusy" @keydown.space.stop @escape-key-down="presetBusy && $event.preventDefault()" @interact-outside="presetBusy && $event.preventDefault()"><DialogHeader><DialogTitle>{{ presetMode === 'save' ? 'Save animation preset' : 'Animation presets' }}</DialogTitle><DialogDescription>Reusable animations for your station. Your canvas layout stays intact.</DialogDescription></DialogHeader><AnimationPresetLibrary v-if="presetDialogOpen" :mode="presetMode" :animation="animation" :apply-disabled="!layer || layer.locked || !!studio.saving" @busy="presetBusy = $event" @close="presetDialogOpen = false" @apply="applySavedAnimation" /></DialogContent></Dialog>
  </aside>
</template>

<style scoped>
.inspector-placement { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 12px; }
.inspector-placement .s-button { flex: 1; padding: 6px; font-size: 10px; white-space: nowrap; }
.inspector-alignments { display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; padding: 2px 0 13px; }
.inspector-channel-note { margin: -5px 0 15px; font-size: 10px; line-height: 1.6; color: #f4f4f580; }
.inspector-alignments .s-icon { width: 100%; height: 29px; border-radius: 5px; }
.inspector-alignments .s-icon:nth-child(4) { border-left: 1px solid #ffffff12; border-radius: 0 5px 5px 0; }
.inspector-layout-units { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; color: #f4f4f566; font-size: 9px; }
.inspector-layout-units select { width: 48px; min-height: 25px; padding: 3px 5px; font: inherit; font-size: 10px; color: #f4f4f5ac; border: 1px solid #ffffff12; border-radius: 5px; background: #ffffff04; outline: none; }
.inspector-layout-units select:focus-visible { border-color: #7dd3fc88; }
.inspector-fields:disabled .inspector-alignments { opacity: .35; }
.animation-quick-fields { border: 0; margin: 0; padding: 0; min-width: 0; }
.animation-quick-fields:disabled { opacity: .45; }
.inspector-animation-actions { display: flex; gap: 6px; }
.inspector-animation-actions .s-button { flex: 1; justify-content: center; min-height: 29px; padding: 6px 8px; font-size: 10px; border-radius: 6px; }
.inspector-animation-note { margin: 11px 0 13px; font-size: 9px; line-height: 1.6; color: #f4f4f560; }
.inspector-animation-library-tools { display: flex; gap: 6px; margin: 0 0 16px; }
.inspector-animation-library-tools .s-button { flex: 1; justify-content: center; min-width: 0; min-height: 29px; padding: 6px 7px; font-size: 10px; border-radius: 6px; }
.inspector-animation-library-tools .s-button > span { margin-left: 3px; color: #f4f4f570; font-size: 9px; }
</style>
