<script setup lang="ts">
import { computed, ref, useTemplateRef, watchEffect, onMounted, onBeforeUnmount } from 'vue';
import { Maximize2, Clock3, ChevronLeft, ChevronRight } from 'lucide-vue-next';
import BackgroundLayer from '@/components/live/BackgroundLayer.vue';
import ContentLayer from '@/components/live/ContentLayer.vue';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePlaybackStore } from '@/stores/playback';
import type { Item } from '@/types';

const playback = usePlaybackStore();

const props = withDefaults(
  defineProps<{
    item?: Item;
    blanked?: boolean;
    /** Reference design width — Live View renders at viewport width, but for the
     * preview we lay the same content out at this width and CSS-scale it down
     * so typography/positioning stay WYSIWYG. */
    designWidth?: number;
    /** When true, hovering shows a maximize affordance that opens a large
     * preview dialog. */
    expandable?: boolean;
    /** When true, hovering reveals prev/next chevrons that drive the playback
     * store. Use only on previews of the active slide. */
    navigable?: boolean;
    /** Pre-computed prayer label ("1.", "1a.", …) for prayer-type items. */
    prayerLabel?: string;
  }>(),
  { designWidth: 1920, expandable: false, navigable: false },
);

const hasPrev = computed(() => playback.index > 0);
const hasNext = computed(() => !!playback.next);

const wrap = useTemplateRef<HTMLElement>('wrap');
const scale = ref(1);
const expanded = ref(false);

function recompute() {
  const el = wrap.value;
  if (!el) return;
  scale.value = el.clientWidth / props.designWidth;
}

let ro: ResizeObserver | null = null;

onMounted(() => {
  recompute();
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    ro = new ResizeObserver(recompute);
    ro.observe(wrap.value);
  }
});

onBeforeUnmount(() => { ro?.disconnect(); expandedRo?.disconnect(); });

watchEffect(() => {
  void props.designWidth;
  recompute();
});

const stageStyle = computed(() => ({
  width: `${props.designWidth}px`,
  height: `${props.designWidth * 9 / 16}px`,
  transform: `scale(${scale.value})`,
  transformOrigin: 'top left',
}));

// Larger stage inside the dialog. We recompute its scale separately so the
// typography proportions stay correct at the bigger size.
const expandedWrap = useTemplateRef<HTMLElement>('expandedWrap');
const expandedScale = ref(1);
const EXPANDED_DESIGN_WIDTH = 1920;

function recomputeExpanded() {
  const el = expandedWrap.value;
  if (!el) return;
  expandedScale.value = el.clientWidth / EXPANDED_DESIGN_WIDTH;
}

let expandedRo: ResizeObserver | null = null;

watchEffect(() => {
  if (!expanded.value) {
    expandedRo?.disconnect();
    expandedRo = null;
    return;
  }
  // Wait a tick so the dialog content has measured.
  queueMicrotask(() => {
    recomputeExpanded();
    if (typeof ResizeObserver !== 'undefined' && expandedWrap.value) {
      expandedRo = new ResizeObserver(recomputeExpanded);
      expandedRo.observe(expandedWrap.value);
    }
  });
});

const expandedStageStyle = computed(() => ({
  width: `${EXPANDED_DESIGN_WIDTH}px`,
  height: `${EXPANDED_DESIGN_WIDTH * 9 / 16}px`,
  transform: `scale(${expandedScale.value})`,
  transformOrigin: 'top left',
}));

const headerLabel = computed(
  () => props.item?.title || props.item?.body || props.item?.reference || 'Preview',
);

// Surface progress + counter inside the expanded dialog. We sample directly
// from the playback store because the expand affordance only renders for the
// "now showing" preview where playback is the source of truth.
const total = computed(() => playback.items.length);
const counterLabel = computed(() =>
  total.value === 0 ? '—' : `${playback.index + 1} / ${total.value}`,
);
const progressPct = computed(() => Math.max(0, Math.min(1, playback.progress)) * 100);

function fmtTime(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

const remainingLabel = computed(() => fmtTime(playback.remainingMs));
const totalLabel = computed(() => fmtTime(playback.totalMs));
</script>

<template>
  <div
    ref="wrap"
    class="group relative aspect-video w-full rounded-lg overflow-hidden bg-black border border-hair"
  >
    <div class="absolute inset-0 overflow-hidden">
      <div :style="stageStyle" class="relative overflow-hidden">
        <BackgroundLayer :background="item?.background" />
        <ContentLayer :item="item" :prayer-label="prayerLabel" />
      </div>
    </div>

    <div
      v-if="blanked"
      class="absolute inset-0 bg-black flex items-center justify-center text-white/40 text-xs tracking-[0.2em] uppercase"
    >
      Blanked
    </div>

    <div
      v-if="!item && !blanked"
      class="absolute inset-0 flex items-center justify-center text-white/35 text-xs tracking-[0.18em] uppercase"
    >
      No slide
    </div>

    <button
      v-if="expandable && item"
      class="absolute top-2 right-2 h-8 w-8 rounded-lg bg-black/55 backdrop-blur-md border border-hair text-white/80 hover:text-white hover:bg-black/75 flex items-center justify-center opacity-0 -translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 focus-visible:opacity-100 focus-visible:translate-y-0 transition-all duration-150 ease-out-cubic"
      title="Expand preview"
      @click.stop="expanded = true"
    >
      <Maximize2 :size="14" />
    </button>

    <button
      v-if="navigable"
      class="absolute left-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 focus-visible:opacity-100 focus-visible:translate-x-0 disabled:opacity-30 disabled:pointer-events-none transition-all duration-150 ease-out-cubic"
      :style="{ transform: 'translate(0, -50%)' }"
      :disabled="!hasPrev"
      title="Previous slide"
      @click.stop="playback.goPrev()"
    >
      <ChevronLeft :size="16" />
    </button>

    <button
      v-if="navigable"
      class="absolute right-2 top-1/2 h-9 w-9 rounded-full bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30 disabled:pointer-events-none transition-all duration-150 ease-out-cubic"
      :style="{ transform: 'translate(0, -50%)' }"
      :disabled="!hasNext"
      title="Next slide"
      @click.stop="playback.goNext()"
    >
      <ChevronRight :size="16" />
    </button>

    <Dialog v-if="expandable" v-model:open="expanded">
      <DialogContent class="expanded-slide-dialog !p-4 !gap-3">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-3">
            <span class="text-[10px] font-semibold tracking-[0.16em] uppercase text-accent shrink-0">
              Preview
            </span>
            <span class="text-base font-semibold tracking-display text-white truncate">
              {{ headerLabel }}
            </span>
            <span class="ml-auto text-xs font-medium text-white/55 tnum tracking-display shrink-0">
              {{ counterLabel }}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div
          ref="expandedWrap"
          class="relative aspect-video w-full rounded-lg overflow-hidden bg-black border border-hair"
        >
          <div class="absolute inset-0 overflow-hidden">
            <div :style="expandedStageStyle" class="relative overflow-hidden">
              <BackgroundLayer :background="item?.background" />
              <ContentLayer :item="item" :prayer-label="prayerLabel" />
            </div>
          </div>
          <div
            v-if="blanked"
            class="absolute inset-0 bg-black flex items-center justify-center text-white/55 text-sm tracking-[0.2em] uppercase"
          >
            Blanked
          </div>

          <button
            v-if="navigable"
            class="absolute left-3 top-1/2 h-11 w-11 rounded-full bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center disabled:opacity-30 disabled:pointer-events-none transition-colors"
            :style="{ transform: 'translate(0, -50%)' }"
            :disabled="!hasPrev"
            title="Previous slide"
            @click.stop="playback.goPrev()"
          >
            <ChevronLeft :size="20" />
          </button>
          <button
            v-if="navigable"
            class="absolute right-3 top-1/2 h-11 w-11 rounded-full bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center disabled:opacity-30 disabled:pointer-events-none transition-colors"
            :style="{ transform: 'translate(0, -50%)' }"
            :disabled="!hasNext"
            title="Next slide"
            @click.stop="playback.goNext()"
          >
            <ChevronRight :size="20" />
          </button>
        </div>

        <div class="flex items-center gap-3">
          <Clock3 :size="13" class="text-white/45 shrink-0" />
          <div class="relative flex-1 h-1 rounded-full overflow-hidden bg-white/[0.06]">
            <div
              class="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-150 ease-out-cubic"
              :style="{ width: `${progressPct}%` }"
            />
          </div>
          <div class="text-xs text-white/65 tnum tracking-display shrink-0">
            <span class="text-white">{{ remainingLabel }}</span>
            <span class="text-white/35"> / {{ totalLabel }}</span>
          </div>
        </div>

        <div v-if="item?.reference" class="text-sm text-white/55">
          {{ item.reference }}
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style>
.expanded-slide-dialog { width: min(92vw, calc((100dvh - 200px) * 16 / 9), 1440px) !important; max-width: none !important; }
@media (max-width: 600px) { .expanded-slide-dialog { width: 94vw !important; } }
</style>
