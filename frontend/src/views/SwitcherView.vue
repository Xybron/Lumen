<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft, Radio } from 'lucide-vue-next';
import SourceCell from '@/components/switcher/SourceCell.vue';
import SwitcherBar from '@/components/switcher/SwitcherBar.vue';
import BroadcastButton from '@/components/broadcast/BroadcastButton.vue';
import { useContentStore } from '@/stores/content';
import { useIdentityStore } from '@/stores/identity';
import { useRoutingStore } from '@/stores/routing';
import { useSourcesStore } from '@/stores/sources';

const router = useRouter();
const content = useContentStore();
const identity = useIdentityStore();
const routing = useRoutingStore();
const sources = useSourcesStore();

onMounted(async () => {
  await Promise.all([content.load(), identity.load()]);
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
      <span class="text-xs text-white/40">Program / Preview bus · TAKE to cut</span>
      <div class="flex-1" />
      <BroadcastButton />
    </header>

    <div v-if="!identity.isAuthenticated && identity.ready" class="flex-1 flex items-center justify-center text-white/45">
      Sign in on the dashboard to use the switcher.
    </div>

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
</template>
