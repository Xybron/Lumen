<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Play, Pause, RotateCcw, Plus, Trash2, Diamond, LockKeyhole, Library, Save } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useStudioStore } from '@/stores/studio';
import { useAnimationPreview } from '@/composables/useAnimationPreview';
import { ANIMATION_PRESETS, animationFromPreset, createAnimation, sampleAnimation } from '@/lib/studio/animation';
import ScenePoster from './ScenePoster.vue';
import AnimationPresetLibrary from './AnimationPresetLibrary.vue';
import StudioPropertyInput from './StudioPropertyInput.vue';
import type { AnimationKeyframe, LayerAnimation, SceneLayer, StudioScene, StudioSource } from '../../../../shared/production';

const open = defineModel<boolean>('open', { required: true });
const props = defineProps<{ scene: StudioScene; layer: SceneLayer; sources?: StudioSource[]; initialPreset?: LayerAnimation['preset'] | null }>();
const studio = useStudioStore(), preview = useAnimationPreview();
const draft = ref<LayerAnimation>(createAnimation('fade'));
const selectedFrame = ref(0), busy = ref(false), error = ref('');
const editorGeneration = ref(0);
const presetPanel = ref<'save' | 'library' | null>(null), presetBusy = ref(false), presetNotice = ref('');
const editorBusy = computed(() => busy.value || presetBusy.value);
let editingSceneId = '', editingLayerId = '';
const total = computed(() => draft.value.durationMs + draft.value.delayMs);
const playhead = computed(() => Math.min(total.value, Math.max(0, preview.elapsedMs.value ?? 0)));
const frame = computed(() => draft.value.keyframes[selectedFrame.value]);
const finalFrame = computed(() => selectedFrame.value === draft.value.keyframes.length - 1);
const edgeFrame = computed(() => selectedFrame.value === 0 || finalFrame.value);
function boundsForFrame(index: number): [number, number] | null {
  if (index <= 0 || index >= draft.value.keyframes.length - 1) return null;
  const previous = draft.value.keyframes[index - 1].offset, next = draft.value.keyframes[index + 1].offset;
  const margin = Math.min(0.001, (next - previous) / 4);
  const min = previous + margin, max = next - margin;
  return min > previous && max < next && min <= max ? [min * 100, max * 100] : null;
}
const offsetBounds = computed(() => boundsForFrame(selectedFrame.value));
const dirtyScene = computed<StudioScene>(() => ({ ...props.scene, layers: props.scene.layers.map(layer => layer.id === props.layer.id ? { ...layer, animation: draft.value } : layer) }));
const canApply = computed(() => !editorBusy.value && !presetPanel.value && !props.layer.locked && props.scene.id === editingSceneId && props.layer.id === editingLayerId);

function clone(animation: LayerAnimation): LayerAnimation { return { ...animation, keyframes: animation.keyframes.map(value => ({ ...value })) }; }
function syncOverride() {
  if (open.value) preview.setOverride({ sceneId: editingSceneId, layerId: editingLayerId, animation: clone(draft.value) });
}
function cleanup() { preview.stop(); preview.setOverride(null); }
watch(open, value => {
  if (!value) { cleanup(); return; }
  editingSceneId = props.scene.id; editingLayerId = props.layer.id;
  editorGeneration.value++;
  draft.value = clone(props.layer.animation ?? createAnimation('fade'));
  if (props.initialPreset === 'custom') { draft.value.preset = 'custom'; draft.value.enabled = true; }
  selectedFrame.value = 0; busy.value = false; error.value = ''; presetPanel.value = null; presetBusy.value = false; presetNotice.value = '';
  preview.stop(); syncOverride();
  preview.seek(editingSceneId, editingLayerId, 0, total.value);
}, { immediate: true });
watch(() => [props.scene.id, props.layer.id], () => {
  if (open.value && (props.scene.id !== editingSceneId || props.layer.id !== editingLayerId)) open.value = false;
});
watch(draft, syncOverride, { deep: true });
onBeforeUnmount(() => { if (open.value) cleanup(); });

function fieldIdentity(field: string, frameIndex?: number) {
  return `${editingSceneId}:${editingLayerId}:${editorGeneration.value}:${frameIndex ?? 'animation'}:${field}`;
}
function fieldOrigin(identity: string) {
  const [sceneId, layerId, generation, frameId] = identity.split(':');
  if (!open.value || editorBusy.value || props.layer.locked || sceneId !== editingSceneId || layerId !== editingLayerId ||
    sceneId !== props.scene.id || layerId !== props.layer.id || Number(generation) !== editorGeneration.value) return null;
  return { frameIndex: frameId === 'animation' ? null : Number(frameId) };
}
function numeric(input: string, min: number, max: number, fallback: number, integer = false) {
  const value = input.trim() === '' ? NaN : Number(input);
  const safe = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  return integer ? Math.round(safe) : safe;
}
function seek(ms: number) { preview.seek(editingSceneId, editingLayerId, ms, total.value); }
function chooseFrame(index: number) {
  selectedFrame.value = index;
  seek(draft.value.delayMs + draft.value.keyframes[index].offset * draft.value.durationMs);
}
function choosePreset(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value.startsWith('saved:')) {
    const saved = studio.animationPresets.find(preset => preset.id === value.slice(6));
    if (saved) loadAnimation(animationFromPreset(saved));
    return;
  }
  const preset = value as LayerAnimation['preset'];
  if (preset === 'custom') { draft.value.preset = 'custom'; return; }
  const next = createAnimation(preset);
  editorGeneration.value++;
  draft.value = { ...next, enabled: draft.value.enabled, durationMs: draft.value.durationMs, delayMs: draft.value.delayMs, easing: draft.value.easing };
  chooseFrame(0);
}
function loadAnimation(animation: LayerAnimation) {
  if (editorBusy.value || props.layer.locked) return;
  editorGeneration.value++;
  draft.value = clone(animation); presetPanel.value = null; selectedFrame.value = 0; chooseFrame(0);
  presetNotice.value = 'Preset loaded into this draft. Apply animation to save it to the layer.';
}
function openPresetPanel(mode: 'save' | 'library') { preview.pause(); presetNotice.value = ''; presetPanel.value = mode; }
function timing(key: 'durationMs' | 'delayMs', input: string, identity: string) {
  if (!fieldOrigin(identity)) return;
  draft.value[key] = numeric(input, key === 'durationMs' ? 100 : 0, 10000, draft.value[key], true);
  chooseFrame(selectedFrame.value);
}
function play() {
  if (preview.playing.value) preview.pause();
  else preview.play(editingSceneId, editingLayerId, total.value);
}
function restart() { seek(0); preview.play(editingSceneId, editingLayerId, total.value); }
function editFrame(key: keyof AnimationKeyframe, input: string, identity: string) {
  const origin = fieldOrigin(identity), index = origin?.frameIndex;
  if (index === null || index === undefined || !Number.isInteger(index) || index < 0 || index >= draft.value.keyframes.length - 1) return;
  const target = draft.value.keyframes[index], offsetRange = boundsForFrame(index);
  if (key === 'offset' && !offsetRange) return;
  const bounds: Record<keyof AnimationKeyframe, [number, number, number]> = {
    offset: [...(offsetRange ?? [0, 100]), 100],
    x: [-3840, 3840, 1], y: [-2160, 2160, 1], scale: [5, 400, 100], opacity: [0, 100, 100], rotation: [-360, 360, 1],
  };
  const [min, max, divisor] = bounds[key];
  const value = numeric(input, min, max, target[key] * divisor) / divisor;
  if (key === 'offset' && !(value > draft.value.keyframes[index - 1].offset && value < draft.value.keyframes[index + 1].offset)) return;
  draft.value.keyframes[index] = { ...target, [key]: value };
  draft.value.preset = 'custom'; chooseFrame(selectedFrame.value);
}
function addFrame() {
  if (draft.value.keyframes.length >= 12) return;
  const frames = draft.value.keyframes;
  let offset = Math.max(0.001, Math.min(0.999, (playhead.value - draft.value.delayMs) / draft.value.durationMs));
  if (offset <= 0.001 || offset >= 0.999 || frames.some(item => Math.abs(item.offset - offset) < 0.001)) {
    let widest = 0, start = 0;
    for (let i = 0; i < frames.length - 1; i++) {
      const gap = frames[i + 1].offset - frames[i].offset;
      if (gap > widest) { widest = gap; start = frames[i].offset; }
    }
    offset = start + widest / 2;
  }
  const pose = sampleAnimation(draft.value, draft.value.delayMs + offset * draft.value.durationMs);
  editorGeneration.value++;
  frames.push({ offset, x: pose.x, y: pose.y, scale: pose.scale, opacity: pose.opacity, rotation: pose.rotation });
  frames.sort((a, b) => a.offset - b.offset);
  draft.value.preset = 'custom'; chooseFrame(frames.findIndex(item => item.offset === offset));
}
function removeFrame() {
  if (edgeFrame.value) return;
  editorGeneration.value++;
  draft.value.keyframes.splice(selectedFrame.value, 1); draft.value.preset = 'custom';
  chooseFrame(Math.max(0, selectedFrame.value - 1));
}
async function apply() {
  if (!canApply.value) return;
  busy.value = true; error.value = '';
  try {
    await studio.updateLayer(editingLayerId, { animation: clone(draft.value) }, editingSceneId);
    open.value = false;
  } catch (reason) { error.value = (reason as Error).message || 'Unable to save this animation.'; }
  finally { busy.value = false; }
}
function rounded(value: number) { return Math.round(value * 100) / 100; }
</script>

<template>
  <Dialog v-model:open="open"><DialogContent data-animation-editor class="studio-dialog layer-animation-editor" :show-close-button="!editorBusy" @keydown.space.stop @escape-key-down="editorBusy && $event.preventDefault()" @interact-outside="editorBusy && $event.preventDefault()">
    <DialogHeader>
      <DialogTitle>Animation editor</DialogTitle>
      <DialogDescription>{{ layer.name }} · Entrance animation · Changes stay in Preview until Cut or Fade.</DialogDescription>
    </DialogHeader>
    <section v-if="presetPanel" class="animation-editor-preset-panel"><h3>{{ presetPanel === 'save' ? 'Save animation preset' : 'Animation presets' }}</h3><AnimationPresetLibrary :mode="presetPanel" :animation="draft" :apply-disabled="layer.locked" return-label="Back to animation editor" @busy="presetBusy = $event" @close="presetPanel = null" @apply="loadAnimation" @saved="presetNotice = 'Preset saved to this station. Your draft has not been applied to the layer.'" /></section>
    <template v-else>
    <div class="animation-editor-library-bar"><span>Entrance animation</span><div><button class="s-button" aria-label="Save animation preset" :disabled="editorBusy" @click="openPresetPanel('save')"><Save :size="12" />Save preset</button><button class="s-button" aria-label="Open preset library" :disabled="editorBusy" @click="openPresetPanel('library')"><Library :size="12" />My presets</button></div></div>
    <p v-if="presetNotice" class="animation-editor-preset-notice" role="status">{{ presetNotice }}</p>
    <div class="animation-editor-workspace">
      <div class="animation-editor-preview-column">
        <div class="animation-editor-preview" aria-label="Animation design preview">
          <ScenePoster :scene="dirtyScene" :sources="sources" :animation-time="playhead" :animation-layer-id="layer.id" :preview-media="true" :stream-for-source="studio.sourceStream" />
          <span class="animation-editor-preview-badge">PREVIEW ONLY</span>
        </div>
        <div class="animation-editor-transport">
          <div><button class="s-button" :aria-label="preview.playing.value ? 'Pause animation preview' : 'Play animation preview'" @click="play"><Pause v-if="preview.playing.value" :size="14" /><Play v-else :size="14" />{{ preview.playing.value ? 'Pause' : 'Play' }}</button><button class="s-button animation-icon-button" aria-label="Restart animation preview" title="Restart" @click="restart"><RotateCcw :size="14" /></button></div>
          <output aria-live="off">{{ Math.round(playhead) }} <span>/ {{ total }} ms</span></output>
        </div>
      </div>
      <fieldset :disabled="busy || layer.locked" class="animation-editor-settings">
        <label class="studio-check"><input v-model="draft.enabled" type="checkbox" aria-label="Enable entrance animation" /> Play when scene goes live</label>
        <label class="studio-field">Preset<select aria-label="Editor animation preset" :value="draft.preset" @change="choosePreset"><optgroup label="Built-in"><option v-for="preset in ANIMATION_PRESETS" :key="preset.value" :value="preset.value">{{ preset.label }}</option></optgroup><optgroup v-if="studio.animationPresets.length" label="My presets"><option v-for="preset in studio.animationPresets" :key="preset.id" :value="`saved:${preset.id}`">{{ preset.name }}</option></optgroup></select></label>
        <div class="field-grid"><label class="studio-field">Duration · ms<StudioPropertyInput aria-label="Editor animation duration" type="number" min="100" max="10000" step="50" integer :identity="fieldIdentity('durationMs')" :value="draft.durationMs" @commit="(value, identity) => timing('durationMs', value, identity)" /></label><label class="studio-field">Delay · ms<StudioPropertyInput aria-label="Editor animation delay" type="number" min="0" max="10000" step="50" integer :identity="fieldIdentity('delayMs')" :value="draft.delayMs" @commit="(value, identity) => timing('delayMs', value, identity)" /></label></div>
        <label class="studio-field">Easing<select v-model="draft.easing" aria-label="Editor animation easing"><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in & out</option></select></label>
        <p class="animation-editor-help">Positions are offsets from your canvas layout. Every animation finishes at the element’s designed position and opacity. Unavailable live sources use a labeled placeholder.</p>
      </fieldset>
    </div>
    <section class="animation-editor-timeline" aria-label="Animation timeline">
      <div class="animation-editor-section-heading"><h3><Diamond :size="13" />Keyframes <span>{{ draft.keyframes.length }} / 12</span></h3><button class="s-button" :disabled="busy || layer.locked || draft.keyframes.length >= 12" aria-label="Add keyframe" @click="addFrame"><Plus :size="13" />Add keyframe</button></div>
      <div class="animation-editor-track"><input aria-label="Animation playhead" type="range" min="0" :max="total" step="1" :value="playhead" @input="seek(Number(($event.target as HTMLInputElement).value))" /><div class="animation-editor-markers"><button v-for="(keyframe, index) in draft.keyframes" :key="index" :aria-label="`Keyframe ${index + 1}`" :aria-pressed="index === selectedFrame" :title="`${index === draft.keyframes.length - 1 ? 'Layout' : `Keyframe ${index + 1}`} · ${Math.round(draft.delayMs + keyframe.offset * draft.durationMs)} ms`" :style="{ left: (draft.delayMs + keyframe.offset * draft.durationMs) / total * 100 + '%' }" @click="chooseFrame(index)"><Diamond :size="12" :fill="index === selectedFrame ? 'currentColor' : 'none'" /></button></div></div>
      <div class="animation-editor-track-labels"><span>0 ms</span><span v-if="draft.delayMs">{{ draft.delayMs }} ms delay</span><span>{{ total }} ms</span></div>
      <div class="animation-editor-frame-heading"><span>{{ finalFrame ? 'Layout' : `Keyframe ${selectedFrame + 1}` }}<small v-if="finalFrame"><LockKeyhole :size="10" />Final design pose</small><small v-else> {{ rounded(frame.offset * 100) }}%</small></span><button class="s-icon" :disabled="edgeFrame || busy || layer.locked" aria-label="Delete keyframe" title="Delete keyframe" @click="removeFrame"><Trash2 :size="13" /></button></div>
      <fieldset :disabled="busy || layer.locked || finalFrame" class="animation-editor-frame-fields">
        <label class="studio-field">Time · %<StudioPropertyInput aria-label="Keyframe time" type="number" :disabled="edgeFrame || !offsetBounds" :min="offsetBounds?.[0] ?? 0" :max="offsetBounds?.[1] ?? 100" step="any" :identity="fieldIdentity('offset', selectedFrame)" :value="rounded(frame.offset * 100)" @commit="(value, identity) => editFrame('offset', value, identity)" /></label>
        <label class="studio-field">X · px<StudioPropertyInput aria-label="Keyframe X" type="number" min="-3840" max="3840" :identity="fieldIdentity('x', selectedFrame)" :value="rounded(frame.x)" @commit="(value, identity) => editFrame('x', value, identity)" /></label>
        <label class="studio-field">Y · px<StudioPropertyInput aria-label="Keyframe Y" type="number" min="-2160" max="2160" :identity="fieldIdentity('y', selectedFrame)" :value="rounded(frame.y)" @commit="(value, identity) => editFrame('y', value, identity)" /></label>
        <label class="studio-field">Scale · %<StudioPropertyInput aria-label="Keyframe scale" type="number" min="5" max="400" :identity="fieldIdentity('scale', selectedFrame)" :value="rounded(frame.scale * 100)" @commit="(value, identity) => editFrame('scale', value, identity)" /></label>
        <label class="studio-field">Opacity · %<StudioPropertyInput aria-label="Keyframe opacity" type="number" min="0" max="100" :identity="fieldIdentity('opacity', selectedFrame)" :value="rounded(frame.opacity * 100)" @commit="(value, identity) => editFrame('opacity', value, identity)" /></label>
        <label class="studio-field">Rotation · °<StudioPropertyInput aria-label="Keyframe rotation" type="number" min="-360" max="360" :identity="fieldIdentity('rotation', selectedFrame)" :value="rounded(frame.rotation)" @commit="(value, identity) => editFrame('rotation', value, identity)" /></label>
      </fieldset>
      <p v-if="finalFrame" class="animation-editor-help">The final keyframe is your canvas layout. Move or resize the element in Studio to change its final pose.</p>
    </section>
    </template>
    <p v-if="layer.locked" class="studio-help">This layer is locked. Unlock it in the inspector to change its animation.</p>
    <p v-if="error" class="studio-error" role="alert">{{ error }}</p>
    <div class="animation-editor-footer"><span><span class="tiny-dot" />Program is unchanged</span><div class="dialog-actions"><button class="s-button" :disabled="editorBusy" aria-label="Cancel animation changes" @click="open = false">Cancel</button><button class="s-button primary" :disabled="!canApply" aria-label="Apply animation" @click="apply">{{ busy ? 'Applying…' : 'Apply animation' }}</button></div></div>
  </DialogContent></Dialog>
</template>

<style>
.studio-dialog.layer-animation-editor { width: min(1040px, calc(100vw - 40px)); min-width: 0; max-width: calc(100vw - 24px); box-sizing: border-box; transition-property: opacity, transform; gap: 18px; padding: 24px !important; border-radius: var(--radius-panel) !important; background: var(--surface-1) !important; }
.layer-animation-editor .animation-editor-workspace > *, .layer-animation-editor .studio-field { min-width: 0; }
.layer-animation-editor .animation-editor-workspace { display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(230px, 1fr); gap: 24px; }
.layer-animation-editor fieldset { min-width: 0; border: 0; padding: 0; margin: 0; }
.layer-animation-editor fieldset:disabled { opacity: .45; }
.layer-animation-editor .animation-editor-preview { position: relative; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 9px; border: 1px solid #ffffff18; background: #0a0a0c; }
.layer-animation-editor .animation-editor-preview-badge { position: absolute; left: 10px; bottom: 10px; padding: 3px 6px; border-radius: 4px; font-size: 7px; color: #c4d6dc; background: #101217c9; letter-spacing: 1px; pointer-events: none; }
.layer-animation-editor .animation-editor-transport { display: flex; align-items: center; justify-content: space-between; padding-top: 12px; gap: 10px; }
.layer-animation-editor .animation-editor-transport > div { display: flex; gap: 6px; }
.layer-animation-editor .s-button { min-height: 32px; padding: 7px 10px; font-size: 12px; border-radius: var(--radius-control); }
.layer-animation-editor .animation-icon-button { padding: 7px; }
.layer-animation-editor output { font-size: 10px; font-variant-numeric: tabular-nums; color: #d8e0e4; white-space: nowrap; }
.layer-animation-editor output span { color: #f4f4f562; }
.layer-animation-editor .animation-editor-settings { display: grid; gap: 14px; align-content: start; }
.layer-animation-editor .studio-field { font-size: 11px; gap: 7px; }
.layer-animation-editor .studio-field input, .layer-animation-editor .studio-field select { min-height: 32px; border-radius: 6px; }
.layer-animation-editor .studio-check { margin: 0; color: #e0e1e5; font-size: 11px; }
.layer-animation-editor .studio-check input { accent-color: #7dd3fc; }
.layer-animation-editor .field-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.layer-animation-editor .animation-editor-help { color: var(--text-muted); font-size: 11px; line-height: 1.65; margin: 0; }
.layer-animation-editor .animation-editor-timeline { border-top: 1px solid #ffffff12; padding-top: 17px; }
.layer-animation-editor .animation-editor-section-heading, .layer-animation-editor .animation-editor-frame-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.layer-animation-editor h3 { display: flex; align-items: center; gap: 8px; color: #f4f4f5; font-size: 11px; font-weight: 500; }
.layer-animation-editor h3 > svg { color: #7dd3fc; }
.layer-animation-editor h3 > span { margin-left: 2px; font-size: 9px; color: #f4f4f560; font-weight: 400; }
.layer-animation-editor .animation-editor-track { position: relative; margin: 15px 7px 0; height: 35px; }
.layer-animation-editor .animation-editor-track input[type="range"] { width: 100%; height: 4px; margin: 0; appearance: none; background: #ffffff22; accent-color: #7dd3fc; border-radius: 5px; padding: 0; }
.layer-animation-editor .animation-editor-track input[type="range"]::-webkit-slider-thumb { appearance: none; width: 10px; height: 10px; background: #7dd3fc; border-radius: 50%; cursor: ew-resize; }
.layer-animation-editor .animation-editor-markers { position: absolute; left: 0; right: 0; top: 16px; height: 18px; }
.layer-animation-editor .animation-editor-markers button { position: absolute; display: grid; place-items: center; padding: 0; width: 24px; height: 23px; transform: translateX(-50%); color: #f4f4f58a; border-radius: 4px; }
.layer-animation-editor .animation-editor-markers button[aria-pressed="true"] { color: #7dd3fc; }
.layer-animation-editor .animation-editor-track-labels { display: flex; justify-content: space-between; margin-top: 3px; color: #f4f4f566; font-size: 9px; font-variant-numeric: tabular-nums; }
.layer-animation-editor .animation-editor-frame-heading { margin-top: 16px; padding-top: 13px; border-top: 1px solid #ffffff0d; }
.layer-animation-editor .animation-editor-frame-heading > span { display: flex; align-items: center; gap: 10px; font-size: 11px; }
.layer-animation-editor .animation-editor-frame-heading small { display: inline-flex; align-items: center; gap: 4px; color: #f4f4f567; font-size: 9px; }
.layer-animation-editor .animation-editor-frame-fields { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-top: 9px; }
.layer-animation-editor .animation-editor-frame-fields + .animation-editor-help { margin-top: 10px; }
.layer-animation-editor .animation-editor-footer { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #ffffff12; padding-top: 16px; gap: 12px; }
.layer-animation-editor .animation-editor-footer > span { display: flex; align-items: center; gap: 7px; font-size: 9px; color: #f4f4f575; }
.layer-animation-editor .animation-editor-footer .dialog-actions { margin: 0; }
.layer-animation-editor .animation-editor-library-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: -3px; }
.layer-animation-editor .animation-editor-library-bar > span { font-size: 12px; color: var(--text-muted); }
.layer-animation-editor .animation-editor-library-bar > div { display: flex; gap: 6px; }
.layer-animation-editor .animation-editor-preset-panel > h3 { margin: 0 0 15px; font-size: 13px; }
.layer-animation-editor .animation-editor-preset-panel .animation-preset-content { max-width: 730px; margin: 0 auto; }
.layer-animation-editor .animation-editor-preset-panel .animation-preset-save { max-width: 430px; margin: 0 auto; }
.layer-animation-editor .animation-editor-preset-notice { margin: -3px 0 0; color: #b3d8ba; font-size: 10px; line-height: 1.7; }
@media (max-width: 760px) {
  .studio-dialog.layer-animation-editor { width: calc(100vw - 24px); padding: 20px !important; gap: 15px; }
  .layer-animation-editor .animation-editor-workspace { grid-template-columns: minmax(0, 1fr); gap: 17px; }
  .layer-animation-editor .animation-editor-settings { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  .layer-animation-editor .animation-editor-settings > .studio-check, .layer-animation-editor .animation-editor-settings > .animation-editor-help { grid-column: 1 / -1; }
  .layer-animation-editor .animation-editor-settings > .field-grid { grid-column: 2; grid-row: 2; }
  .layer-animation-editor .animation-editor-frame-fields { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 420px) { .layer-animation-editor .animation-editor-footer > span { display: none; } .layer-animation-editor .animation-editor-footer { justify-content: flex-end; } }
</style>
