<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { useMediaQuery } from '@vueuse/core';

import PlaylistRail from '@/components/dashboard/PlaylistRail.vue';
import TransportBar from '@/components/dashboard/TransportBar.vue';
import UpNextRail from '@/components/dashboard/UpNextRail.vue';
import EditItemDialog from '@/components/dashboard/EditItemDialog.vue';
import SettingsDialog from '@/components/dashboard/SettingsDialog.vue';
import MusicMiniPlayer from '@/components/dashboard/MusicMiniPlayer.vue';
import ChannelEditor from '@/components/channel/ChannelEditor.vue';
import MobileTransportStrip from '@/components/channel/MobileTransportStrip.vue';
import ShortcutsDialog from '@/components/channel/ShortcutsDialog.vue';

import { useContentStore } from '@/stores/content';
import { useEnginesStore } from '@/stores/engines';
import { useMusicStore } from '@/stores/music';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { useChannelKeyboard } from '@/composables/useChannelKeyboard';
import type { Item } from '@/types';

const content = useContentStore();
const engines = useEnginesStore();
const music = useMusicStore();
const identity = useIdentityStore();
const presence = usePresenceStore();

// The focused channel drives the editor (kind, name, default new-slide type).
const channel = computed(() => content.channels.find((c) => c.id === engines.focusedChannelId) ?? null);

const editing = ref<Item | null>(null);
const editDestination = ref<{ channelId: string; playlistId: string } | null>(null);
const editOpen = ref(false);
const shortcutsOpen = ref(false);
const settingsOpen = ref(false);

const playlistsSheetOpen = ref(false);
const upNextSheetOpen = ref(false);
const animateSheets = ref(false);
const mdUp = useMediaQuery('(min-width: 768px)');
const lgUp = useMediaQuery('(min-width: 1024px)');

watch([lgUp, mdUp], () => {
  // Breakpoint changes are immediate layout changes, not drawer gestures. A
  // resized desktop panel must never animate across the mobile workspace.
  animateSheets.value = false;
  playlistsSheetOpen.value = false;
  upNextSheetOpen.value = false;
});

const showBackdrop = computed(
  () => (playlistsSheetOpen.value && !lgUp.value) || (upNextSheetOpen.value && !mdUp.value),
);
function closeSheets() {
  animateSheets.value = true;
  playlistsSheetOpen.value = false;
  upNextSheetOpen.value = false;
}
function openPlaylists() { animateSheets.value = true; playlistsSheetOpen.value = true; }
function openUpNext() { animateSheets.value = true; upNextSheetOpen.value = true; }

function openEdit(item: Item) {
  if (!channel.value || !identity.can(channel.value.id, 'author') || presence.controlledByOther(channel.value.id)) return;
  if (!content.playlistForChannel(channel.value.id)?.items.some(slide => slide.id === item.id)) return;
  editing.value = item;
  editDestination.value = { channelId: channel.value.id, playlistId: channel.value.playlistId };
  editOpen.value = true;
}
async function saveEdit(item: Item) {
  const destination = editDestination.value;
  if (!destination || !identity.can(destination.channelId, 'author') || presence.controlledByOther(destination.channelId)) return;
  await content.updateItem(destination.playlistId, item.id, item);
}

useChannelKeyboard({ onToggleShortcuts: () => (shortcutsOpen.value = !shortcutsOpen.value) });

onMounted(async () => {
  await content.load();
  if (content.content.music.mode !== 'off' && content.content.music.current) {
    void music.play();
  }
});
</script>

<template>
  <div
    class="presentation-workspace"
  >
    <div class="presentation-transport">
      <TransportBar @open-playlists="openPlaylists" @open-upnext="openUpNext" />
    </div>

    <!-- Playlist rail. In-grid on lg+; slides in from the left on smaller. -->
    <div
      :inert="!lgUp && !playlistsSheetOpen"
      :aria-hidden="!lgUp && !playlistsSheetOpen ? true : undefined"
      @keydown.esc.stop="playlistsSheetOpen = false"
      :class="[
        'lg:relative lg:z-auto lg:translate-x-0 lg:h-auto lg:w-auto lg:shadow-none',
        'fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] p-2 sm:p-3 lg:p-0 min-h-0 min-w-0',
        animateSheets ? 'transition-transform duration-200 ease-out-cubic' : '',
        playlistsSheetOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      ]"
    >
      <PlaylistRail @open-settings="settingsOpen = true; closeSheets()" />
      <button
        v-if="!lgUp && playlistsSheetOpen"
        class="absolute top-3 -right-8 h-8 w-8 rounded-lg bg-zinc-900 border border-hair text-white/85 hover:text-white hover:bg-zinc-800 flex items-center justify-center transition-colors"
        @click="playlistsSheetOpen = false"
        aria-label="Close playlists"
      >
        <X :size="14" />
      </button>
    </div>

    <!-- Center column wrapper. md:contents collapses it so the main panel
         becomes a direct grid child at md+. -->
    <div class="flex flex-col gap-2 sm:gap-3 min-h-0 md:contents">
      <MobileTransportStrip />
      <MusicMiniPlayer class="md:hidden shrink-0" />
      <ChannelEditor :channel="channel" @edit="openEdit" @open-shortcuts="shortcutsOpen = true" />
    </div>

    <!-- Up-next rail. In-grid on md+; slides in from the right on mobile. -->
    <div
      :inert="!mdUp && !upNextSheetOpen"
      :aria-hidden="!mdUp && !upNextSheetOpen ? true : undefined"
      @keydown.esc.stop="upNextSheetOpen = false"
      :class="[
        'md:relative md:z-auto md:translate-x-0 md:h-auto md:w-auto md:shadow-none',
        'fixed inset-y-0 right-0 z-50 w-[320px] max-w-[88vw] p-2 sm:p-3 md:p-0 min-h-0 min-w-0',
        animateSheets ? 'transition-transform duration-200 ease-out-cubic' : '',
        upNextSheetOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0',
      ]"
    >
      <UpNextRail />
      <button
        v-if="!mdUp && upNextSheetOpen"
        class="absolute top-3 -left-8 h-8 w-8 rounded-lg bg-zinc-900 border border-hair text-white/85 hover:text-white hover:bg-zinc-800 flex items-center justify-center transition-colors"
        @click="upNextSheetOpen = false"
        aria-label="Close upcoming slides"
      >
        <X :size="14" />
      </button>
    </div>

    <Transition
      enter-active-class="transition-opacity duration-200 ease-out-cubic"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150 ease-out-cubic"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="showBackdrop" class="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm" @click="closeSheets" />
    </Transition>

    <EditItemDialog v-model:open="editOpen" :item="editing" @save="saveEdit" />
    <SettingsDialog v-model:open="settingsOpen" />
    <ShortcutsDialog v-model:open="shortcutsOpen" />

  </div>
</template>

<style scoped>
.presentation-workspace {
  height: 100%;
  width: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  padding: 12px;
  background: var(--bg-base);
  color: var(--text-primary);
}
.presentation-transport { grid-column: 1 / -1; min-width: 0; }
@media (min-width: 768px) {
  .presentation-workspace { grid-template-columns: minmax(0, 1fr) 270px; }
}
@media (min-width: 1024px) {
  .presentation-workspace { grid-template-columns: 200px minmax(0, 1fr) 280px; }
}
@media (min-width: 1500px) {
  .presentation-workspace { grid-template-columns: 216px minmax(0, 1fr) 310px; }
}
@media (max-width: 767px) {
  .presentation-workspace { padding: 8px; gap: 8px; }
}
</style>
