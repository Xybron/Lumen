<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, BookOpen, CheckCircle2, Clapperboard, FileArchive, Film, Images, ListMusic, LoaderCircle, Music2, PanelsTopLeft, Scissors, Search, Settings2, Trash2, Upload } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { dataTransferApi, TRANSFER_FILE_LIMIT } from '@/lib/data-transfer-api';
import { useContentStore } from '@/stores/content';
import { useIdentityStore } from '@/stores/identity';
import type { ClearPreview, ClearResult, TransferCatalog, TransferCounts, TransferItem, TransferPreview, TransferResult, TransferSelection } from '../../../../shared/data-transfer';

type Category = 'bibles' | 'songs' | 'presentations' | 'media' | 'scenes' | 'recordings' | 'setlists' | 'clips';
type Mode = 'export' | 'import' | 'clear';
type Busy = 'catalog' | 'export' | 'preview' | 'import' | 'clear-preview' | 'clear' | null;
const groups = [
  { id: 'bibles' as const, label: 'Bibles', singular: 'Bible', icon: BookOpen, description: 'Translations and their offline text.' },
  { id: 'songs' as const, label: 'Songs', singular: 'song', icon: Music2, description: 'Lyrics, sections and credits.' },
  { id: 'presentations' as const, label: 'Presentations', singular: 'presentation', icon: PanelsTopLeft, description: 'Saved presentations and the media they use.' },
  { id: 'setlists' as const, label: 'Setlists', singular: 'setlist', icon: ListMusic, description: 'Saved worship orders and the songs they use.' },
  { id: 'scenes' as const, label: 'Studio scenes', singular: 'Studio scene', icon: Clapperboard, description: 'Scene layouts and their portable content.' },
  { id: 'recordings' as const, label: 'Recordings', singular: 'recording', icon: Film, description: 'Completed original recordings.' },
  { id: 'clips' as const, label: 'Clip projects', singular: 'clip project', icon: Scissors, description: 'Saved edits and completed clip exports.' },
  { id: 'media' as const, label: 'Media', singular: 'media file', icon: Images, description: 'Additional images, videos and audio.' },
];
const open = defineModel<boolean>('open', { default: false });
const content = useContentStore(), identity = useIdentityStore();
const mode = ref<Mode>('export'), busy = ref<Busy>(null), active = ref<Category>('bibles');
const catalog = ref<TransferCatalog | null>(null), preview = ref<TransferPreview | null>(null), result = ref<TransferResult | null>(null);
const clearReview = ref<ClearPreview | null>(null), clearResult = ref<ClearResult | null>(null), clearText = ref(''), reviewHeading = ref<HTMLElement | null>(null);
const file = ref<File | null>(null), error = ref(''), success = ref(''), query = ref(''), visibleLimit = ref(100), fileInput = ref<HTMLInputElement | null>(null);
const emptySelection = (): TransferSelection => ({ bibles: [], songs: [], presentations: [], media: [], scenes: [], recordings: [], setlists: [], clips: [], settings: false });
const selection = ref<TransferSelection>(emptySelection());
let controller: AbortController | undefined, operation = 0, disposed = false;

const locked = computed(() => busy.value === 'import' || busy.value === 'clear');
const finished = computed(() => !!result.value || !!clearResult.value);
const validFile = computed(() => !!file.value && file.value.size <= TRANSFER_FILE_LIMIT && file.value.name.toLowerCase().endsWith('.lumen'));
const source = computed(() => mode.value === 'import' ? preview.value?.catalog ?? null : catalog.value);
const group = computed(() => groups.find(value => value.id === active.value)!);
const items = computed(() => source.value?.[active.value] ?? []);
const filtered = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  return text ? items.value.filter(item => `${item.name} ${item.detail ?? ''} ${item.id}`.toLocaleLowerCase().includes(text)) : items.value;
});
const shown = computed(() => filtered.value.slice(0, visibleLimit.value));
const selectedCount = computed(() => groups.reduce((count, item) => count + selection.value[item.id].length, 0) + Number(selection.value.settings));
const countSummary = computed(() => {
  const parts = groups.filter(group => selection.value[group.id].length).map(group => `${selection.value[group.id].length.toLocaleString()} ${selection.value[group.id].length === 1 ? group.singular : group.label.toLowerCase()}`);
  if (selection.value.settings) parts.push(mode.value === 'clear' ? 'reset display settings' : 'display settings');
  return parts.join(' · ') || 'Nothing selected';
});
const reviewRows = computed(() => groups.filter(group => clearReview.value?.counts[group.id]).map(group => ({ label: group.label, count: clearReview.value!.counts[group.id] })));
const progress = computed(() => ({ catalog: 'Loading your library…', export: 'Preparing your .lumen file…', preview: 'Reading and checking the archive…', import: 'Importing selected content…', 'clear-preview': 'Checking the selected content and its dependencies…', clear: 'Saving a backup and clearing selected content…' }[busy.value ?? 'catalog']));

function existing(item: TransferItem, category: Category) { return mode.value === 'import' && (category === 'bibles' || category === 'songs') && !!item.exists; }
function available(category: Category) { return (source.value?.[category] ?? []).filter(item => !item.blockedReason && !existing(item, category)); }
function defaults(value: TransferCatalog, importing: boolean) {
  selection.value = emptySelection();
  if (mode.value !== 'clear') for (const category of groups) {
    if (!importing && ['media', 'recordings', 'clips'].includes(category.id)) continue;
    selection.value[category.id] = value[category.id].filter(item => !item.blockedReason && !(importing && (category.id === 'bibles' || category.id === 'songs') && item.exists)).map(item => item.id);
  }
  active.value = groups.find(category => value[category.id].length)?.id ?? 'bibles';
}
function toggle(category: Category, id: string, checked: boolean) {
  if (busy.value) return;
  const ids = new Set(selection.value[category]);
  if (checked) ids.add(id); else ids.delete(id);
  selection.value[category] = [...ids]; success.value = '';
}
function selectAll(category: Category) { if (!busy.value) selection.value[category] = available(category).map(item => item.id); }
function selectEverything() { if (!busy.value) for (const category of groups) selection.value[category.id] = available(category.id).map(item => item.id); }
function clearAll() { if (!busy.value) selection.value = emptySelection(); }
function bytes(value: number) {
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}
function countResult(counts: TransferCounts) {
  const parts = groups.filter(group => counts[group.id]).map(group => `${counts[group.id].toLocaleString()} ${counts[group.id] === 1 ? group.singular : group.label.toLowerCase()}`);
  if (counts.settings) parts.push(mode.value === 'clear' ? 'display settings reset' : 'display settings');
  return parts.join(' · ') || 'None';
}
function failure(cause: unknown) { return cause instanceof Error ? cause.message : 'The action could not be completed. Please try again.'; }
function start(phase: Busy) { controller?.abort(); controller = new AbortController(); busy.value = phase; error.value = ''; success.value = ''; return ++operation; }
function current(id: number) { return id === operation && !disposed && open.value; }
async function discardPreview() {
  const token = preview.value?.token; preview.value = null;
  if (token) await dataTransferApi.discard(token).catch(() => {});
}
async function discardClearReview() {
  const token = clearReview.value?.token; clearReview.value = null; clearText.value = '';
  if (token) await dataTransferApi.discardClear(token).catch(() => {});
}
async function loadCatalog() {
  const id = start('catalog');
  try {
    const value = await (mode.value === 'clear' ? dataTransferApi.clearCatalog(controller?.signal) : dataTransferApi.catalog(controller?.signal));
    if (current(id)) { catalog.value = value; defaults(value, false); }
  } catch (cause) { if (current(id) && !controller?.signal.aborted) error.value = failure(cause); }
  finally { if (current(id)) busy.value = null; }
}
async function changeMode(value: Mode) {
  if (busy.value || mode.value === value || (value === 'clear' && !identity.me?.isAdmin)) return;
  void discardPreview(); void discardClearReview(); mode.value = value; result.value = null; clearResult.value = null; catalog.value = null; file.value = null; error.value = ''; success.value = ''; query.value = ''; selection.value = emptySelection();
  if (value !== 'import') await loadCatalog();
}
function updateOpen(value: boolean) { if (!value && locked.value) return; open.value = value; }
function chooseFile(event: Event) {
  if (busy.value) return;
  void discardPreview(); file.value = (event.target as HTMLInputElement).files?.[0] ?? null; result.value = null; error.value = ''; success.value = ''; selection.value = emptySelection();
  if (file.value && file.value.size > TRANSFER_FILE_LIMIT) error.value = 'Choose a .lumen file no larger than 1 TB.';
  else if (file.value && !file.value.name.toLowerCase().endsWith('.lumen')) error.value = 'Choose a Lumen archive ending in .lumen.';
}
async function readPreview() {
  if (busy.value || !file.value || !validFile.value) return;
  const chosenFile = file.value, id = start('preview');
  try {
    await discardPreview(); if (!current(id)) return;
    const value = await dataTransferApi.preview(chosenFile, controller?.signal);
    if (!current(id)) { await dataTransferApi.discard(value.token).catch(() => {}); return; }
    preview.value = value; defaults(value.catalog, true); query.value = '';
  } catch (cause) { if (current(id) && !controller?.signal.aborted) error.value = failure(cause); }
  finally { if (current(id)) busy.value = null; }
}
async function exportFile() {
  if (busy.value || !selectedCount.value) return;
  const id = start('export');
  try {
    const value = await dataTransferApi.export({ ...selection.value }, controller?.signal);
    if (!current(id)) return;
    const link = document.createElement('a');
    link.href = value.downloadUrl; link.download = value.filename; document.body.append(link); link.click(); link.remove();
    success.value = `${value.filename} is ready. Open this file in Data settings on your other Lumen station.`;
  } catch (cause) { if (current(id) && !controller?.signal.aborted) error.value = failure(cause); }
  finally { if (current(id)) busy.value = null; }
}
async function refreshLibrary() { await content.load(); window.dispatchEvent(new CustomEvent('lumen:library-imported')); }
async function importFile() {
  if (busy.value || !preview.value || !selectedCount.value) return;
  const token = preview.value.token, id = start('import');
  try {
    const value = await dataTransferApi.import(token, { ...selection.value });
    await refreshLibrary();
    if (current(id)) { result.value = value; preview.value = null; }
    await dataTransferApi.discard(token).catch(() => {});
  } catch (cause) { if (current(id)) error.value = failure(cause); }
  finally { if (current(id)) busy.value = null; }
}
async function reviewClear() {
  if (busy.value || !selectedCount.value || !identity.me?.isAdmin) return;
  const id = start('clear-preview');
  try {
    await discardClearReview(); if (!current(id)) return;
    const value = await dataTransferApi.previewClear({ ...selection.value }, controller?.signal);
    if (!current(id)) { await dataTransferApi.discardClear(value.token).catch(() => {}); return; }
    clearReview.value = value; clearText.value = ''; void nextTick(() => reviewHeading.value?.focus());
  } catch (cause) { if (current(id) && !controller?.signal.aborted) error.value = failure(cause); }
  finally { if (current(id)) busy.value = null; }
}
async function applyClear() {
  if (busy.value || !clearReview.value || clearReview.value.blockers.length || clearText.value !== 'CLEAR' || !identity.me?.isAdmin) return;
  const token = clearReview.value.token, id = start('clear');
  try {
    const value = await dataTransferApi.clear(token, clearText.value);
    await refreshLibrary();
    window.dispatchEvent(new CustomEvent('lumen:data-cleared', { detail: value }));
    if (current(id)) { clearResult.value = value; clearReview.value = null; clearText.value = ''; }
    await dataTransferApi.discardClear(token).catch(() => {});
  } catch (cause) { if (current(id)) error.value = failure(cause); }
  finally { if (current(id)) busy.value = null; }
}
function backToSelection() { if (!busy.value) { void discardClearReview(); error.value = ''; } }
function anotherFile() { result.value = null; file.value = null; error.value = ''; if (fileInput.value) fileInput.value.value = ''; }
function clearMore() { clearResult.value = null; selection.value = emptySelection(); void loadCatalog(); }
watch([active, query], () => { visibleLimit.value = 100; });
watch(open, value => {
  if (value) { mode.value = 'export'; catalog.value = null; result.value = null; clearResult.value = null; file.value = null; query.value = ''; error.value = ''; success.value = ''; selection.value = emptySelection(); void loadCatalog(); }
  else { operation++; controller?.abort(); busy.value = null; void discardPreview(); void discardClearReview(); }
});
onBeforeUnmount(() => { disposed = true; operation++; controller?.abort(); if (!locked.value) { void discardPreview(); void discardClearReview(); } });
</script>


<template>
  <Dialog :open="open" @update:open="updateOpen">
    <DialogContent class="transfer-dialog" data-testid="transfer-dialog" :show-close-button="!locked" @escape-key-down="locked && $event.preventDefault()" @interact-outside="locked && $event.preventDefault()">
      <DialogHeader>
        <DialogTitle class="transfer-title"><FileArchive :size="21" />Data settings</DialogTitle>
        <DialogDescription>Export, import or clear selected content on this station.</DialogDescription>
      </DialogHeader>
      <div class="transfer-modes" role="group" aria-label="Data action">
        <button type="button" data-testid="transfer-export-tab" :aria-pressed="mode === 'export'" :class="{ active: mode === 'export' }" :disabled="!!busy" @click="changeMode('export')"><ArrowDownToLine :size="16" />Export</button>
        <button type="button" data-testid="transfer-import-tab" :aria-pressed="mode === 'import'" :class="{ active: mode === 'import' }" :disabled="!!busy" @click="changeMode('import')"><ArrowUpFromLine :size="16" />Import</button>
        <button v-if="identity.me?.isAdmin" type="button" data-testid="transfer-clear-tab" :aria-pressed="mode === 'clear'" :class="{ active: mode === 'clear', 'transfer-clear-mode': mode === 'clear' }" :disabled="!!busy" @click="changeMode('clear')"><Trash2 :size="15" />Clear data</button>
      </div>

      <div v-if="result" class="transfer-complete" role="status" data-testid="transfer-result">
        <CheckCircle2 :size="32" /><h3>Import complete</h3><p>Your selected content is ready on this station.</p>
        <dl><div><dt>Imported</dt><dd>{{ countResult(result.imported) }}</dd></div><div v-if="Object.values(result.skipped).some(Boolean)"><dt>Already present · skipped</dt><dd>{{ countResult(result.skipped) }}</dd></div></dl>
        <details v-if="result.backupPath"><summary>Backup saved before import</summary><p class="transfer-backup">{{ result.backupPath }}</p></details>
        <ul v-if="result.warnings.length" class="transfer-notes"><li v-for="(note, index) in result.warnings" :key="index">{{ note }}</li></ul>
        <button type="button" class="transfer-button" @click="anotherFile">Choose another file</button>
      </div>
      <div v-else-if="clearResult" class="transfer-complete" role="status" data-testid="transfer-clear-result">
        <CheckCircle2 :size="32" /><h3>Selected data cleared</h3><p>The remaining content is ready to use.</p>
        <dl><div><dt>Removed</dt><dd>{{ countResult(clearResult.removed) }}</dd></div></dl>
        <details v-if="clearResult.backupPath"><summary>Backup saved before clearing</summary><p class="transfer-backup">{{ clearResult.backupPath }}</p></details>
        <ul v-if="clearResult.warnings.length" class="transfer-notes"><li v-for="(note, index) in clearResult.warnings" :key="index">{{ note }}</li></ul>
        <button type="button" class="transfer-button" @click="clearMore">Return to data selection</button>
      </div>
      <section v-else-if="clearReview" class="transfer-clear-review" aria-label="Review selected data" data-testid="transfer-clear-review-panel">
        <div class="transfer-clear-heading"><AlertTriangle :size="23" /><div><h3 ref="reviewHeading" tabindex="-1">Review before clearing</h3><p>These items will be removed from this station.</p></div></div>
        <dl class="transfer-review-counts"><div v-for="row in reviewRows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.count.toLocaleString() }}</dd></div><div v-if="clearReview.counts.settings"><dt>Display settings</dt><dd>Reset to defaults</dd></div></dl>
        <p class="transfer-backup-notice">Lumen will save a backup of the selected data before clearing it.</p>
        <div v-if="clearReview.warnings.length" class="transfer-review-notes"><h4>Dependencies and changes</h4><ul class="transfer-notes"><li v-for="(note, index) in clearReview.warnings" :key="index">{{ note }}</li></ul></div>
        <div v-if="clearReview.blockers.length" class="transfer-clear-blockers" role="alert" data-testid="transfer-clear-blockers"><b>Some selected data cannot be cleared yet.</b><ul class="transfer-notes"><li v-for="(blocker, index) in clearReview.blockers" :key="index">{{ blocker }}</li></ul><p>Go back and adjust your selection, then review it again.</p></div>
        <label v-else class="transfer-clear-confirm"><span>Type <b>CLEAR</b> to confirm this selection.</span><input v-model="clearText" data-testid="transfer-clear-confirmation" aria-label="Type CLEAR to confirm" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="CLEAR" :disabled="!!busy" /></label>
      </section>
      <template v-else>
        <div v-if="mode === 'import'" class="transfer-file-box">
          <Upload :size="23" /><div><b>{{ file?.name ?? 'Choose a Lumen archive' }}</b><span>{{ file ? bytes(file.size) + ' · .lumen archive' : 'Select the .lumen file exported from another station. Up to 1 TB.' }}</span></div>
          <input ref="fileInput" type="file" accept=".lumen" aria-label="Lumen archive" data-testid="transfer-file" :disabled="!!busy" @change="chooseFile" />
          <button v-if="!preview" type="button" class="transfer-button" data-testid="transfer-preview" :disabled="!!busy || !validFile" @click="readPreview">Preview file</button>
        </div>
        <p v-if="mode === 'clear'" class="transfer-clear-intro"><Trash2 :size="16" /><span>Choose what to remove. Nothing is selected by default. You will review the changes before confirming.</span></p>
        <div v-if="source" class="transfer-picker">
          <nav class="transfer-categories" aria-label="Content categories">
            <button v-for="category in groups" :key="category.id" type="button" :data-testid="`transfer-category-${category.id}`" :aria-label="category.label" :aria-pressed="active === category.id" :class="{ active: active === category.id }" :disabled="!!busy" @click="active = category.id; query = ''"><component :is="category.icon" :size="17" /><span>{{ category.label }}<small>{{ selection[category.id].length.toLocaleString() }} selected</small></span><b>{{ source[category.id].length.toLocaleString() }}</b></button>
          </nav>
          <section class="transfer-list-panel" :aria-label="`${group.label} selection`">
            <div class="transfer-list-heading"><div><h3>{{ group.label }}</h3><p>{{ group.description }}</p></div><div class="transfer-list-actions"><button type="button" :aria-label="`Select all ${group.label.toLowerCase()}`" :disabled="!!busy || !available(active).length" @click="selectAll(active)">All</button><button type="button" :aria-label="`Clear ${group.label.toLowerCase()} selection`" :disabled="!!busy || !selection[active].length" @click="selection[active] = []">None</button></div></div>
            <label class="transfer-search"><Search :size="15" /><input v-model="query" :aria-label="`Search ${group.label.toLowerCase()}`" :placeholder="`Search ${group.label.toLowerCase()}…`" :disabled="!!busy" /></label>
            <template v-if="mode !== 'clear'">
              <p v-if="active === 'media' || active === 'presentations' || active === 'scenes'" class="transfer-dependency">Media used by selected presentations and Studio scenes is included automatically.</p>
              <p v-if="active === 'setlists'" class="transfer-dependency">Songs used by selected setlists are included automatically.</p>
              <p v-if="active === 'clips'" class="transfer-dependency">Original recordings used by selected clip projects are included automatically.</p>
              <p v-if="mode === 'import' && ['presentations', 'setlists', 'scenes', 'recordings', 'clips'].includes(active)" class="transfer-dependency">{{ group.label }} are added as new copies.</p>
            </template>
            <p v-else class="transfer-dependency">Protected items cannot be selected. The review checks for content that still depends on your selection.</p>
            <div class="transfer-items" :aria-busy="!!busy">
              <label v-for="item in shown" :key="item.id" class="transfer-item" :class="{ existing: existing(item, active) || item.blockedReason }">
                <input type="checkbox" :data-testid="`transfer-item-${active}-${item.id}`" :aria-label="`Select ${item.name}`" :checked="selection[active].includes(item.id)" :disabled="!!busy || existing(item, active) || !!item.blockedReason" @change="toggle(active, item.id, ($event.target as HTMLInputElement).checked)" />
                <span><b>{{ item.name }}<span v-if="active === 'bibles'" class="transfer-bible-id">{{ item.id }}</span></b><small v-if="item.detail">{{ item.detail }}</small><small v-if="existing(item, active)" class="transfer-existing">Already on this station · skipped</small><small v-if="item.blockedReason" class="transfer-blocked">{{ item.blockedReason }}</small></span><em v-if="item.bytes !== undefined">{{ bytes(item.bytes) }}</em>
              </label>
              <p v-if="!filtered.length" class="transfer-empty">{{ query.trim() ? 'No matching items.' : `No ${group.label.toLowerCase()} in this ${mode === 'import' ? 'archive' : 'library'}.` }}</p>
              <button v-if="filtered.length > shown.length" type="button" class="transfer-more" :disabled="!!busy" @click="visibleLimit += 100">Show more · {{ shown.length.toLocaleString() }} of {{ filtered.length.toLocaleString() }}</button>
            </div>
          </section>
        </div>
        <label v-if="source?.settings" class="transfer-settings"><Settings2 :size="17" /><span><b>{{ mode === 'clear' ? 'Reset display settings to defaults' : mode === 'import' ? 'Replace this station’s display settings' : 'Include display settings' }}</b><small>{{ mode === 'clear' ? 'Reset presentation defaults and timings.' : mode === 'import' ? 'Use the archive’s presentation defaults and timings.' : 'Presentation defaults and timings for your other station.' }}</small></span><input v-model="selection.settings" type="checkbox" data-testid="transfer-settings" :aria-label="mode === 'clear' ? 'Reset display settings' : mode === 'import' ? 'Replace display settings' : 'Include display settings'" :disabled="!!busy" /></label>
        <details v-if="preview?.warnings.length" class="transfer-warning-notes" open><summary>Archive notes</summary><ul class="transfer-notes"><li v-for="(note, index) in preview.warnings" :key="index">{{ note }}</li></ul></details>
        <div v-if="source" class="transfer-summary"><div><b>{{ selectedCount.toLocaleString() }} {{ selectedCount === 1 ? 'item' : 'items' }} selected</b><span>{{ countSummary }}</span></div><div class="transfer-summary-actions"><button type="button" data-testid="transfer-select-all" aria-label="Select all content" :disabled="!!busy" @click="selectEverything">Select all</button><button type="button" data-testid="transfer-clear-all" aria-label="Clear all selections" :disabled="!!busy || !selectedCount" @click="clearAll">Clear selection</button></div></div>
      </template>
      <p v-if="busy" class="transfer-progress" role="status" aria-live="polite"><LoaderCircle :size="16" class="transfer-spin" />{{ progress }}</p>
      <p v-if="error" class="transfer-error" role="alert" data-testid="transfer-error">{{ error }}<button v-if="mode !== 'import' && !catalog && !busy" type="button" @click="loadCatalog">Try again</button></p>
      <p v-if="success" class="transfer-success" role="status"><CheckCircle2 :size="17" />{{ success }}</p>
      <p class="transfer-scope">Accounts, device connections and live output settings stay on this station.</p>
      <footer class="transfer-footer">
        <button type="button" class="transfer-button" :disabled="locked" @click="updateOpen(false)">{{ finished ? 'Done' : 'Cancel' }}</button>
        <button v-if="!finished && mode === 'export'" type="button" class="transfer-button primary" data-testid="transfer-export" :disabled="!!busy || !source || !selectedCount" @click="exportFile"><ArrowDownToLine :size="16" />Download .lumen file</button>
        <button v-if="!finished && mode === 'import' && preview" type="button" class="transfer-button primary" data-testid="transfer-import" :disabled="!!busy || !selectedCount" @click="importFile"><ArrowUpFromLine :size="16" />Import selected</button>
        <button v-if="!finished && mode === 'clear' && !clearReview" type="button" class="transfer-button primary" data-testid="transfer-clear-review" :disabled="!!busy || !source || !selectedCount" @click="reviewClear">Review selected data</button>
        <template v-if="clearReview"><button type="button" class="transfer-button" data-testid="transfer-clear-back" :disabled="!!busy" @click="backToSelection">Back to selection</button><button type="button" class="transfer-button danger" data-testid="transfer-clear-apply" :disabled="!!busy || !!clearReview.blockers.length || clearText !== 'CLEAR'" @click="applyClear"><Trash2 :size="15" />Clear selected data</button></template>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:global(.transfer-dialog){width:min(880px,calc(100vw - 1rem));max-width:min(880px,calc(100vw - 1rem));gap:17px;overflow-y:auto;color:var(--text-primary)}
.transfer-title{display:flex;align-items:center;gap:10px}.transfer-title svg{color:var(--accent)}
.transfer-modes{display:flex;gap:5px;padding:4px;border:1px solid var(--border-hair);border-radius:9px;background:var(--surface-2)}
.transfer-modes button{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;min-height:37px;border:0;border-radius:6px;background:transparent;color:var(--text-muted);font-size:12px;font-weight:550}.transfer-modes button.active{color:var(--accent);background:var(--accent-soft)}
.transfer-picker{display:grid;grid-template-columns:180px minmax(0,1fr);min-height:285px;border:1px solid var(--border-hair);border-radius:10px;overflow:hidden}
.transfer-categories{display:flex;flex-direction:column;gap:5px;padding:10px;background:var(--surface-2);border-right:1px solid var(--border-hair)}
.transfer-categories button{display:flex;align-items:center;gap:9px;text-align:left;width:100%;border:1px solid transparent;border-radius:7px;padding:11px 8px;color:var(--text-muted);background:transparent;min-width:0}.transfer-categories button.active{background:var(--accent-soft);border-color:#7dd3fc24;color:var(--accent)}.transfer-categories button>svg{flex-shrink:0}.transfer-categories button>span{flex:1;display:grid;gap:4px;font-size:11px;font-weight:550}.transfer-categories small{font-size:9px;font-weight:400;color:var(--text-subtle)}.transfer-categories button>b{font-size:10px;font-weight:450;color:var(--text-subtle);font-variant-numeric:tabular-nums}
.transfer-list-panel{min-width:0;padding:15px 16px}.transfer-list-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.transfer-list-heading h3{margin:0;font-size:13px;font-weight:550}.transfer-list-heading p{margin:5px 0 0;font-size:10px;color:var(--text-subtle);line-height:1.5}.transfer-list-actions{display:flex;gap:7px;flex-shrink:0}.transfer-list-actions button,.transfer-summary>button,.transfer-error button{border:0;background:transparent;color:var(--accent);font-size:10px;padding:6px}
.transfer-search{display:flex;align-items:center;gap:8px;margin:12px 0 4px;padding:9px 10px;border:1px solid var(--border-hair);border-radius:6px;color:var(--text-subtle);background:var(--surface-2)}.transfer-search input{border:0;outline:none;background:transparent;color:var(--text-primary);font:inherit;font-size:11px;width:100%;min-width:0}.transfer-search:focus-within{border-color:var(--accent)}
.transfer-items{max-height:245px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.transfer-item{display:flex;align-items:center;gap:10px;min-height:48px;border-bottom:1px solid var(--border-hair);padding:10px 3px;cursor:pointer}.transfer-item:last-child{border-bottom:0}.transfer-item>span{flex:1;min-width:0;display:grid;gap:4px}.transfer-item b{font-size:11px;font-weight:500;overflow-wrap:anywhere}.transfer-item small{font-size:10px;color:var(--text-subtle);line-height:1.5;overflow-wrap:anywhere}.transfer-item em{font-style:normal;font-size:9px;color:var(--text-subtle);flex-shrink:0}.transfer-item.existing{cursor:default}.transfer-item.existing>b{color:var(--text-subtle)}.transfer-item .transfer-existing{color:#b8bdc8;font-size:9px}
.transfer-dialog input[type=checkbox]{accent-color:var(--accent);width:15px;height:15px;flex-shrink:0;cursor:pointer}.transfer-dialog input[type=checkbox]:disabled{cursor:default}.transfer-more{border:0;border-radius:6px;background:var(--surface-2);color:var(--accent);padding:10px;width:100%;font-size:10px;margin-top:7px}.transfer-empty{padding:30px 10px;text-align:center;color:var(--text-subtle);font-size:11px}
.transfer-bible-id{display:inline-block;margin-left:7px;padding:2px 5px;border:1px solid var(--border-hair);border-radius:4px;color:var(--accent);font-size:9px;font-weight:500;vertical-align:baseline}
.transfer-summary>.transfer-summary-actions{display:flex;flex-shrink:0;gap:5px}.transfer-summary-actions button{border:0;background:transparent;color:var(--accent);font-size:10px;padding:6px;white-space:nowrap}
.transfer-modes button.active.transfer-clear-mode{color:#efbbb1;background:#d97d6617}.transfer-clear-intro{display:flex;align-items:flex-start;gap:9px;margin:0;color:var(--text-muted);font-size:11px;line-height:1.7}.transfer-clear-intro svg{flex-shrink:0;margin-top:2px;color:#d9a39a}.transfer-item .transfer-blocked{color:#d9b48e}
.transfer-clear-review{display:grid;gap:17px}.transfer-clear-heading{display:flex;align-items:flex-start;gap:12px}.transfer-clear-heading>svg{color:#e6b4a8;flex-shrink:0;margin-top:2px}.transfer-clear-heading h3{margin:0 0 7px;font-size:16px;font-weight:550}.transfer-clear-heading p{margin:0;font-size:12px;color:var(--text-muted)}.transfer-review-counts{margin:0;display:grid;gap:11px;padding:15px;border-radius:8px;background:var(--surface-2)}.transfer-review-counts>div{display:flex;justify-content:space-between;gap:14px;font-size:12px}.transfer-review-counts dt{color:var(--text-muted)}.transfer-review-counts dd{margin:0;font-weight:500;white-space:nowrap}.transfer-backup-notice{margin:0;padding:12px;border:1px solid var(--border-hair);border-radius:7px;font-size:11px;line-height:1.6;color:var(--text-muted)}.transfer-review-notes{max-height:170px;overflow:auto}.transfer-review-notes h4{margin:0;font-size:11px;font-weight:550}.transfer-clear-blockers{padding:13px;border:1px solid #edb5ae35;background:#edb5ae08;border-radius:8px;font-size:11px;color:#edb5ae;line-height:1.6}.transfer-clear-blockers>p{margin:10px 0 0}.transfer-clear-confirm{display:grid;gap:10px;font-size:12px}.transfer-clear-confirm input{width:100%;max-width:280px;background:var(--surface-2);border:1px solid var(--border-glow);border-radius:7px;padding:11px 12px;color:var(--text-primary);font:inherit;letter-spacing:.08em}.transfer-button.danger{background:#b85948;border-color:#d17967;color:white}
.transfer-dependency{font-size:10px;line-height:1.5;color:var(--text-muted);margin:9px 0 3px}.transfer-settings{display:flex;align-items:center;gap:11px;border:1px solid var(--border-hair);border-radius:8px;padding:12px 14px;cursor:pointer}.transfer-settings>svg{color:var(--text-subtle);flex-shrink:0}.transfer-settings>span{flex:1;display:grid;gap:5px;min-width:0}.transfer-settings b{font-size:11px;font-weight:500}.transfer-settings small{font-size:10px;color:var(--text-subtle);line-height:1.5}
.transfer-summary{display:flex;align-items:center;justify-content:space-between;gap:12px}.transfer-summary>div{display:grid;gap:5px;min-width:0}.transfer-summary b{font-size:11px;font-weight:550}.transfer-summary span{color:var(--text-subtle);font-size:10px;line-height:1.5;overflow-wrap:anywhere}.transfer-summary>button{flex-shrink:0}
.transfer-file-box{display:grid;grid-template-columns:23px minmax(0,1fr) auto;align-items:center;gap:12px;background:var(--surface-2);border:1px dashed var(--border-glow);border-radius:9px;padding:15px}.transfer-file-box>svg{color:var(--accent);flex-shrink:0}.transfer-file-box>div{display:grid;gap:5px;min-width:0;grid-column:2 / -1}.transfer-file-box b{font-size:12px;font-weight:500;overflow-wrap:anywhere}.transfer-file-box span{font-size:10px;color:var(--text-subtle);line-height:1.5}.transfer-file-box input{grid-column:2;width:100%;min-width:0;color:var(--text-muted);font-size:10px}.transfer-file-box>.transfer-button{grid-column:3}.transfer-file-box input::file-selector-button{border:1px solid var(--border-glow);border-radius:5px;padding:7px 9px;background:transparent;color:var(--text-primary);font:inherit;margin-right:9px;cursor:pointer}
.transfer-footer{display:flex;justify-content:flex-end;gap:9px;border-top:1px solid var(--border-hair);padding-top:15px}.transfer-button{display:inline-flex;justify-content:center;align-items:center;gap:8px;min-height:37px;padding:9px 13px;border:1px solid var(--border-glow);border-radius:7px;background:var(--surface-2);color:var(--text-primary);font-size:11px;font-weight:500}.transfer-button.primary{background:var(--accent);color:#122c3b;border-color:var(--accent)}.transfer-dialog button:disabled{opacity:.42;cursor:not-allowed}.transfer-dialog button:not(:disabled),.transfer-dialog summary{cursor:pointer}.transfer-dialog button:focus-visible,.transfer-dialog input:focus-visible,.transfer-dialog summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.transfer-dialog button:not(:disabled):hover{filter:brightness(1.12)}
.transfer-progress,.transfer-success,.transfer-error{display:flex;align-items:flex-start;gap:9px;margin:0;padding:11px 12px;border:1px solid var(--border-hair);border-radius:7px;font-size:11px;line-height:1.6}.transfer-progress{color:var(--accent);background:var(--accent-soft)}.transfer-progress svg,.transfer-success svg{flex-shrink:0;margin-top:1px}.transfer-error{color:#edb5ae;border-color:#edb5ae35;background:#edb5ae08;display:block;overflow-wrap:anywhere}.transfer-success{color:#afd5ba;border-color:#afd5ba35;background:#afd5ba08}.transfer-scope{margin:0;color:var(--text-subtle);font-size:10px;line-height:1.7}.transfer-spin{animation:transfer-spin 1s linear infinite}
.transfer-warning-notes{font-size:11px;color:#d9c49e;max-height:130px;overflow:auto}.transfer-notes{padding-left:19px;margin:9px 0 0;font-size:10px;line-height:1.7;color:var(--text-muted)}.transfer-complete{text-align:center;padding:10px 0 0}.transfer-complete>svg{color:#afd5ba;margin:0 auto 10px}.transfer-complete h3{font-size:17px;font-weight:550;margin:0 0 8px}.transfer-complete>p{font-size:12px;color:var(--text-muted);margin:0 0 20px}.transfer-complete dl{margin:0 0 14px;padding:14px;text-align:left;background:var(--surface-2);border-radius:8px;display:grid;gap:12px}.transfer-complete dt{font-size:10px;color:var(--text-subtle);margin-bottom:5px}.transfer-complete dd{margin:0;font-size:12px;line-height:1.5}.transfer-complete details{font-size:10px;color:var(--text-muted);margin:12px 0;text-align:left}.transfer-backup{overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:9px;line-height:1.6}.transfer-complete .transfer-notes{text-align:left;margin-bottom:15px}
@keyframes transfer-spin{to{transform:rotate(360deg)}}
@media(max-width:640px){:global(.transfer-dialog){gap:13px;padding:17px}.transfer-picker{grid-template-columns:1fr}.transfer-categories{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-right:0;border-bottom:1px solid var(--border-hair);padding:6px;gap:3px}.transfer-categories button{flex-direction:column;gap:5px;text-align:center;padding:8px 2px}.transfer-categories button>span{font-size:9px;gap:4px}.transfer-categories button>b{display:none}.transfer-categories small{font-size:8px}.transfer-list-panel{padding:12px}.transfer-items{max-height:190px}.transfer-summary span{font-size:9px}.transfer-footer{padding-top:12px}.transfer-button{padding:9px 11px}.transfer-file-box{padding:12px;grid-template-columns:23px minmax(0,1fr)}.transfer-file-box input{grid-column:1 / -1}.transfer-file-box>.transfer-button{grid-column:1 / -1;justify-self:start}}
@media(prefers-reduced-motion:reduce){.transfer-spin{animation:none}}
</style>
