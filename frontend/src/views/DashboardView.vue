<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import {
  Plus,
  FileText,
  Upload,
  KeyboardIcon,
  LayoutList,
  LayoutGrid,
  X,
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
} from 'lucide-vue-next';
import { useDropZone, useMediaQuery } from '@vueuse/core';
import { toast } from 'vue-sonner';

import PlaylistRail from '@/components/dashboard/PlaylistRail.vue';
import TransportBar from '@/components/dashboard/TransportBar.vue';
import SlideCard from '@/components/dashboard/SlideCard.vue';
import UpNextRail from '@/components/dashboard/UpNextRail.vue';
import EditItemDialog from '@/components/dashboard/EditItemDialog.vue';
import SettingsDialog from '@/components/dashboard/SettingsDialog.vue';
import MusicMiniPlayer from '@/components/dashboard/MusicMiniPlayer.vue';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import { useContentStore } from '@/stores/content';
import { usePlaybackStore } from '@/stores/playback';
import { useMusicStore } from '@/stores/music';
import { useBroadcast } from '@/lib/broadcast';
import { useShortcuts } from '@/lib/keyboard';
import { api } from '@/lib/api';
import type { BroadcastMsg, Item, ProjectionState } from '@/types';

const content = useContentStore();
const playback = usePlaybackStore();
const music = useMusicStore();

const editing = ref<Item | null>(null);
const editOpen = ref(false);
const shortcutsOpen = ref(false);
const settingsOpen = ref(false);

// Mobile / tablet sheet state. The actual rails live in the grid on lg+; on
// smaller screens they slide in from their sides.
const playlistsSheetOpen = ref(false);
const upNextSheetOpen = ref(false);
const mdUp = useMediaQuery('(min-width: 768px)');
const lgUp = useMediaQuery('(min-width: 1024px)');

// Collapse sheets when the viewport grows past their breakpoint so they
// don't get stranded.
watch(lgUp, (isLg) => {
  if (isLg) playlistsSheetOpen.value = false;
});
watch(mdUp, (isMd) => {
  if (isMd) upNextSheetOpen.value = false;
});

const showBackdrop = computed(
  () => (playlistsSheetOpen.value && !lgUp.value) || (upNextSheetOpen.value && !mdUp.value),
);
function closeSheets() {
  playlistsSheetOpen.value = false;
  upNextSheetOpen.value = false;
}

type SlideView = 'list' | 'grid';
const SLIDE_VIEW_KEY = 'lumen.slideView';
const slideView = ref<SlideView>(
  (localStorage.getItem(SLIDE_VIEW_KEY) as SlideView | null) ?? 'list',
);
function setSlideView(v: SlideView) {
  slideView.value = v;
  try {
    localStorage.setItem(SLIDE_VIEW_KEY, v);
  } catch {
    /* private mode / quota — fine to swallow */
  }
}

const dropTarget = ref<HTMLElement | null>(null);
useDropZone(dropTarget, { onDrop: handleDrop });

async function handleDrop(files: File[] | null) {
  if (!files || !content.activePlaylistId) return;
  for (const file of files) {
    if (file.type.startsWith('image') || file.type.startsWith('video')) {
      const { path } = await api.uploadMedia('backgrounds', file);
      await content.addItem(content.activePlaylistId, {
        type: file.type.startsWith('video') ? 'video' : 'image',
        title: file.name,
        durationMs: 30000,
        background: {
          kind: file.type.startsWith('video') ? 'video' : 'image',
          src: path,
          fit: 'cover',
          overlayOpacity: 0,
        },
      });
    } else if (file.type.startsWith('audio')) {
      const { path } = await api.uploadMedia('music', file);
      await content.updateMusic({
        queue: [...content.content.music.queue, path],
        current: content.content.music.current ?? path,
      });
      toast.success(`Added "${file.name}" to music queue`);
    }
  }
}

function openEdit(item: Item) {
  editing.value = item;
  editOpen.value = true;
}

async function saveEdit(item: Item) {
  if (!content.activePlaylistId) return;
  await content.updateItem(content.activePlaylistId, item.id, item);
}

async function addSlide() {
  if (!content.activePlaylistId) {
    await content.addPlaylist('New Playlist');
  }
  if (!content.activePlaylistId) return;
  await content.addItem(content.activePlaylistId, {
    type: 'scripture',
    title: '',
    body: 'Tap edit to fill this in…',
    background: { kind: 'color', color: '#0a0a0c', overlayOpacity: 0 },
  });
}

// Sortable list bound directly to playback.items via the store. Reordering
// fires a save() through the content store; rollback on error is automatic.
async function onSorted(e: { oldIndex?: number; newIndex?: number }) {
  if (!content.activePlaylistId) return;
  if (typeof e.oldIndex !== 'number' || typeof e.newIndex !== 'number') return;
  if (e.oldIndex === e.newIndex) return;
  const { oldIndex, newIndex } = e;
  const ok = await content.reorderItems(content.activePlaylistId, oldIndex, newIndex);
  if (!ok) return;
  // Adjust playback index so the same slide stays "current" — only after the
  // save lands so a failed PUT doesn't desync the index.
  if (playback.index === oldIndex) playback.index = newIndex;
  else if (oldIndex < playback.index && newIndex >= playback.index) playback.index--;
  else if (oldIndex > playback.index && newIndex <= playback.index) playback.index++;
}

function openLive() {
  window.open('/live', 'lumen-live', 'noopener');
}

// ── Cross-tab sync ──────────────────────────────────────────────────────────
const projectionState = computed<ProjectionState>(() => ({
  playlistId: content.activePlaylistId,
  index: playback.index,
  mode: playback.mode,
  playing: playback.playing,
  blanked: playback.blanked,
  startedAt: playback.playing ? performance.now() : null,
  durationMs: playback.totalMs,
}));

const { send } = useBroadcast((msg: BroadcastMsg) => {
  if (msg.t === 'hello') {
    send({ t: 'state', payload: projectionState.value });
  }
});

// Push state on any meaningful change.
watch(projectionState, (s) => send({ t: 'state', payload: s }), { deep: true });

// Mirror music play/pause + track changes to Live View.
watch(
  () => [music.playing, music.currentTrack] as const,
  ([playing, track]) => send({ t: 'music', current: track ?? null, playing }),
  { immediate: true },
);

// 8 Hz tick while playing — accurate enough for a 200ms visual progress bar
// step without overwhelming the BroadcastChannel.
let tickHandle: number | null = null;
watch(
  () => playback.playing,
  (isPlaying) => {
    if (tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
    if (isPlaying) {
      tickHandle = window.setInterval(() => {
        send({ t: 'tick', remainingMs: playback.remainingMs, elapsedMs: playback.elapsedMs });
      }, 125);
    } else {
      send({ t: 'tick', remainingMs: playback.remainingMs, elapsedMs: playback.elapsedMs });
    }
  },
);

// ── Keyboard ────────────────────────────────────────────────────────────────
useShortcuts({
  Space: () => playback.toggle(),
  ArrowRight: () => playback.goNext(),
  Enter: () => playback.goNext(),
  ArrowLeft: () => playback.goPrev(),
  M: () => playback.toggleMode(),
  B: () => playback.toggleBlank(),
  L: () => playback.toggleBlank(),
  '?': () => (shortcutsOpen.value = !shortcutsOpen.value),
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [String(i + 1), () => playback.jumpTo(i)]),
  ),
});

onMounted(async () => {
  await content.load();
  // Wire music state on first load.
  if (content.content.music.mode !== 'off' && content.content.music.current) {
    void music.play();
  }
});
</script>

<template>
  <div
    class="h-screen w-screen p-2 sm:p-3 pb-[calc(var(--music-dock-h)+env(safe-area-inset-bottom))] md:pb-3
           grid gap-2 sm:gap-3 bg-base text-textprimary
           grid-rows-[auto_minmax(0,1fr)]
           grid-cols-1
           md:grid-cols-[minmax(0,1fr)_320px]
           lg:grid-cols-[240px_minmax(0,1fr)_360px]"
    style="--music-dock-h: 72px"
  >
    <!-- transport spans every column -->
    <div class="md:col-span-2 lg:col-span-3">
      <TransportBar
        @open-live="openLive"
        @open-playlists="playlistsSheetOpen = true"
        @open-upnext="upNextSheetOpen = true"
      />
    </div>

    <!-- Playlist rail. In-grid on lg+; slides in from the left on smaller. -->
    <div
      :class="[
        'lg:relative lg:translate-x-0 lg:h-auto lg:w-auto lg:shadow-none',
        'fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] p-2 sm:p-3 lg:p-0',
        'transition-transform duration-200 ease-out-cubic',
        playlistsSheetOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      ]"
    >
      <PlaylistRail
        @open-settings="
          settingsOpen = true;
          closeSheets();
        "
      />
      <button
        v-if="!lgUp"
        class="absolute top-3 right-3 h-8 w-8 rounded-full bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center transition-colors"
        @click="playlistsSheetOpen = false"
      >
        <X :size="14" />
      </button>
    </div>

    <!-- Center column wrapper. On mobile + auto mode this stack holds the
         demoted transport panel above the main panel. md:contents collapses
         the wrapper so at md+ the main panel becomes a direct grid child. -->
    <div class="flex flex-col gap-2 sm:gap-3 min-h-0 md:contents">
      <!-- Mobile transport strip — sits above the active playlist on phones
           in both modes so the top bar stays focused on quick actions. -->
      <div
        class="md:hidden panel-soft flex items-center justify-between px-3 h-12 shrink-0"
      >
        <div class="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            :disabled="playback.index === 0"
            @click="playback.goPrev"
          >
            <ChevronLeft :size="18" />
          </Button>
          <Button
            :variant="playback.playing ? 'accent' : 'default'"
            size="icon"
            :disabled="playback.mode !== 'auto' || !playback.current"
            @click="playback.toggle"
          >
            <Pause v-if="playback.playing" :size="16" />
            <Play v-else :size="16" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            :disabled="!playback.current"
            @click="playback.goNext"
          >
            <ChevronRight :size="18" />
          </Button>
        </div>
        <div class="text-sm font-medium text-white/75 tnum tracking-display">
          {{ playback.items.length === 0 ? '—' : `${playback.index + 1} / ${playback.items.length}` }}
        </div>
      </div>

      <main
        ref="dropTarget"
        class="panel p-3 sm:p-4 overflow-hidden flex flex-col min-h-0"
      >
      <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 pb-3 px-1">
        <div class="min-w-0">
          <div class="text-xs font-semibold tracking-[0.12em] uppercase text-white/40">
            Active Playlist
          </div>
          <h1 class="text-lg font-semibold text-white tracking-display truncate">
            {{ content.activePlaylist?.name ?? 'No playlist selected' }}
          </h1>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <div
            class="flex items-center gap-0.5 panel-soft p-0.5"
            role="group"
            aria-label="Slide view"
          >
            <button
              class="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
              :class="
                slideView === 'list'
                  ? 'bg-white/[0.10] text-white'
                  : 'text-white/55 hover:text-white hover:bg-white/[0.06]'
              "
              title="List view"
              :aria-pressed="slideView === 'list'"
              @click="setSlideView('list')"
            >
              <LayoutList :size="14" />
            </button>
            <button
              class="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
              :class="
                slideView === 'grid'
                  ? 'bg-white/[0.10] text-white'
                  : 'text-white/55 hover:text-white hover:bg-white/[0.06]'
              "
              title="Grid view"
              :aria-pressed="slideView === 'grid'"
              @click="setSlideView('grid')"
            >
              <LayoutGrid :size="14" />
            </button>
          </div>
          <Button variant="ghost" size="md" class="hidden sm:inline-flex" @click="shortcutsOpen = true">
            <KeyboardIcon :size="14" />
            <span class="hidden md:inline">Shortcuts</span>
          </Button>
          <Button variant="default" size="md" @click="addSlide">
            <Plus :size="14" />
            <span class="hidden xs:inline sm:inline">New slide</span>
          </Button>
        </div>
      </header>

      <div
        v-if="!content.activePlaylist || playback.items.length === 0"
        class="flex-1 flex items-center justify-center"
      >
        <div class="panel-soft border-dashed border-2 border-white/15 rounded-3xl p-12 max-w-md text-center">
          <div class="mx-auto h-12 w-12 rounded-2xl bg-white/[0.06] flex items-center justify-center mb-4">
            <Upload :size="20" class="text-white/55" />
          </div>
          <div class="text-base font-medium text-white tracking-display">
            Drop images, videos, or music here
          </div>
          <p class="text-sm text-white/55 mt-1.5 leading-relaxed">
            Or click <span class="text-accent">New slide</span> to start typing.
          </p>
        </div>
      </div>

      <VueDraggable
        v-else
        :model-value="playback.items"
        handle=".drag-handle"
        :animation="180"
        ghost-class="opacity-30"
        :class="[
          'overflow-y-auto flex-1 -mx-2 px-2 -mt-2 pt-2 pb-3',
          slideView === 'grid'
            ? 'grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 auto-rows-min'
            : 'flex flex-col gap-2',
        ]"
        @end="onSorted"
      >
        <SlideCard
          v-for="(item, i) in playback.items"
          :key="item.id"
          :item="item"
          :index="i"
          :is-current="i === playback.index"
          :view="slideView"
          @edit="openEdit(item)"
          @duplicate="content.duplicateItem(content.activePlaylistId!, item.id)"
          @delete="content.removeItem(content.activePlaylistId!, item.id)"
          @jump="playback.jumpTo(i)"
        />
      </VueDraggable>
      </main>
    </div>

    <!-- Up-next rail. In-grid on md+; slides in from the right on mobile. -->
    <div
      :class="[
        'md:relative md:translate-x-0 md:h-auto md:w-auto md:shadow-none',
        'fixed inset-y-0 right-0 z-50 w-[320px] max-w-[88vw] p-2 sm:p-3 md:p-0',
        'transition-transform duration-200 ease-out-cubic',
        upNextSheetOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0',
      ]"
    >
      <UpNextRail />
      <button
        v-if="!mdUp"
        class="absolute top-3 right-3 h-8 w-8 rounded-full bg-black/55 backdrop-blur-md border border-hair text-white/85 hover:text-white hover:bg-black/75 flex items-center justify-center transition-colors"
        @click="upNextSheetOpen = false"
      >
        <X :size="14" />
      </button>
    </div>

    <!-- Backdrop for mobile/tablet sheets — taps anywhere outside the rail to close. -->
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out-cubic"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150 ease-out-cubic"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="showBackdrop"
        class="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm"
        @click="closeSheets"
      />
    </Transition>

    <EditItemDialog
      v-model:open="editOpen"
      :item="editing"
      @save="saveEdit"
    />

    <SettingsDialog v-model:open="settingsOpen" />

    <Dialog v-model:open="shortcutsOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div class="grid grid-cols-2 gap-x-8 gap-y-2.5 text-sm">
        <div class="flex justify-between"><span class="text-white/65">Play / pause</span><kbd class="kbd">Space</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Next slide</span><kbd class="kbd">→</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Previous slide</span><kbd class="kbd">←</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Toggle Auto/Manual</span><kbd class="kbd">M</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Blank screen</span><kbd class="kbd">B</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Logo / hold</span><kbd class="kbd">L</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Jump to slide N</span><kbd class="kbd">1–9</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Fullscreen (Live)</span><kbd class="kbd">F</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Exit fullscreen</span><kbd class="kbd">Esc</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Show this overlay</span><kbd class="kbd">?</kbd></div>
      </div>
        <p class="text-xs text-white/45 mt-4 leading-relaxed">
          Open the projection in a second tab with <FileText :size="11" class="inline -translate-y-px" />
          <span class="text-accent">Open Live View</span>, drag it onto your projector display, then press
          <kbd class="kbd">F</kbd> to go fullscreen.
        </p>
      </DialogContent>
    </Dialog>

    <!-- Spotify-style mobile music dock. Hidden on md+ where the inline mini
         player inside TransportBar already covers it. -->
    <div
      class="md:hidden fixed left-0 right-0 z-30 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      style="bottom: 0"
    >
      <MusicMiniPlayer
        class="!h-12 !rounded-2xl !px-2.5 shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.65)]"
      />
    </div>
  </div>
</template>

<style scoped>
.kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  min-width: 22px;
  padding: 0 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  font-size: 11px;
  color: rgba(244, 244, 245, 0.85);
}
</style>
