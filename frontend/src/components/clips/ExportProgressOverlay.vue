<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, ChevronDown, ChevronUp, CircleAlert, Download, ExternalLink, FileVideo, FolderOpen, Headphones, LoaderCircle, Pause, RefreshCw, X } from 'lucide-vue-next';
import { useClipDeliveryStore, type ClipDeliveryEntry } from '@/stores/clip-delivery';
import { audioExport, exportOptions } from '@/lib/clip-export';
import '@/styles/clip-delivery.css';

withDefaults(defineProps<{ visible?: boolean }>(), { visible: true });
const delivery = useClipDeliveryStore(), showAll = ref(false), failedImages = ref(new Set<string>());
const priority = (entry: ClipDeliveryEntry) => ['queued', 'waiting-live', 'rendering', 'saving'].includes(entry.state) ? 0 : ['ready', 'error'].includes(entry.state) ? 1 : 2;
const sorted = computed(() => [...delivery.entries].sort((a, b) => priority(a) - priority(b) || b.job.createdAt.localeCompare(a.job.createdAt)));
const cards = computed(() => showAll.value ? sorted.value : sorted.value.slice(0, 3));
const labels: Record<ClipDeliveryEntry['state'], string> = { queued: 'Queued', 'waiting-live': 'Waiting for production', rendering: 'Rendering', ready: 'Ready to save', saving: 'Saving to your file', saved: 'Saved', 'download-requested': 'Download requested', error: 'Export needs attention', cancelled: 'Cancelled', expired: 'Temporary file expired', delivered: 'Delivered in another session' };
function canCancel(entry: ClipDeliveryEntry) { return entry.state === 'saving' || entry.job.canCancel && ['queued', 'waiting-live', 'rendering'].includes(entry.state); }
function canDismiss(entry: ClipDeliveryEntry) { return !['queued', 'waiting-live', 'rendering', 'saving'].includes(entry.state) && !entry.busy; }
function ready(entry: ClipDeliveryEntry) { return entry.job.status === 'complete' && !entry.job.deliveredAt && !entry.job.expiredAt && !entry.fileSaved && ['ready', 'download-requested'].includes(entry.state); }
function downloadMode(entry: ClipDeliveryEntry) { return entry.destination === 'Browser Downloads' || entry.state === 'download-requested'; }
function percent(entry: ClipDeliveryEntry) { return Math.max(0, Math.min(100, Math.round(entry.progress * 100))); }
function amount(bytes: number) { return bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function imageFailed(id: string) { failedImages.value = new Set([...failedImages.value, id]); }
</script>

<template>
  <Teleport to="body">
    <section v-if="visible && delivery.entries.length" class="clip-delivery-overlay" :class="{ 'is-collapsed': delivery.collapsed }" aria-label="Export delivery progress" data-testid="export-progress-overlay">
      <header class="clip-delivery-heading">
        <span class="clip-delivery-heading-icon"><LoaderCircle v-if="delivery.activeCount" :size="15" class="clip-delivery-spin" /><Check v-else :size="15" /></span>
        <strong>Exports<span>{{ delivery.activeCount ? `${delivery.activeCount} in progress` : delivery.entries.length }}</span></strong>
        <button type="button" :aria-label="delivery.collapsed ? 'Expand export progress' : 'Collapse export progress'" :aria-expanded="!delivery.collapsed" @click="delivery.collapsed = !delivery.collapsed"><ChevronDown v-if="delivery.collapsed" :size="15" /><ChevronUp v-else :size="15" /></button>
      </header>
      <div v-if="!delivery.collapsed" class="clip-delivery-cards">
        <article v-for="entry in cards" :key="entry.id" class="clip-delivery-card" :class="{ 'has-warning': entry.message || entry.state === 'error', 'is-saved': entry.fileSaved }" data-testid="export-progress-card" :data-job-id="entry.id" :data-state="entry.state">
          <div class="clip-delivery-card-heading">
            <div class="clip-delivery-thumbnail"><img v-if="entry.thumbnail && !failedImages.has(entry.id)" :src="entry.thumbnail" alt="Rendered export thumbnail" @error="imageFailed(entry.id)" /><Headphones v-else-if="audioExport(exportOptions(entry.job).container)" :size="21" :stroke-width="1.5" /><FileVideo v-else :size="21" :stroke-width="1.5" /><span>{{ exportOptions(entry.job).container.toUpperCase() }}</span></div>
            <div class="clip-delivery-title"><strong :title="entry.filename">{{ entry.filename }}</strong><span class="clip-delivery-status" role="status"><Check v-if="entry.fileSaved" :size="12" /><CircleAlert v-else-if="entry.state === 'error' || entry.state === 'expired'" :size="12" />{{ labels[entry.state] }}</span></div>
            <button v-if="canDismiss(entry)" class="clip-delivery-close" type="button" :aria-label="`Dismiss export ${entry.job.name}`" @click="delivery.dismiss(entry.id)"><X :size="13" /></button>
          </div>
          <template v-if="['rendering', 'saving', 'queued', 'waiting-live'].includes(entry.state)">
            <div class="clip-delivery-progress" role="progressbar" :aria-label="`Export progress ${entry.job.name}`" :aria-valuenow="percent(entry)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${percent(entry)}%` }" /></div>
            <div class="clip-delivery-progress-details"><span>{{ entry.state === 'waiting-live' ? 'Live production stays protected' : entry.state === 'saving' ? `${amount(entry.written)} of ${amount(entry.job.bytes)}` : entry.state === 'queued' ? 'Your edit is in the queue' : 'Preparing picture and audio' }}</span><span v-if="entry.state === 'rendering' || entry.state === 'saving'">{{ percent(entry) }}%</span></div>
          </template>
          <p v-if="entry.message" class="clip-delivery-message">{{ entry.message }}</p>
          <p v-else-if="entry.fileSaved" class="clip-delivery-note">Saved to <strong>{{ entry.destination }}</strong></p>
          <p v-else-if="entry.state === 'ready'" class="clip-delivery-note">Choose where to save your finished file. The station copy is temporary.</p>
          <p v-else-if="entry.state === 'expired'" class="clip-delivery-note">Open the project to export again. Your original recording and draft are unchanged.</p>
          <p v-else-if="entry.state === 'delivered'" class="clip-delivery-note">Another session confirmed this file was saved. The temporary station copy has been released.</p>
          <div class="clip-delivery-actions">
            <button v-if="entry.fileSaved" type="button" :aria-label="`Open saved file ${entry.job.name}`" @click="delivery.openFile(entry.id)"><ExternalLink :size="12" />Open file</button>
            <button v-if="entry.cleanupPending" type="button" :disabled="entry.busy" :aria-label="`Retry cleanup for ${entry.job.name}`" @click="delivery.retry(entry.id)"><RefreshCw :size="12" />Retry cleanup</button>
            <template v-if="ready(entry)">
              <button v-if="downloadMode(entry)" class="clip-delivery-primary" type="button" :disabled="entry.busy" :aria-label="`Download ${entry.job.name}`" @click="delivery.retry(entry.id)"><Download :size="12" />Download</button>
              <button v-else-if="entry.destination !== 'Choose a save location'" class="clip-delivery-primary" type="button" :disabled="entry.busy" :aria-label="`Retry save ${entry.job.name}`" @click="delivery.retry(entry.id)"><RefreshCw :size="12" />Retry save</button>
              <button type="button" :disabled="entry.busy" :aria-label="`Choose save location for ${entry.job.name}`" @click="delivery.chooseLocation(entry.id)"><FolderOpen :size="12" />{{ downloadMode(entry) ? 'Save options' : 'Choose location' }}</button>
            </template>
            <button v-if="canCancel(entry)" type="button" :disabled="entry.busy && entry.state !== 'saving'" :aria-label="entry.state === 'saving' ? `Stop saving ${entry.job.name}` : `Cancel export ${entry.job.name}`" @click="delivery.cancel(entry.id)"><Pause v-if="entry.state === 'saving'" :size="12" /><X v-else :size="12" />{{ entry.state === 'saving' ? 'Stop saving' : 'Cancel' }}</button>
            <RouterLink v-if="entry.state === 'error' || entry.state === 'expired' || entry.state === 'cancelled'" :to="{ name: 'clip-editor', params: { recordingId: entry.job.recordingId }, query: { draft: entry.job.draftId } }" :aria-label="`Open project ${entry.job.name}`"><ExternalLink :size="12" />Open project</RouterLink>
          </div>
        </article>
      </div>
      <button v-if="!delivery.collapsed && delivery.entries.length > 3" class="clip-delivery-more" type="button" @click="showAll = !showAll">{{ showAll ? 'Show recent exports' : `Show all ${delivery.entries.length} exports` }}<ChevronUp v-if="showAll" :size="12" /><ChevronDown v-else :size="12" /></button>
    </section>
  </Teleport>
</template>
