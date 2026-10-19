<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ArrowLeft, Library, Pause, Pencil, Play, Save, Search, Trash2 } from 'lucide-vue-next';
import { useStudioStore } from '@/stores/studio';
import { animationFromPreset, cloneAnimation, sampleAnimation } from '@/lib/studio/animation';
import type { LayerAnimation } from '../../../../shared/production';

const props = withDefaults(defineProps<{ mode?: 'save' | 'library'; animation?: LayerAnimation; applyDisabled?: boolean; returnLabel?: string }>(), { mode: 'library', returnLabel: 'Close preset library' });
const emit = defineEmits<{ close: []; saved: []; apply: [animation: LayerAnimation]; busy: [value: boolean] }>();
const studio = useStudioStore();
const name = ref(''), query = ref(''), selectedId = ref(''), newName = ref('');
const error = ref(''), busy = ref(false), renaming = ref(false), deleting = ref(false);
const elapsed = ref(0), playing = ref(false);
let timer = 0, startedAt = 0;
const presets = computed(() => studio.animationPresets);
const filtered = computed(() => presets.value.filter(preset => preset.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const selected = computed(() => presets.value.find(preset => preset.id === selectedId.value));
const selectedAnimation = computed(() => selected.value ? animationFromPreset(selected.value) : undefined);
const total = computed(() => selectedAnimation.value ? selectedAnimation.value.durationMs + selectedAnimation.value.delayMs : 0);
const pose = computed(() => sampleAnimation(selectedAnimation.value, elapsed.value));
const previewTransform = computed(() => `translate(${960 + pose.value.x} ${540 + pose.value.y}) rotate(${pose.value.rotation}) scale(${pose.value.scale})`);

function stop() { cancelAnimationFrame(timer); playing.value = false; }
function tick(now: number) {
  elapsed.value = Math.min(total.value, now - startedAt);
  if (elapsed.value >= total.value) { stop(); return; }
  timer = requestAnimationFrame(tick);
}
function play() {
  if (playing.value) { stop(); return; }
  if (elapsed.value >= total.value) elapsed.value = 0;
  startedAt = performance.now() - elapsed.value; playing.value = true;
  timer = requestAnimationFrame(tick);
}
function seek(event: Event) { stop(); elapsed.value = Number((event.target as HTMLInputElement).value); }
function choose(id: string) { selectedId.value = id; }
watch(filtered, values => {
  if (!values.some(preset => preset.id === selectedId.value)) selectedId.value = values[0]?.id ?? '';
}, { immediate: true });
watch([() => selected.value?.id, () => selected.value?.updatedAt], () => {
  stop(); elapsed.value = 0; renaming.value = false; deleting.value = false; error.value = '';
});
watch(busy, value => emit('busy', value), { flush: 'sync' });
watch([name, newName], () => { error.value = ''; });
onBeforeUnmount(stop);

async function save() {
  if (busy.value || !props.animation || !name.value.trim()) return;
  busy.value = true; error.value = '';
  let saved = false;
  try { await studio.saveAnimationPreset(name.value.trim(), cloneAnimation(props.animation)); saved = true; }
  catch (reason) { error.value = (reason as Error).message || 'Unable to save this preset.'; }
  finally { busy.value = false; }
  if (saved) { emit('saved'); emit('close'); }
}
function apply() {
  if (busy.value || props.applyDisabled || !selected.value) return;
  emit('apply', animationFromPreset(selected.value));
}
function startRename() { if (!selected.value) return; newName.value = selected.value.name; deleting.value = false; renaming.value = true; error.value = ''; }
async function rename() {
  if (busy.value || !selected.value || !newName.value.trim()) return;
  const id = selected.value.id;
  busy.value = true; error.value = '';
  try { await studio.renameAnimationPreset(id, newName.value.trim()); renaming.value = false; }
  catch (reason) { error.value = (reason as Error).message || 'Unable to rename this preset.'; }
  finally { busy.value = false; }
}
async function remove() {
  if (busy.value || !selected.value) return;
  const id = selected.value.id;
  busy.value = true; error.value = '';
  try { await studio.deleteAnimationPreset(id); deleting.value = false; }
  catch (reason) { error.value = (reason as Error).message || 'Unable to delete this preset.'; }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="animation-preset-content" :data-animation-preset-mode="mode" :aria-label="mode === 'save' ? 'Save animation preset' : 'Animation presets'">
    <div v-if="mode === 'save'" class="animation-preset-save">
      <p class="animation-preset-hint">Keep this animation’s timing, easing, and keyframes for any layer or scene. Your current layer stays unchanged.</p>
      <form @submit.prevent="save">
        <label class="studio-field">Preset name<input v-model="name" aria-label="Preset name" maxlength="100" placeholder="e.g. Gentle lower third" autocomplete="off" :disabled="busy" autofocus /></label>
        <p v-if="error" class="studio-error" role="alert">{{ error }}</p>
        <div class="animation-preset-form-actions"><button type="button" class="s-button" aria-label="Cancel save preset" :disabled="busy" @click="emit('close')">Cancel</button><button class="s-button primary" :disabled="busy || !name.trim() || !animation" aria-label="Save preset"><Save :size="13" />{{ busy ? 'Saving…' : 'Save preset' }}</button></div>
      </form>
    </div>
    <template v-else>
      <p class="animation-preset-hint">Saved to this station. Apply a copy, then tweak it independently.</p>
      <label class="animation-preset-search"><Search :size="14" /><input v-model="query" aria-label="Search animation presets" placeholder="Search presets" :disabled="busy" /></label>
      <div v-if="presets.length" class="animation-preset-browser">
        <div class="animation-preset-list" aria-label="Saved animation presets">
          <button v-for="preset in filtered" :key="preset.id" :aria-label="`Select preset ${preset.name}`" :aria-pressed="selectedId === preset.id" :disabled="busy" @click="choose(preset.id)"><Library :size="14" /><span>{{ preset.name }}<small>{{ preset.animation.durationMs }} ms<template v-if="preset.animation.delayMs"> · {{ preset.animation.delayMs }} ms delay</template></small></span></button>
          <p v-if="!filtered.length" class="animation-preset-empty">No matching presets.</p>
        </div>
        <div v-if="selected && selectedAnimation" class="animation-preset-detail">
          <div class="animation-preset-preview" aria-label="Preset animation preview"><svg viewBox="0 0 1920 1080" aria-hidden="true"><path d="M960 0V1080M0 540H1920" stroke="#ffffff0c" stroke-width="3" /><g :transform="previewTransform" :opacity="pose.opacity"><rect x="-330" y="-148" width="660" height="296" rx="35" fill="#253d4a" stroke="#7dd3fc55" stroke-width="4" /><text x="0" y="26" text-anchor="middle" fill="#e1f4fc" font-family="system-ui, sans-serif" font-size="94" font-weight="500">Lumen</text></g></svg><span>PREVIEW ONLY</span></div>
          <div class="animation-preset-transport"><button class="s-button" :aria-label="playing ? 'Pause preset preview' : 'Play preset preview'" @click="play"><Pause v-if="playing" :size="12" /><Play v-else :size="12" />{{ playing ? 'Pause' : 'Preview' }}</button><output>{{ Math.round(elapsed) }} / {{ total }} ms</output></div>
          <input class="animation-preset-playhead" aria-label="Preset preview playhead" type="range" min="0" :max="total" :value="elapsed" @input="seek" />
          <h3>{{ selected.name }}</h3><p class="animation-preset-metadata">{{ selected.animation.keyframes.length }} keyframes · {{ selected.animation.easing.replaceAll('-', ' ') }}</p>
          <template v-if="deleting"><div class="animation-preset-confirm"><p>Delete “{{ selected.name }}”? Animations already applied to layers will not change.</p><div><button class="s-button" aria-label="Cancel delete preset" :disabled="busy" @click="deleting = false">Cancel</button><button class="s-button danger-text" aria-label="Confirm delete preset" :disabled="busy" @click="remove">{{ busy ? 'Deleting…' : 'Delete preset' }}</button></div></div></template>
          <form v-else-if="renaming" class="animation-preset-rename" @submit.prevent="rename"><label class="studio-field">New preset name<input v-model="newName" aria-label="New preset name" maxlength="100" :disabled="busy" /></label><div><button type="button" class="s-button" aria-label="Cancel rename preset" :disabled="busy" @click="renaming = false">Cancel</button><button class="s-button primary" aria-label="Save preset name" :disabled="busy || !newName.trim()">{{ busy ? 'Saving…' : 'Save name' }}</button></div></form>
          <div v-else class="animation-preset-detail-actions"><button class="s-button primary" aria-label="Apply preset" :disabled="busy || applyDisabled" @click="apply">Apply preset</button><button class="s-button animation-preset-icon" aria-label="Rename preset" title="Rename preset" :disabled="busy" @click="startRename"><Pencil :size="13" /></button><button class="s-button animation-preset-icon" aria-label="Delete preset" title="Delete preset" :disabled="busy" @click="deleting = true; error = ''"><Trash2 :size="13" /></button></div>
          <p v-if="applyDisabled" class="animation-preset-hint">Unlock the selected layer to apply a preset.</p>
          <p v-if="error" class="studio-error" role="alert">{{ error }}</p>
        </div>
      </div>
      <div v-else class="animation-preset-empty-state"><Library :size="26" /><h3>No saved presets yet</h3><p>Save an animation from the editor or inspector, then reuse it on any layer.</p></div>
      <div class="animation-preset-footer"><span>{{ presets.length }} saved {{ presets.length === 1 ? 'preset' : 'presets' }}</span><button class="s-button" :aria-label="returnLabel" :disabled="busy" @click="emit('close')"><ArrowLeft v-if="returnLabel === 'Back to animation editor'" :size="12" />{{ returnLabel === 'Back to animation editor' ? 'Back to editor' : 'Done' }}</button></div>
    </template>
  </section>
</template>

<style>
.animation-preset-content { min-width: 0; color: #f4f4f5; }
.animation-preset-content .animation-preset-hint { margin: 0 0 15px; font-size: 12px; line-height: 1.65; color: var(--text-muted); }
.animation-preset-content .studio-field { font-size: 11px; gap: 7px; }
.animation-preset-content .studio-field input { width: 100%; min-width: 0; min-height: 35px; box-sizing: border-box; }
.animation-preset-content .s-button { min-height: 32px; border-radius: var(--radius-control); padding: 7px 11px; font-size: 12px; justify-content: center; }
.animation-preset-content .animation-preset-search { display: flex; align-items: center; gap: 8px; padding: 0 11px; height: 36px; border: 1px solid #ffffff15; background: #0a0a0c55; border-radius: 7px; color: #f4f4f56a; }
.animation-preset-content .animation-preset-search:focus-within { border-color: #7dd3fc77; }
.animation-preset-content .animation-preset-search input { min-width: 0; width: 100%; padding: 6px 0; border: 0; outline: 0; font-size: 11px; color: #f4f4f5; background: transparent; }
.animation-preset-content .animation-preset-browser { display: grid; grid-template-columns: minmax(145px, .8fr) minmax(0, 1.2fr); gap: 20px; margin-top: 16px; }
.animation-preset-content .animation-preset-list { max-height: 370px; overflow-y: auto; min-width: 0; }
.animation-preset-content .animation-preset-list > button { display: flex; width: 100%; align-items: flex-start; gap: 10px; padding: 11px; border: 1px solid transparent; border-radius: 8px; text-align: left; color: #f4f4f5a0; }
.animation-preset-content .animation-preset-list > button > svg { margin-top: 1px; flex-shrink: 0; }
.animation-preset-content .animation-preset-list > button > span { min-width: 0; overflow-wrap: anywhere; font-size: 11px; line-height: 1.5; }
.animation-preset-content .animation-preset-list > button small { display: block; margin-top: 3px; font-size: 9px; color: #f4f4f55e; }
.animation-preset-content .animation-preset-list > button:hover { background: #ffffff06; }
.animation-preset-content .animation-preset-list > button[aria-pressed="true"] { color: #d8f1fd; background: #7dd3fc0c; border-color: #7dd3fc35; }
.animation-preset-content .animation-preset-preview { aspect-ratio: 16 / 9; position: relative; overflow: hidden; border: 1px solid #ffffff14; border-radius: 8px; background: #0a0a0c; }
.animation-preset-content .animation-preset-preview svg { display: block; width: 100%; height: 100%; }
.animation-preset-content .animation-preset-preview > span { position: absolute; bottom: 7px; left: 8px; font-size: 6px; letter-spacing: 1px; color: #f4f4f54d; }
.animation-preset-content .animation-preset-transport { display: flex; justify-content: space-between; align-items: center; gap: 9px; margin-top: 10px; }
.animation-preset-content .animation-preset-transport output { white-space: nowrap; font-size: 9px; color: #f4f4f575; font-variant-numeric: tabular-nums; }
.animation-preset-content .animation-preset-playhead { width: 100%; margin: 11px 0 3px; padding: 0; accent-color: #7dd3fc; height: 4px; }
.animation-preset-content .animation-preset-detail h3 { margin: 14px 0 4px; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
.animation-preset-content .animation-preset-metadata { margin: 0 0 15px; color: #f4f4f565; font-size: 10px; }
.animation-preset-content .animation-preset-detail-actions { display: flex; gap: 6px; }
.animation-preset-content .animation-preset-detail-actions > .primary { flex: 1; }
.animation-preset-content .animation-preset-icon { flex-shrink: 0; width: 33px; padding: 7px; }
.animation-preset-content .animation-preset-confirm, .animation-preset-content .animation-preset-rename { padding-top: 12px; border-top: 1px solid #ffffff12; }
.animation-preset-content .animation-preset-confirm > p { margin: 0 0 12px; color: #f4f4f59a; line-height: 1.7; font-size: 11px; }
.animation-preset-content .animation-preset-confirm > div, .animation-preset-content .animation-preset-rename > div { display: flex; gap: 7px; justify-content: flex-end; }
.animation-preset-content .animation-preset-detail > .animation-preset-hint { margin: 10px 0 0; }
.animation-preset-content .animation-preset-empty { font-size: 11px; color: #f4f4f56a; padding: 10px; }
.animation-preset-content .animation-preset-empty-state { display: grid; justify-items: center; text-align: center; padding: 40px 18px; color: #f4f4f55c; }
.animation-preset-content .animation-preset-empty-state svg { color: #7dd3fc8a; }
.animation-preset-content .animation-preset-empty-state h3 { margin: 15px 0 7px; font-size: 13px; font-weight: 500; color: #f4f4f5bd; }
.animation-preset-content .animation-preset-empty-state p { max-width: 300px; font-size: 11px; line-height: 1.7; margin: 0; }
.animation-preset-content .animation-preset-form-actions, .animation-preset-content .animation-preset-footer { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 20px; }
.animation-preset-content .animation-preset-footer { justify-content: space-between; padding-top: 15px; border-top: 1px solid #ffffff12; }
.animation-preset-content .animation-preset-footer > span { font-size: 10px; color: #f4f4f560; }
.animation-preset-content .studio-error { overflow-wrap: anywhere; margin: 12px 0 0; }
.studio-dialog.animation-preset-dialog { width: min(700px, calc(100vw - 32px)); max-width: calc(100vw - 24px); min-width: 0; box-sizing: border-box; padding: 24px !important; border-radius: var(--radius-panel) !important; gap: 15px; }
.studio-dialog.animation-preset-dialog.animation-preset-save-dialog { width: min(440px, calc(100vw - 32px)); }
@media (max-width: 520px) { .animation-preset-content .animation-preset-browser { grid-template-columns: minmax(0, 1fr); gap: 14px; } .animation-preset-content .animation-preset-list { max-height: 145px; } .studio-dialog.animation-preset-dialog { padding: 20px !important; } }
</style>
