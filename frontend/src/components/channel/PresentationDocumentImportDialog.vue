<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { FileUp, LoaderCircle, FileText, Check } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { presentationDocuments, type PresentationDocumentImport, type PresentationDocumentJob, type PresentationDocumentKind } from '@/lib/presentation-documents';

const props = defineProps<{ open: boolean; kind: PresentationDocumentKind; channelId: string }>();
const emit = defineEmits<{ 'update:open': [value: boolean]; imported: [value: PresentationDocumentImport] }>();
const fileInput = ref<HTMLInputElement | null>(null), job = ref<PresentationDocumentJob | null>(null);
const selected = ref<number[]>([]), error = ref(''), uploading = ref(false), committing = ref(false), converterAvailable = ref(true);
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
const busy = computed(() => uploading.value || committing.value || !!job.value && !['ready', 'error'].includes(job.value.state));
const label = computed(() => props.kind === 'pdf' ? 'PDF' : 'PowerPoint');
const status = computed(() => uploading.value ? 'Uploading document…' : job.value?.state === 'converting' ? 'Preparing PowerPoint slides…' : job.value?.state === 'rendering' ? `Rendering pages${job.value.totalPages ? ` · ${job.value.completedPages} / ${job.value.totalPages}` : '…'}` : '');
function stopPolling() { clearTimeout(timer); controller?.abort(); controller = undefined; }
async function reset() {
  generation++; stopPolling(); const previous = job.value; job.value = null; selected.value = []; error.value = ''; uploading.value = false;
  if (previous) await presentationDocuments.remove(previous.id).catch(() => {});
}
async function poll(id: string, version: number) {
  if (version !== generation || !props.open) return;
  try {
    controller = new AbortController(); const next = await presentationDocuments.get(id, controller.signal);
    if (version !== generation || !props.open) return;
    job.value = next;
    if (next.state === 'ready') selected.value = next.pages.map(page => page.page);
    else if (next.state === 'error') error.value = next.error || 'This document could not be prepared.';
    else timer = setTimeout(() => void poll(id, version), 700);
  } catch (cause) { if (version === generation && props.open) error.value = (cause as Error).message || 'The import status is unavailable.'; }
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file || busy.value) return;
  await reset(); const version = generation;
  if (!(props.kind === 'pdf' ? /\.pdf$/i : /\.(ppt|pptx)$/i).test(file.name)) { error.value = `Choose a ${label.value} file.`; return; }
  if (!file.size || file.size > 100 * 1024 * 1024) { error.value = 'Choose a non-empty document smaller than 100 MB.'; return; }
  uploading.value = true;
  try {
    // Let a completed upload return its job id even after closing, so its
    // staging files can be cancelled instead of being abandoned.
    const next = await presentationDocuments.start(file, props.channelId);
    if (version !== generation || !props.open) { await presentationDocuments.remove(next.id); return; }
    job.value = next; void poll(next.id, version);
  } catch (cause) { if (version === generation) error.value = (cause as Error).message; }
  finally { if (version === generation) uploading.value = false; }
}
function toggle(page: number) { selected.value = selected.value.includes(page) ? selected.value.filter(value => value !== page) : [...selected.value, page]; }
async function commit() {
  if (!job.value || !selected.value.length || committing.value) return;
  committing.value = true; error.value = '';
  try { const result = await presentationDocuments.commit(job.value.id, selected.value); emit('imported', result); emit('update:open', false); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { committing.value = false; }
}
function changeOpen(value: boolean) { if (!committing.value) emit('update:open', value); }
watch(() => [props.open, props.channelId, props.kind] as const, async ([open]) => {
  if (!open) { if (!committing.value) await reset(); return; }
  await reset(); const version = generation;
  try { const capabilities = await presentationDocuments.capabilities(); if (version === generation) converterAvailable.value = capabilities.powerpoint; }
  catch { /* Upload reports actionable connection errors. */ }
}, { immediate: true });
onBeforeUnmount(() => { void reset(); });
</script>

<template>
  <Dialog :open="open" @update:open="changeOpen">
    <DialogContent class="document-import-dialog sm:max-w-[920px] max-h-[88dvh] overflow-y-auto" @interact-outside="committing && $event.preventDefault()">
      <DialogHeader><DialogTitle>Import {{ label }}</DialogTitle><DialogDescription>Review the pages, then add them to this presentation as a group.</DialogDescription></DialogHeader>
      <input ref="fileInput" type="file" class="hidden" :accept="kind === 'pdf' ? '.pdf' : '.ppt,.pptx'" :aria-label="`Choose ${label} document`" @change="choose" />
      <div v-if="!job && !uploading" class="document-import-picker">
        <FileUp :size="30" /><h3>Bring your {{ label }} into Program</h3><p>Up to 200 pages · 100 MB · rendered locally</p>
        <Button :disabled="kind === 'powerpoint' && !converterAvailable" @click="fileInput?.click()">Choose {{ label }} file</Button>
      </div>
      <p v-if="kind === 'powerpoint'" class="document-import-note">Slides are imported as still images. Animations, click builds, and embedded audio or video are not played. Check the previews for font or layout changes.</p>
      <p v-if="kind === 'powerpoint' && !converterAvailable" role="status" class="document-import-error">PowerPoint conversion is unavailable on this station. Use the current Lumen desktop build or install LibreOffice, or export the presentation as PDF.</p>
      <div v-if="status" class="document-import-progress" role="status"><LoaderCircle class="animate-spin" :size="18" />{{ status }}</div>
      <div v-if="job?.state === 'ready'" class="document-import-review">
        <div class="document-import-summary"><span><FileText :size="16" />{{ job.sourceName }}</span><button @click="selected = selected.length === job.pages.length ? [] : job.pages.map(page => page.page)">{{ selected.length === job.pages.length ? 'Deselect all' : 'Select all' }}</button></div>
        <div class="document-import-pages">
          <button v-for="page in job.pages" :key="page.page" class="document-import-page" :class="{ selected: selected.includes(page.page) }" :aria-pressed="selected.includes(page.page)" :aria-label="`Page ${page.page}`" @click="toggle(page.page)">
            <img :src="page.previewUrl" :alt="`Page ${page.page} preview`" loading="lazy" /><span><b>{{ page.page }}</b><Check v-if="selected.includes(page.page)" :size="15" /></span>
          </button>
        </div>
      </div>
      <p v-if="error" role="alert" class="document-import-error">{{ error }}</p>
      <DialogFooter><Button variant="ghost" :disabled="committing" @click="changeOpen(false)">{{ busy ? 'Cancel import' : 'Cancel' }}</Button><Button v-if="job?.state === 'error' || error && !busy" variant="ghost" @click="reset()">Choose another file</Button><Button v-if="job?.state === 'ready'" :disabled="!selected.length || committing" @click="commit">{{ committing ? 'Adding pages…' : `Import ${selected.length} ${selected.length === 1 ? 'page' : 'pages'}` }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.document-import-picker{display:flex;flex-direction:column;align-items:center;gap:14px;padding:38px 20px;border:1px dashed #ffffff20;border-radius:14px;color:#b7bdc7}.document-import-picker h3{font-size:16px;font-weight:600;color:#f3f4f6}.document-import-picker p,.document-import-note{font-size:12px;color:#979eaa;line-height:1.6}.document-import-progress{display:flex;gap:10px;align-items:center;padding:24px 0;color:#b8d8ee;font-size:13px}.document-import-summary{display:flex;justify-content:space-between;gap:18px;font-size:12px;padding:8px 0 14px}.document-import-summary>span{display:flex;gap:8px;align-items:center;overflow-wrap:anywhere}.document-import-summary>button{color:#97cfed;white-space:nowrap}.document-import-pages{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;max-height:48dvh;overflow:auto;padding:3px}.document-import-page{border:1px solid #ffffff20;border-radius:9px;overflow:hidden;background:#0c0d10;transition:border-color .15s}.document-import-page.selected{border-color:#7dd3fc;box-shadow:0 0 0 1px #7dd3fc66}.document-import-page img{width:100%;height:135px;object-fit:contain;background:#17191d}.document-import-page>span{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;font-size:12px;color:#d4dbe6}.document-import-error{color:#f3aaa4;font-size:12px;line-height:1.6}@media(max-width:600px){.document-import-pages{grid-template-columns:repeat(2,minmax(0,1fr))}.document-import-page img{height:105px}}
</style>
