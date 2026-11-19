<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, Radio, Images, Trash2 } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import MediaImagePicker from '@/components/media/MediaImagePicker.vue';
import MediaAssetPreview from '@/components/studio/MediaAssetPreview.vue';
import { mediaAssetReference } from '@/lib/media-library';
import { useConfirmation } from '@/composables/useConfirmation';
import { mediaAssetUrl, mediaExtensions } from '@/lib/studio/media-library';
import { mediaReturnPath } from '@/lib/media-navigation';
import type { MediaLibraryAsset } from '../../../shared/media-library';
import { Skeleton, LoadingSkeleton } from '@/components/ui/skeleton';
import SourceCell from '@/components/switcher/SourceCell.vue';
import SwitcherBar from '@/components/switcher/SwitcherBar.vue';
import BroadcastButton from '@/components/broadcast/BroadcastButton.vue';
import SharedListeningBar from '@/components/shell/SharedListeningBar.vue';
import { useContentStore } from '@/stores/content';
import { useIdentityStore } from '@/stores/identity';
import { useRoutingStore } from '@/stores/routing';
import { useSourcesStore } from '@/stores/sources';

const router = useRouter();
const route = useRoute();
const { confirmAction } = useConfirmation();
const content = useContentStore();
const identity = useIdentityStore();
const routing = useRoutingStore();
const sources = useSourcesStore();
const opening = ref(true);
const mediaSourceOpen = ref(false), mediaSourceId = ref(''), imagePickerOpen = ref(false), pickerSourceId = ref('');
const mediaSource = computed(() => content.content.sources.find(source => source.id === mediaSourceId.value && source.kind === 'media'));
const sourcePreviewKind = computed(() => {
  const ref = mediaSource.value?.ref ?? '';
  return mediaExtensions.video.test(ref) ? 'video' : mediaExtensions.audio.test(ref) ? 'audio' : 'image';
});
const sourcePreviewFallback = ref(false);
const sourcePreviewUrl = computed(() => {
  const value = mediaSource.value?.ref;
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  // Canonical relative paths contain literal filenames; older content can
  // contain root-relative, already encoded URLs. Try the other spelling only
  // if the first fails, without ever treating a scheme-relative URL as remote.
  const literal = mediaAssetUrl(value), encoded = `/${value.replace(/^\/+/, '')}`;
  return value.startsWith('/') ? (sourcePreviewFallback.value ? literal : encoded) : (sourcePreviewFallback.value ? encoded : literal);
});
watch(() => mediaSource.value?.ref, () => { sourcePreviewFallback.value = false; });
watch(mediaSourceOpen, value => { if (!value) imagePickerOpen.value = false; });
const mediaReturn = computed(() => mediaReturnPath(route.query) ?? '/media');
watch([() => route.query.source, opening, () => identity.isAuthenticated], ([value, loading]) => {
  if (loading || !identity.isAuthenticated || typeof value !== 'string') return;
  if (!identity.can('*', 'author')) { toast.error('You do not have permission to edit this source.'); return; }
  const source = content.content.sources.find(source => source.id === value && source.kind === 'media');
  if (!source) { toast.error('This media source is no longer available.'); return; }
  mediaSourceId.value = source.id; mediaSourceOpen.value = true;
}, { immediate: true });
function chooseSourceImage() { pickerSourceId.value = mediaSourceId.value; imagePickerOpen.value = true; }
async function replaceSourceImage(asset: MediaLibraryAsset) {
  if (!mediaSourceOpen.value || !imagePickerOpen.value || !identity.can('*', 'author') || asset.origin !== 'library' || pickerSourceId.value !== mediaSourceId.value) return;
  const target = pickerSourceId.value;
  if (await content.save(draft => { const source = draft.sources.find(source => source.id === target && source.kind === 'media'); if (source) source.ref = mediaAssetReference(asset, true); })) {
    imagePickerOpen.value = false; toast.success('Source media updated.');
  }
}
async function removeMediaSource() {
  const source = mediaSource.value;
  if (!source || !identity.can('*', 'author') || !await confirmAction({ title: 'Remove media source?', description: `“${source.label || 'Media source'}” will be removed from the switcher and its output routes. If it is on Program or Preview, that selection will be cleared.`, confirmLabel: 'Remove source', tone: 'danger', note: 'The file stays in Media until you delete it there.' })) return;
  if (mediaSource.value?.id !== source.id || mediaSource.value.ref !== source.ref || !identity.can('*', 'author')) return;
  const saved = await content.save(draft => {
    draft.sources = draft.sources.filter(item => item.id !== source.id);
    draft.routes = draft.routes.filter(item => item.sourceId !== source.id);
    if (draft.program.programSourceId === source.id) draft.program.programSourceId = null;
    if (draft.program.previewSourceId === source.id) draft.program.previewSourceId = null;
  });
  if (saved) { mediaSourceOpen.value = false; toast.success('Media source removed.'); }
}

onMounted(async () => {
  try { await Promise.all([content.load(), identity.load()]); }
  finally { opening.value = false; }
});

interface Cell {
  id: string;
  kind: 'channel' | 'webrtc' | 'capture';
  label: string;
  channelId: string | null;
  publisherId: string | null;
  via?: 'camera' | 'screen';
  isProgram: boolean;
  isPreview: boolean;
}

const program = computed(() => content.content.program);

const cells = computed<Cell[]>(() => {
  const channelCells: Cell[] = routing.sourceVMs
    .filter((s) => s.kind === 'channel')
    .map((s) => ({
      id: s.id,
      kind: 'channel',
      label: s.label,
      channelId: s.channelId,
      publisherId: null,
      isProgram: s.isProgram,
      isPreview: s.isPreview,
    }));
  // capture-agent sources (persisted in content.sources)
  const captureCells: Cell[] = content.content.sources
    .filter((s) => s.kind === 'capture')
    .map((s) => ({
      id: s.id,
      kind: 'capture',
      label: s.label ?? s.capture?.label ?? 'Capture',
      channelId: null,
      publisherId: null,
      isProgram: s.id === program.value.programSourceId,
      isPreview: s.id === program.value.previewSourceId,
    }));
  const webrtcCells: Cell[] = sources.webrtcSources.map((w) => {
    const pinned = content.content.sources.find((s) => s.kind === 'webrtc' && s.ref === w.publisherId);
    return {
      id: pinned?.id ?? `live:${w.publisherId}`,
      kind: 'webrtc',
      label: w.label,
      channelId: null,
      publisherId: w.publisherId,
      via: w.via,
      isProgram: !!pinned && pinned.id === program.value.programSourceId,
      isPreview: !!pinned && pinned.id === program.value.previewSourceId,
    };
  });
  return [...channelCells, ...captureCells, ...webrtcCells];
});

async function resolveId(cell: Cell): Promise<string> {
  if (cell.kind === 'webrtc' && cell.publisherId) {
    return routing.ensureWebrtcSource(cell.publisherId, cell.label);
  }
  return cell.id;
}
async function preview(cell: Cell) {
  routing.setPreview(await resolveId(cell));
}
async function program_(cell: Cell) {
  routing.setProgram(await resolveId(cell));
}

const programCell = computed(() => cells.value.find((c) => c.isProgram) ?? null);
const previewCell = computed(() => cells.value.find((c) => c.isPreview) ?? null);
const canTake = computed(() => !!program.value.previewSourceId);
</script>

<template>
  <div class="h-screen w-screen bg-base text-textprimary p-3 sm:p-4 flex flex-col gap-3 overflow-hidden">
    <header class="flex items-center gap-3 shrink-0">
      <button class="h-9 w-9 rounded-xl flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.06]" title="Back to dashboard" @click="router.push('/')">
        <ArrowLeft :size="18" />
      </button>
      <Radio :size="16" class="text-accent" />
      <h1 class="text-base font-semibold tracking-display">Switcher</h1>
      <SharedListeningBar v-if="identity.ready && identity.isAuthenticated" />
      <button v-if="route.query.from === 'media' || route.query.returnTo" type="button" class="text-xs text-accent" @click="router.push(mediaReturn)">Back to Media</button>
      <span class="text-xs text-white/40">Program / Preview bus · TAKE to cut</span>
      <div class="flex-1" />
      <BroadcastButton />
    </header>

    <div v-if="!identity.isAuthenticated && identity.ready" class="flex-1 flex items-center justify-center text-white/45">
      Sign in on the dashboard to use the switcher.
    </div>

    <LoadingSkeleton v-else-if="!identity.ready || opening" class="switcher-loading" label="Opening switcher">
      <div class="switcher-loading-monitors" aria-hidden="true"><div v-for="n in 2" :key="n" class="switcher-loading-monitor"><Skeleton :width="68" :height="10" /><Skeleton class="switcher-loading-frame" height="auto" :radius="12" /></div></div>
      <Skeleton :width="132" :height="10" />
      <div class="switcher-loading-sources" aria-hidden="true"><div v-for="n in 8" :key="n" class="switcher-loading-source"><Skeleton class="switcher-loading-frame" height="auto" :radius="12" /><Skeleton :width="n%2 ? '56%' : '72%'" :height="9" /></div></div>
      <div class="switcher-loading-bar" aria-hidden="true"><Skeleton :width="100" :height="11" /><Skeleton :width="120" :height="36" :radius="8" /></div>
    </LoadingSkeleton>

    <template v-else>
      <!-- Program + Preview monitors -->
      <div class="grid grid-cols-2 gap-3 shrink-0">
        <div class="relative">
          <div class="absolute -top-1 left-2 z-10 text-[10px] font-bold uppercase tracking-wide text-accent">Program</div>
          <SourceCell
            v-if="programCell"
            v-bind="programCell"
            class="!ring-2 !ring-accent"
            @preview="() => {}"
            @program="() => {}"
          />
          <div v-else class="aspect-video rounded-xl bg-black border border-hair flex items-center justify-center text-white/30 text-sm">No program</div>
        </div>
        <div class="relative">
          <div class="absolute -top-1 left-2 z-10 text-[10px] font-bold uppercase tracking-wide text-amber-300">Preview</div>
          <SourceCell
            v-if="previewCell"
            v-bind="previewCell"
            class="!ring-2 !ring-amber-400"
            @preview="() => {}"
            @program="() => {}"
          />
          <div v-else class="aspect-video rounded-xl bg-black border border-hair flex items-center justify-center text-white/30 text-sm">No preview</div>
        </div>
      </div>

      <!-- Source grid -->
      <div class="flex-1 overflow-y-auto -mx-1 px-1">
        <div class="text-[11px] uppercase tracking-[0.12em] text-white/40 mb-2">
          Sources <span class="text-white/25">· click to preview, double-click for program</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <SourceCell
            v-for="c in cells"
            :key="c.id"
            v-bind="c"
            @preview="preview(c)"
            @program="program_(c)"
          />
          <div v-if="cells.length === 0" class="col-span-full text-sm text-white/40 py-8 text-center">
            No sources. Channels appear here; open <span class="text-accent">/cam</span> on a phone to add a camera.
          </div>
        </div>
      </div>

      <SwitcherBar :can-take="canTake" class="shrink-0" @take="routing.take()" />
    </template>

  </div>
  <Dialog v-model:open="mediaSourceOpen"><DialogContent v-if="mediaSource" class="sm:max-w-lg"><DialogHeader><DialogTitle>{{ mediaSource.label || 'Media source' }}</DialogTitle><DialogDescription>Replace this source’s media or remove its reference before deleting the file from Media.</DialogDescription></DialogHeader><MediaAssetPreview :kind="sourcePreviewKind" :src="sourcePreviewUrl || ''" :name="mediaSource.label || 'Source media'" @error="sourcePreviewFallback = true" /><p v-if="program.programSourceId === mediaSource.id || content.content.routes.some(item => item.sourceId === mediaSource!.id)" class="text-xs text-amber-200">This source is assigned to an output. Changes here can affect that output.</p><div class="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" @click="chooseSourceImage"><Images :size="14" />Choose from Media</Button><Button type="button" variant="destructive" @click="removeMediaSource"><Trash2 :size="14" />Remove source</Button></div></DialogContent></Dialog>
  <MediaImagePicker v-model:open="imagePickerOpen" :accepted-kinds="['image', 'video', 'audio']" :selected-path="mediaSource?.ref" @select="replaceSourceImage" />
</template>

<style scoped>
.switcher-loading { display: flex; flex-direction: column; gap: 16px; min-height: 0; flex: 1; overflow: hidden; }
.switcher-loading-monitors { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; flex-shrink: 0; }
.switcher-loading-monitor, .switcher-loading-source { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.switcher-loading-frame { aspect-ratio: 16 / 9; }
.switcher-loading-sources { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 16px 12px; overflow: hidden; flex: 1; align-content: start; }
.switcher-loading-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px; border: 1px solid var(--border-hair); border-radius: 12px; background: var(--surface-1); }
@media (max-width: 1023px) { .switcher-loading-sources { grid-template-columns: repeat(3,minmax(0,1fr)); } }
@media (max-width: 639px) { .switcher-loading-sources { grid-template-columns: repeat(2,minmax(0,1fr)); } }
</style>
