<script setup lang="ts">
import { ref } from 'vue';
import { Plus, Trash2, Settings as SettingsIcon, ListMusic } from 'lucide-vue-next';
import { useContentStore } from '@/stores/content';
import { Button } from '@/components/ui/button';

const content = useContentStore();

const adding = ref(false);
const newName = ref('');

async function commitAdd() {
  if (!newName.value.trim()) {
    adding.value = false;
    return;
  }
  await content.addPlaylist(newName.value.trim());
  newName.value = '';
  adding.value = false;
}

const emit = defineEmits<{ (e: 'open-settings'): void }>();
</script>

<template>
  <aside class="panel flex flex-col h-full p-3 gap-2">
    <header class="flex items-center justify-between px-2 pt-1">
      <div class="flex items-center gap-2">
        <div class="h-7 w-7 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center">
          <ListMusic :size="14" class="text-accent" />
        </div>
        <span class="text-sm font-semibold tracking-display text-white">Lumen</span>
      </div>
      <Button variant="ghost" size="icon" @click="emit('open-settings')">
        <SettingsIcon :size="14" />
      </Button>
    </header>

    <div class="px-2 pt-1 pb-1 text-[11px] uppercase tracking-[0.12em] text-white/40 font-medium">
      Playlists
    </div>

    <ul class="flex flex-col gap-1 overflow-y-auto flex-1 -mx-1 px-1">
      <li
        v-for="p in content.playlists"
        :key="p.id"
        class="group flex items-center justify-between rounded-xl px-3 py-2.5 cursor-pointer transition-all duration-150 ease-out-cubic"
        :class="
          content.activePlaylistId === p.id
            ? 'bg-white/[0.10] border border-hairglow'
            : 'hover:bg-white/[0.04] border border-transparent'
        "
        @click="content.setActive(p.id)"
      >
        <div class="min-w-0">
          <div class="text-sm font-medium text-white truncate">{{ p.name }}</div>
          <div class="text-xs text-white/45 mt-0.5">
            {{ p.items.length }} {{ p.items.length === 1 ? 'item' : 'items' }}
          </div>
        </div>
        <button
          class="opacity-0 group-hover:opacity-100 transition-opacity text-white/45 hover:text-red-400"
          @click.stop="content.removePlaylist(p.id)"
        >
          <Trash2 :size="13" />
        </button>
      </li>
    </ul>

    <div class="pt-2">
      <input
        v-if="adding"
        v-model="newName"
        autofocus
        class="w-full rounded-xl bg-white/[0.06] border border-hairglow px-3 py-2 text-sm text-white placeholder:text-white/35 outline-none focus:border-accent/60 transition-colors"
        placeholder="Playlist name…"
        @keydown.enter="commitAdd"
        @keydown.escape="adding = false"
        @blur="commitAdd"
      />
      <Button v-else variant="ghost" size="md" class="w-full justify-start" @click="adding = true">
        <Plus :size="14" />
        New playlist
      </Button>
    </div>
  </aside>
</template>
