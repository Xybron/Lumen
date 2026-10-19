<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue';
import { Plus, Trash2, Pencil, Settings as SettingsIcon, ListVideo } from 'lucide-vue-next';
import { useContentStore } from '@/stores/content';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useEnginesStore } from '@/stores/engines';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { toast } from 'vue-sonner';
import type { Playlist } from '@/types';

const content = useContentStore();
const engines = useEnginesStore();
const identity = useIdentityStore();
const presence = usePresenceStore();
const canCreate = computed(() => identity.can('*', 'author'));
const visiblePlaylists = computed(() => content.playlists.filter(playlist => !content.channels.some(channel => channel.playlistId === playlist.id && ['scripture', 'lyrics'].includes(channel.kind))));
const channelFor = (playlistId: string) => content.channels.find(channel => channel.playlistId === playlistId);
const isSelected = (playlistId: string) => channelFor(playlistId)?.id === engines.focusedChannelId;
const canEditPlaylist = (playlistId: string) => {
  const channel = channelFor(playlistId);
  return channel ? identity.can(channel.id, 'author') && !presence.controlledByOther(channel.id) : canCreate.value;
};
const openingPlaylist = ref<Playlist | null>(null);
const deletingPlaylist = ref<Playlist | null>(null);
const busy = ref(false);

const adding = ref(false);
const newName = ref('');

const renamingId = ref<string | null>(null);
const renameDraft = ref('');
const renameInput = useTemplateRef<HTMLInputElement | HTMLInputElement[]>('renameInput');

async function commitAdd() {
  if (busy.value || !canCreate.value) return;
  if (!newName.value.trim()) {
    adding.value = false;
    return;
  }
  busy.value = true;
  try {
    const created = await content.addChannel(newName.value.trim(), 'presentation');
    engines.focusChannel(created.channelId);
    newName.value = '';
    adding.value = false;
  } catch (error) { toast.error((error as Error).message); }
  finally { busy.value = false; }
}

function selectPlaylist(playlist: Playlist) {
  const channel = channelFor(playlist.id);
  if (channel) engines.focusChannel(channel.id);
  else openingPlaylist.value = playlist;
}
async function openLegacyPlaylist() {
  if (!openingPlaylist.value || busy.value || !canCreate.value) return;
  busy.value = true;
  try {
    const created = await content.createChannelForPlaylist(openingPlaylist.value.id);
    engines.focusChannel(created.channelId);
    openingPlaylist.value = null;
  } catch (error) { toast.error((error as Error).message); }
  finally { busy.value = false; }
}
async function deletePlaylist() {
  const playlist = deletingPlaylist.value;
  if (!playlist || busy.value || !canEditPlaylist(playlist.id)) return;
  busy.value = true;
  try {
    const channel = channelFor(playlist.id);
    if (channel) await content.removeChannel(channel.id);
    else await content.removePlaylist(playlist.id);
    if (!content.playlists.some(item => item.id === playlist.id)) deletingPlaylist.value = null;
  } finally { busy.value = false; }
}

async function startRename(p: { id: string; name: string }) {
  if (!canEditPlaylist(p.id)) return;
  renamingId.value = p.id;
  renameDraft.value = p.name;
  await nextTick();
  const input = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value;
  input?.focus();
  input?.select();
}

async function commitRename() {
  const id = renamingId.value;
  if (!id || !canEditPlaylist(id)) return;
  const next = renameDraft.value.trim();
  // Cancel rename if blank or unchanged.
  const original = content.playlists.find((p) => p.id === id)?.name;
  if (next && next !== original) {
    const channel = channelFor(id);
    if (channel) await content.renameChannel(channel.id, next);
    else await content.renamePlaylist(id, next);
  }
  renamingId.value = null;
  renameDraft.value = '';
}

function cancelRename() {
  renamingId.value = null;
  renameDraft.value = '';
}

const emit = defineEmits<{ (e: 'open-settings'): void }>();
</script>

<template>
  <aside class="panel playlist-rail" aria-label="Presentation playlists">
    <header class="playlist-heading">
      <div class="flex items-center gap-2 min-w-0">
        <ListVideo :size="15" class="text-white/55 shrink-0" />
        <h2 class="text-[12px] font-semibold text-white">Playlists</h2>
        <span class="playlist-count">{{ visiblePlaylists.length }}</span>
      </div>
      <Button variant="ghost" size="icon" class="!h-7 !w-7" title="Presentation settings" aria-label="Presentation settings" @click="emit('open-settings')">
        <SettingsIcon :size="14" />
      </Button>
    </header>

    <ul class="playlist-list">
      <li
        v-for="p in visiblePlaylists"
        :key="p.id"
        class="group playlist-row"
        :class="{ active: isSelected(p.id) }"
      >
        <div class="min-w-0 flex-1">
          <input
            v-if="renamingId === p.id"
            ref="renameInput"
            v-model="renameDraft"
            aria-label="Rename presentation"
            class="w-full bg-white/[0.06] border border-hairglow rounded-lg px-2 py-1 text-sm text-white outline-none focus:border-accent/60 transition-colors"
            @click.stop
            @keydown.enter.prevent="commitRename"
            @keydown.escape.prevent="cancelRename"
            @blur="commitRename"
          />
          <button v-else type="button" class="playlist-select" :aria-current="isSelected(p.id) ? 'true' : undefined" :aria-label="channelFor(p.id) ? `Open presentation ${p.name}` : `Open ${p.name} as presentation`" @click="selectPlaylist(p)">
            <span class="truncate">{{ p.name }}</span>
            <small>{{ p.items.length }} {{ p.items.length === 1 ? 'slide' : 'slides' }}<span v-if="!channelFor(p.id)"> · Not linked</span></small>
          </button>
        </div>

        <div
          v-if="renamingId !== p.id"
          class="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity shrink-0"
        >
          <button
            class="h-7 w-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/[0.08] transition-colors"
            title="Rename"
            :aria-label="`Rename ${p.name}`"
            :disabled="!canEditPlaylist(p.id)"
            @click.stop="startRename(p)"
          >
            <Pencil :size="12" />
          </button>
          <button
            class="h-7 w-7 rounded-lg flex items-center justify-center text-white/45 hover:text-red-300 hover:bg-red-500/15 transition-colors"
            title="Delete"
            :aria-label="`Delete ${p.name}`"
            :disabled="!canEditPlaylist(p.id)"
            @click.stop="deletingPlaylist = p"
          >
            <Trash2 :size="13" />
          </button>
        </div>
      </li>
      <li v-if="visiblePlaylists.length === 0" class="playlist-empty">Create a presentation to organise your slides.</li>
    </ul>

    <div class="playlist-footer">
      <form v-if="adding" class="grid gap-2" @submit.prevent="commitAdd">
        <input v-model="newName" autofocus :disabled="busy" aria-label="Presentation name" class="w-full rounded-lg bg-white/[0.06] border border-hairglow px-3 py-2 text-xs text-white placeholder:text-white/35 outline-none focus:border-accent/60 transition-colors" placeholder="Presentation name…" @keydown.escape.prevent="adding = false" />
        <div class="flex gap-2"><Button type="button" variant="ghost" size="sm" :disabled="busy" @click="adding = false">Cancel</Button><Button type="submit" variant="accent" size="sm" class="flex-1" :disabled="busy || !newName.trim()">Create</Button></div>
      </form>
      <Button v-else variant="default" size="md" class="w-full justify-start !text-xs" :disabled="!canCreate" @click="adding = true">
        <Plus :size="14" />
        New presentation
      </Button>
    </div>
  </aside>
  <Dialog :open="!!openingPlaylist" @update:open="value => { if (!value && !busy) openingPlaylist = null; }">
    <DialogContent class="sm:max-w-md" :show-close-button="!busy" @escape-key-down="event => { if (busy) event.preventDefault(); }" @interact-outside="event => { if (busy) event.preventDefault(); }">
      <DialogHeader><DialogTitle>Open as presentation</DialogTitle><DialogDescription>Create a presentation channel for “{{ openingPlaylist?.name }}” using its existing {{ openingPlaylist?.items.length }} slides. No slides are copied or removed, and playback will not start.</DialogDescription></DialogHeader>
      <p v-if="!canCreate" class="text-xs text-amber-200/80">A station author or administrator can link this playlist.</p>
      <DialogFooter><Button variant="ghost" :disabled="busy" @click="openingPlaylist = null">Cancel</Button><Button variant="accent" :disabled="busy || !canCreate" @click="openLegacyPlaylist">{{ busy ? 'Creating…' : 'Create presentation channel' }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
  <Dialog :open="!!deletingPlaylist" @update:open="value => { if (!value && !busy) deletingPlaylist = null; }">
    <DialogContent class="sm:max-w-md" :show-close-button="!busy" @escape-key-down="event => { if (busy) event.preventDefault(); }" @interact-outside="event => { if (busy) event.preventDefault(); }">
      <DialogHeader><DialogTitle>Delete {{ deletingPlaylist && channelFor(deletingPlaylist.id) ? 'presentation' : 'playlist' }}?</DialogTitle><DialogDescription>“{{ deletingPlaylist?.name }}” and its {{ deletingPlaylist?.items.length }} slides will be removed. {{ deletingPlaylist && channelFor(deletingPlaylist.id) ? 'Its channel and routes will also be removed.' : '' }} This cannot be undone here.</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="ghost" :disabled="busy" @click="deletingPlaylist = null">Cancel</Button><Button variant="destructive" :disabled="busy" @click="deletePlaylist">{{ busy ? 'Deleting…' : 'Delete permanently' }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.playlist-rail { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.playlist-heading { min-height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px 8px 14px; border-bottom: 1px solid var(--border-hair); flex-shrink: 0; }
.playlist-count { color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.playlist-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 3px; }
.playlist-row { position: relative; display: flex; align-items: center; gap: 3px; padding: 0 3px 0 9px; border: 1px solid transparent; border-radius: var(--radius-control, 7px); flex-shrink: 0; transition: background .12s, border-color .12s; }
.playlist-row:hover { background: #ffffff05; }
.playlist-row.active { background: #7dd3fc0b; border-color: #7dd3fc26; }
.playlist-row.active::before { content: ''; position: absolute; left: -1px; top: 11px; bottom: 11px; width: 2px; background: var(--accent); border-radius: 2px; }
.playlist-select { display: flex; flex-direction: column; width: 100%; min-width: 0; padding: 10px 0; gap: 3px; text-align: left; color: var(--text-primary); font-size: 12px; }
.playlist-select small { color: var(--text-muted); font-size: 10px; }
.playlist-empty { padding: 16px 8px; color: var(--text-muted); font-size: 11px; line-height: 1.6; }
.playlist-footer { padding: 10px; border-top: 1px solid var(--border-hair); flex-shrink: 0; }
.playlist-rail button:focus-visible, .playlist-rail input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.playlist-rail button:disabled { opacity: .35; cursor: not-allowed; }
</style>
