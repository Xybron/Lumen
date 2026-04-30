<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  GripVertical,
  Pencil,
  Copy,
  Trash2,
  Play,
  MoreVertical,
  ArrowUp,
  ArrowDown,
} from 'lucide-vue-next';
import type { Item } from '@/types';
import { mediaUrl } from '@/lib/api';
import { usePlaybackStore } from '@/stores/playback';
import { useContentStore } from '@/stores/content';
import PreviewSurface from './PreviewSurface.vue';
import BottomSheet from '@/components/ui/BottomSheet.vue';

const props = withDefaults(
  defineProps<{
    item: Item;
    index: number;
    isCurrent: boolean;
    view?: 'list' | 'grid';
  }>(),
  { view: 'list' },
);

const playback = usePlaybackStore();
const content = useContentStore();
const prayerLabel = computed(() => playback.prayerLabelFor(props.item.id)?.display);

const emit = defineEmits<{
  (e: 'edit'): void;
  (e: 'duplicate'): void;
  (e: 'delete'): void;
  (e: 'jump'): void;
}>();

const sheetOpen = ref(false);

const canMoveUp = computed(() => props.index > 0);
const canMoveDown = computed(
  () => props.index < playback.items.length - 1,
);

async function moveUp() {
  if (!canMoveUp.value || !content.activePlaylistId) return;
  await content.reorderItems(content.activePlaylistId, props.index, props.index - 1);
  sheetOpen.value = false;
}

async function moveDown() {
  if (!canMoveDown.value || !content.activePlaylistId) return;
  await content.reorderItems(content.activePlaylistId, props.index, props.index + 1);
  sheetOpen.value = false;
}

function actionThenClose(action: 'edit' | 'duplicate' | 'delete' | 'jump') {
  // Discriminate so Vue's typed-emit overloads resolve.
  switch (action) {
    case 'edit':
      emit('edit');
      break;
    case 'duplicate':
      emit('duplicate');
      break;
    case 'delete':
      emit('delete');
      break;
    case 'jump':
      emit('jump');
      break;
  }
  sheetOpen.value = false;
}

const sheetTitle = computed(
  () => prayerLabel.value
    ? `${prayerLabel.value} ${props.item.title || 'Slide'}`
    : props.item.title || props.item.body || `Slide ${props.index + 1}`,
);

const bgUrl = computed(() => mediaUrl(props.item.background?.src));
const bgColor = computed(() => props.item.background?.color);
const isVideo = computed(() => props.item.background?.kind === 'video');
const isSection = computed(() => props.item.type === 'section');

const durationLabel = computed(() => {
  const s = Math.round(props.item.durationMs / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
});

const typeLabel = computed(
  () => ({
    scripture: 'Scripture',
    text: 'Text',
    image: 'Image',
    video: 'Video',
    section: 'Section',
    prayer: 'Prayer',
    'prayer-sub': 'Prayer (sub)',
  })[props.item.type],
);
</script>

<template>
  <!-- Section divider — same band in both views, spans full width in grid. -->
  <article
    v-if="isSection"
    class="group relative flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors duration-150 ease-out-cubic border-l-2"
    :class="[
      isCurrent
        ? 'border-accent bg-accent/10'
        : 'border-accent/40 hover:border-accent/70 hover:bg-white/[0.04]',
      view === 'grid' ? 'col-span-full' : '',
    ]"
  >
    <span class="text-[10px] font-semibold tracking-[0.18em] uppercase text-accent/85 tnum">
      §{{ String(index + 1).padStart(2, '0') }}
    </span>
    <span class="flex-1 text-sm font-semibold tracking-display text-white truncate">
      {{ item.title || 'Section' }}
    </span>
    <div class="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        class="h-7 w-7 rounded-lg bg-black/30 border border-hair text-white/80 hover:text-white hover:bg-black/50 flex items-center justify-center transition-colors"
        title="Edit"
        @click.stop="emit('edit')"
      >
        <Pencil :size="12" />
      </button>
      <button
        class="h-7 w-7 rounded-lg bg-black/30 border border-hair text-white/80 hover:text-red-300 hover:bg-red-500/20 flex items-center justify-center transition-colors"
        title="Delete"
        @click.stop="emit('delete')"
      >
        <Trash2 :size="12" />
      </button>
      <div
        class="drag-handle h-7 w-5 ml-1 cursor-grab active:cursor-grabbing text-white/50 hover:text-white flex items-center justify-center"
        title="Drag to reorder"
      >
        <GripVertical :size="14" />
      </div>
    </div>

    <button
      class="md:hidden h-8 w-8 rounded-lg text-white/65 hover:text-white hover:bg-white/[0.06] flex items-center justify-center transition-colors"
      title="More actions"
      @click.stop="sheetOpen = true"
    >
      <MoreVertical :size="16" />
    </button>
  </article>

  <!-- Grid view — preview-led card. -->
  <article
    v-else-if="view === 'grid'"
    class="group relative panel-soft overflow-hidden cursor-pointer transition-all duration-150 ease-out-cubic flex flex-col"
    :class="{
      'ring-2 ring-accent/60 shadow-glow': isCurrent,
      'hover:-translate-y-0.5 hover:shadow-panel hover:border-hairglow': !isCurrent,
    }"
    @dblclick="emit('jump')"
  >
    <div class="relative">
      <PreviewSurface :item="item" :prayer-label="prayerLabel" />

      <div class="absolute top-2 left-2 flex items-center gap-1.5">
        <span class="text-[10px] font-semibold tracking-[0.1em] uppercase text-white/85 bg-black/55 backdrop-blur-md rounded-md px-1.5 py-0.5">
          {{ String(index + 1).padStart(2, '0') }}
        </span>
        <span
          v-if="prayerLabel"
          class="text-[10px] font-semibold tracking-[0.1em] uppercase text-accent bg-accent/15 border border-accent/40 backdrop-blur-md rounded-md px-1.5 py-0.5"
        >
          {{ prayerLabel }}
        </span>
      </div>

      <button
        class="md:hidden absolute right-2 top-2 h-8 w-8 rounded-lg bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center transition-colors"
        title="More actions"
        @click.stop="sheetOpen = true"
      >
        <MoreVertical :size="16" />
      </button>

      <div
        class="hidden md:flex absolute right-2 top-2 items-center gap-1 opacity-0 -translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 ease-out-cubic"
      >
        <button
          class="h-7 w-7 rounded-lg bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center transition-colors"
          title="Jump to this slide"
          @click.stop="emit('jump')"
        >
          <Play :size="12" />
        </button>
        <button
          class="h-7 w-7 rounded-lg bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center transition-colors"
          title="Edit"
          @click.stop="emit('edit')"
        >
          <Pencil :size="12" />
        </button>
        <button
          class="h-7 w-7 rounded-lg bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center transition-colors"
          title="Duplicate"
          @click.stop="emit('duplicate')"
        >
          <Copy :size="12" />
        </button>
        <button
          class="h-7 w-7 rounded-lg bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-red-300 hover:bg-red-500/20 flex items-center justify-center transition-colors"
          title="Delete"
          @click.stop="emit('delete')"
        >
          <Trash2 :size="12" />
        </button>
        <div
          class="drag-handle h-7 w-5 ml-1 cursor-grab active:cursor-grabbing text-white/60 hover:text-white flex items-center justify-center"
          title="Drag to reorder"
        >
          <GripVertical :size="14" />
        </div>
      </div>
    </div>

    <div class="px-3 py-2.5 flex flex-col gap-0.5 min-w-0 border-t border-hair">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[10px] font-semibold tracking-[0.1em] uppercase text-accent/85 truncate">
          {{ typeLabel }}
        </span>
        <span class="text-[11px] text-white/45 tnum shrink-0">{{ durationLabel }}</span>
      </div>
      <div class="text-sm font-medium text-white truncate tracking-display">
        {{ item.title || item.body || 'Untitled slide' }}
      </div>
      <div v-if="item.reference" class="text-xs text-white/50 truncate">
        {{ item.reference }}
      </div>
    </div>
  </article>

  <!-- List view — the original row layout. -->
  <article
    v-else
    class="group relative panel-soft overflow-hidden cursor-pointer transition-all duration-150 ease-out-cubic"
    :class="{
      'ring-2 ring-accent/60 shadow-glow': isCurrent,
      'hover:-translate-y-0.5 hover:shadow-panel hover:border-hairglow': !isCurrent,
    }"
    @dblclick="emit('jump')"
  >
    <div class="flex h-[88px]">
      <!-- thumbnail -->
      <div class="relative w-32 shrink-0 overflow-hidden bg-black">
        <img
          v-if="bgUrl && !isVideo"
          :src="bgUrl"
          class="absolute inset-0 h-full w-full object-cover"
        />
        <div
          v-else-if="bgColor"
          class="absolute inset-0"
          :style="{ background: bgColor }"
        />
        <video
          v-else-if="bgUrl && isVideo"
          :src="bgUrl"
          class="absolute inset-0 h-full w-full object-cover"
          muted
          playsinline
        />
        <div v-else class="absolute inset-0 bg-gradient-to-br from-zinc-800 to-zinc-900" />
        <div class="absolute inset-0 bg-black/30" />
        <div class="absolute top-2 left-2 text-[10px] font-semibold tracking-[0.1em] uppercase text-white/85 bg-black/40 backdrop-blur-sm rounded-md px-1.5 py-0.5">
          {{ String(index + 1).padStart(2, '0') }}
        </div>
      </div>

      <!-- body -->
      <div class="flex-1 min-w-0 p-3.5 flex flex-col justify-center">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-[10px] font-semibold tracking-[0.1em] uppercase text-accent/85">
            {{ typeLabel }}
          </span>
          <span
            v-if="prayerLabel"
            class="text-[10px] font-semibold tnum text-accent bg-accent/15 border border-accent/40 rounded-md px-1.5 py-0.5"
          >
            {{ prayerLabel }}
          </span>
          <span class="text-[11px] text-white/40 tnum">{{ durationLabel }}</span>
        </div>
        <div class="text-sm font-medium text-white truncate">
          {{ item.title || item.body || 'Untitled slide' }}
        </div>
        <div v-if="item.reference" class="text-xs text-white/50 truncate mt-0.5">
          {{ item.reference }}
        </div>
      </div>

      <!-- mobile kebab — always visible on small screens -->
      <button
        class="md:hidden absolute right-2 top-2 h-8 w-8 rounded-lg text-white/80 hover:text-white hover:bg-white/[0.06] flex items-center justify-center transition-colors"
        title="More actions"
        @click.stop="sheetOpen = true"
      >
        <MoreVertical :size="16" />
      </button>

      <!-- desktop hover actions -->
      <div
        class="hidden md:flex absolute right-2 top-2 items-center gap-1 opacity-0 -translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 ease-out-cubic"
      >
        <button
          class="h-7 w-7 rounded-lg bg-black/40 backdrop-blur-md border border-hair text-white/80 hover:text-white hover:bg-black/60 flex items-center justify-center transition-colors"
          title="Jump to this slide"
          @click.stop="emit('jump')"
        >
          <Play :size="12" />
        </button>
        <button
          class="h-7 w-7 rounded-lg bg-black/40 backdrop-blur-md border border-hair text-white/80 hover:text-white hover:bg-black/60 flex items-center justify-center transition-colors"
          title="Edit"
          @click.stop="emit('edit')"
        >
          <Pencil :size="12" />
        </button>
        <button
          class="h-7 w-7 rounded-lg bg-black/40 backdrop-blur-md border border-hair text-white/80 hover:text-white hover:bg-black/60 flex items-center justify-center transition-colors"
          title="Duplicate"
          @click.stop="emit('duplicate')"
        >
          <Copy :size="12" />
        </button>
        <button
          class="h-7 w-7 rounded-lg bg-black/40 backdrop-blur-md border border-hair text-white/80 hover:text-red-300 hover:bg-red-500/20 flex items-center justify-center transition-colors"
          title="Delete"
          @click.stop="emit('delete')"
        >
          <Trash2 :size="12" />
        </button>
        <div
          class="drag-handle h-7 w-5 ml-1 cursor-grab active:cursor-grabbing text-white/50 hover:text-white flex items-center justify-center"
          title="Drag to reorder"
        >
          <GripVertical :size="14" />
        </div>
      </div>
    </div>
  </article>

  <!-- Mobile bottom sheet — opens from any of the kebab buttons. Lives outside
       the article so it's not transformed/translated by drag-reorder. -->
  <BottomSheet v-model:open="sheetOpen" :title="sheetTitle">
    <div class="grid gap-1.5">
      <button
        v-if="!isSection"
        class="flex items-center gap-3 px-3 h-11 rounded-xl text-sm text-white hover:bg-white/[0.06] active:bg-white/[0.10] transition-colors"
        @click="actionThenClose('jump')"
      >
        <Play :size="16" class="text-accent" />
        Jump to this slide
      </button>
      <button
        class="flex items-center gap-3 px-3 h-11 rounded-xl text-sm text-white hover:bg-white/[0.06] active:bg-white/[0.10] transition-colors"
        @click="actionThenClose('edit')"
      >
        <Pencil :size="16" class="text-white/70" />
        Edit
      </button>
      <button
        v-if="!isSection"
        class="flex items-center gap-3 px-3 h-11 rounded-xl text-sm text-white hover:bg-white/[0.06] active:bg-white/[0.10] transition-colors"
        @click="actionThenClose('duplicate')"
      >
        <Copy :size="16" class="text-white/70" />
        Duplicate
      </button>
      <button
        class="flex items-center gap-3 px-3 h-11 rounded-xl text-sm text-white hover:bg-white/[0.06] active:bg-white/[0.10] transition-colors disabled:opacity-40 disabled:pointer-events-none"
        :disabled="!canMoveUp"
        @click="moveUp"
      >
        <ArrowUp :size="16" class="text-white/70" />
        Move up
      </button>
      <button
        class="flex items-center gap-3 px-3 h-11 rounded-xl text-sm text-white hover:bg-white/[0.06] active:bg-white/[0.10] transition-colors disabled:opacity-40 disabled:pointer-events-none"
        :disabled="!canMoveDown"
        @click="moveDown"
      >
        <ArrowDown :size="16" class="text-white/70" />
        Move down
      </button>
      <button
        class="flex items-center gap-3 px-3 h-11 rounded-xl text-sm text-red-300 hover:bg-red-500/15 active:bg-red-500/25 transition-colors"
        @click="actionThenClose('delete')"
      >
        <Trash2 :size="16" />
        Delete
      </button>
    </div>
  </BottomSheet>
</template>
