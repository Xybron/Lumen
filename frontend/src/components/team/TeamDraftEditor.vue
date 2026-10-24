<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Plus, Trash2, ArrowUp, ArrowDown, Type, Layers, Code2 } from 'lucide-vue-next';

type DraftObject = Record<string, unknown>;
const props = defineProps<{ kind: string; document: DraftObject; readonly?: boolean }>();
const emit = defineEmits<{ (event: 'update:document', value: DraftObject): void }>();
const selectedIndex = ref(0), advanced = ref(false), json = ref(''), jsonError = ref('');
const isScene = computed(() => props.kind === 'scene');
const collectionKey = computed(() => isScene.value ? 'layers' : 'items');
const entries = computed<DraftObject[]>(() => {
  const raw = props.document[collectionKey.value];
  return Array.isArray(raw) ? raw.filter(entry => !!entry && typeof entry === 'object' && !Array.isArray(entry)) as DraftObject[] : [];
});
const selected = computed(() => entries.value[selectedIndex.value]);
watch(() => props.kind, () => { selectedIndex.value = 0; advanced.value = false; });
watch(() => entries.value.length, length => { selectedIndex.value = Math.max(0, Math.min(selectedIndex.value, length - 1)); });
function patchDocument(patch: DraftObject) { emit('update:document', { ...props.document, ...patch, schemaVersion: 1 }); }
function patchEntry(index: number, patch: DraftObject) {
  if (props.readonly) return;
  const next = entries.value.map((entry, item) => item === index ? { ...entry, ...patch } : entry);
  patchDocument({ [collectionKey.value]: next });
}
function value(event: Event) { return (event.target as HTMLInputElement).value; }
function number(event: Event, fallback: number, minimum: number, maximum: number) {
  const raw = Number(value(event));
  return Number.isFinite(raw) ? Math.max(minimum, Math.min(maximum, raw)) : fallback;
}
function add() {
  if (props.readonly || entries.value.length >= 100) return;
  const next = isScene.value ? { id: crypto.randomUUID(), kind: 'text', name: 'Text', text: 'Your words here', x: 10, y: 35, width: 80, height: 25, color: '#ffffff', fontSize: 72, visible: true, opacity: 1 } : { id: crypto.randomUUID(), type: props.kind === 'presentation' ? 'text' : props.kind, title: '', body: '', reference: '', durationMs: 30000 };
  patchDocument({ [collectionKey.value]: [...entries.value, next] });
  selectedIndex.value = entries.value.length;
}
function remove() {
  if (props.readonly) return;
  patchDocument({ [collectionKey.value]: entries.value.filter((_, index) => index !== selectedIndex.value) });
}
function reorder(direction: number) {
  if (props.readonly) return;
  const target = selectedIndex.value + direction;
  if (target < 0 || target >= entries.value.length) return;
  const next = [...entries.value];
  [next[target], next[selectedIndex.value]] = [next[selectedIndex.value], next[target]];
  selectedIndex.value = target;
  patchDocument({ [collectionKey.value]: next });
}
function openAdvanced() { json.value = JSON.stringify(props.document, null, 2); jsonError.value = ''; advanced.value = !advanced.value; }
function applyJson() {
  if (props.readonly) return;
  try {
    const result: unknown = JSON.parse(json.value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Use a JSON object for the draft.');
    if (json.value.length > 250000) throw new Error('This draft is too large. Keep shared text and design drafts below 250 KB; media stays on the station.');
    emit('update:document', { ...result, schemaVersion: 1 }); advanced.value = false;
  } catch (error) { jsonError.value = (error as Error).message; }
}
function text(entry: DraftObject, key: string, fallback = '') { return typeof entry[key] === 'string' ? entry[key] as string : fallback; }
function geometry(entry: DraftObject, key: string, fallback: number) { const result = Number(entry[key]); return Number.isFinite(result) ? result : fallback; }
function safeColor(raw: unknown, fallback: string) { return typeof raw === 'string' && /^#[\da-f]{3,8}$/i.test(raw) ? raw : fallback; }
function previewStyle(entry: DraftObject) {
  return { left: `${geometry(entry, 'x', 10)}%`, top: `${geometry(entry, 'y', 30)}%`, width: `${geometry(entry, 'width', 80)}%`, height: `${geometry(entry, 'height', 25)}%`, color: safeColor(entry.color, '#ffffff'), background: safeColor(entry.background, 'transparent'), fontSize: `${geometry(entry, 'fontSize', 72) / 19.2}cqw`, textAlign: ['left', 'right', 'center'].includes(text(entry, 'align')) ? text(entry, 'align') as 'left' | 'right' | 'center' : 'center', opacity: geometry(entry, 'opacity', 1) };
}
</script>

<template>
  <div class="team-draft-editor">
    <div class="team-draft-main">
      <div class="team-section-label"><span>{{ isScene ? 'Scene draft' : 'Content preview' }}</span><span>Not live</span></div>
      <div class="team-draft-preview" :style="{ background: isScene ? safeColor(document.background, '#151619') : '#161e20' }" aria-label="Shared draft preview">
        <template v-if="isScene">
          <button v-for="(entry, index) in entries" v-show="entry.visible !== false" :key="String(entry.id ?? index)" type="button" class="team-preview-layer" :class="{ selected: selectedIndex === index }" :style="previewStyle(entry)" :aria-label="`Select ${text(entry, 'name', `layer ${index + 1}`)}`" @click="selectedIndex = index"><span>{{ entry.kind === 'source' ? text(entry, 'name', 'Station source') : text(entry, 'text') }}</span></button>
          <p v-if="!entries.length" class="team-preview-placeholder">Add a text layer to start your scene.</p>
        </template>
        <div v-else-if="selected" class="team-preview-copy">
          <h2 v-if="text(selected, 'title')">{{ text(selected, 'title') }}</h2>
          <p>{{ text(selected, 'body') || 'Your content appears here.' }}</p>
          <strong v-if="text(selected, 'reference')">{{ text(selected, 'reference') }}</strong>
        </div>
        <p v-else class="team-preview-placeholder">Add content to start this channel draft.</p>
      </div>
      <p class="team-draft-caption">Shared preparation only. An operator chooses when to use this on the station.</p>
      <div class="team-entry-heading"><h3><component :is="isScene ? Layers : Type" :size="15" />{{ isScene ? 'Layers' : 'Content' }}<span>{{ entries.length }}</span></h3><button type="button" class="team-icon-button" :disabled="readonly || entries.length >= 100" :aria-label="isScene ? 'Add text layer' : 'Add content'" @click="add"><Plus :size="15" /></button></div>
      <div class="team-entry-list" :aria-label="isScene ? 'Draft layers' : 'Draft content'">
        <button v-for="(entry, index) in entries" :key="String(entry.id ?? index)" type="button" class="team-entry" :class="{ selected: selectedIndex === index }" @click="selectedIndex = index"><span class="team-entry-index">{{ String(index + 1).padStart(2, '0') }}</span><span><b>{{ text(entry, isScene ? 'name' : 'title') || text(entry, 'reference') || (isScene ? 'Text layer' : `Content ${index + 1}`) }}</b><small>{{ text(entry, isScene ? 'text' : 'body').slice(0, 100) || (isScene ? text(entry, 'kind') : 'No text yet') }}</small></span></button>
        <div v-if="!entries.length" class="team-inline-empty">{{ isScene ? 'No layers yet.' : 'No content yet.' }}</div>
      </div>
    </div>
    <aside class="team-draft-inspector" aria-label="Draft properties">
      <div class="team-section-label"><span>{{ isScene ? 'Design properties' : 'Content properties' }}</span><button type="button" class="team-icon-button" title="Advanced draft JSON" aria-label="Advanced draft JSON" :aria-expanded="advanced" @click="openAdvanced"><Code2 :size="15" /></button></div>
      <template v-if="advanced">
        <label class="team-field">Draft JSON<textarea v-model="json" class="team-json" :readonly="readonly" spellcheck="false" rows="20" /></label>
        <p v-if="jsonError" class="team-error" role="alert">{{ jsonError }}</p>
        <button v-if="!readonly" type="button" class="team-button" @click="applyJson">Apply to draft</button>
        <p class="team-subtle">This changes only the editor. Save the draft to share it with your team.</p>
      </template>
      <template v-else>
        <label v-if="isScene" class="team-field">Canvas background<div class="team-color-field"><input type="color" :value="safeColor(document.background, '#151619').slice(0, 7)" :disabled="readonly" @input="patchDocument({ background: value($event) })" /><input type="text" :value="String(document.background ?? '#151619')" :disabled="readonly" maxlength="9" @change="patchDocument({ background: value($event) })" /></div></label>
        <template v-if="selected">
          <div class="team-inspector-divider" />
          <label class="team-field">{{ isScene ? 'Layer name' : 'Title' }}<input :value="text(selected, isScene ? 'name' : 'title')" :disabled="readonly" maxlength="160" @input="patchEntry(selectedIndex, { [isScene ? 'name' : 'title']: value($event) })" /></label>
          <label class="team-field">{{ isScene ? 'Text' : 'Content' }}<textarea :value="text(selected, isScene ? 'text' : 'body')" :disabled="readonly || (isScene && selected.kind === 'source')" rows="7" @input="patchEntry(selectedIndex, { [isScene ? 'text' : 'body']: value($event) })" /></label>
          <p v-if="isScene && selected.kind === 'source'" class="team-subtle">Live sources stay on the station. This layer is a draft placeholder.</p>
          <label v-if="!isScene" class="team-field">Reference / caption<input :value="text(selected, 'reference')" :disabled="readonly" maxlength="240" @input="patchEntry(selectedIndex, { reference: value($event) })" /></label>
          <template v-if="isScene">
            <div class="team-field-grid"><label v-for="field in ['x', 'y', 'width', 'height']" :key="field" class="team-field">{{ ({ x: 'X position %', y: 'Y position %', width: 'Width %', height: 'Height %' } as Record<string, string>)[field] }}<input type="number" :min="field === 'x' || field === 'y' ? -100 : 1" :max="200" step="1" :value="geometry(selected, field, 10)" :disabled="readonly" @input="patchEntry(selectedIndex, { [field]: number($event, 10, field === 'x' || field === 'y' ? -100 : 1, 200) })" /></label></div>
            <div class="team-field-grid"><label class="team-field">Text size<input type="number" min="8" max="400" :value="geometry(selected, 'fontSize', 72)" :disabled="readonly" @input="patchEntry(selectedIndex, { fontSize: number($event, 72, 8, 400) })" /></label><label class="team-field">Text color<input type="color" :value="safeColor(selected.color, '#ffffff').slice(0, 7)" :disabled="readonly" @input="patchEntry(selectedIndex, { color: value($event) })" /></label></div>
          </template>
          <div class="team-inspector-tools"><button type="button" class="team-icon-button" :disabled="readonly || selectedIndex === 0" aria-label="Move up" @click="reorder(-1)"><ArrowUp :size="15" /></button><button type="button" class="team-icon-button" :disabled="readonly || selectedIndex >= entries.length - 1" aria-label="Move down" @click="reorder(1)"><ArrowDown :size="15" /></button><button type="button" class="team-icon-button danger" :disabled="readonly" :aria-label="isScene ? 'Remove layer from draft' : 'Remove content from draft'" @click="remove"><Trash2 :size="15" /></button></div>
        </template>
        <p v-else class="team-subtle">Select an item to edit its properties.</p>
      </template>
    </aside>
  </div>
</template>
