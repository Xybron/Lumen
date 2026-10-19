<script setup lang="ts">
import { computed, ref } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import { Plus, Upload, KeyboardIcon, LayoutList, LayoutGrid } from 'lucide-vue-next';
import { useDropZone } from '@vueuse/core';
import { toast } from 'vue-sonner';
import SlideCard from '@/components/dashboard/SlideCard.vue';
import { Button } from '@/components/ui/button';
import { useContentStore } from '@/stores/content';
import { usePlaybackStore } from '@/stores/playback';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { api } from '@/lib/api';
import type { Channel, Item, ItemType } from '@/types';

const props = defineProps<{ channel: Channel | null }>();
const emit = defineEmits<{ (e: 'edit', item: Item): void; (e: 'open-shortcuts'): void }>();

const content = useContentStore();
const playback = usePlaybackStore();
const identity = useIdentityStore();
const presence = usePresenceStore();
const canEdit = computed(() => !!props.channel && identity.can(props.channel.id, 'author') && !playback.readOnly);
const editorPlaylistId = computed(() => props.channel?.playlistId ?? null);
const editorPlaylist = computed(() => content.playlists.find(playlist => playlist.id === editorPlaylistId.value) ?? null);

type SlideView = 'list' | 'grid';
const SLIDE_VIEW_KEY = 'lumen.slideView';
function restoredSlideView(): SlideView {
  try { return localStorage.getItem(SLIDE_VIEW_KEY) === 'grid' ? 'grid' : 'list'; }
  catch { return 'list'; }
}
const slideView = ref<SlideView>(restoredSlideView());
function setSlideView(v: SlideView) {
  slideView.value = v;
  try {
    localStorage.setItem(SLIDE_VIEW_KEY, v);
  } catch {
    /* private mode / quota — fine to swallow */
  }
}

const dropTarget = ref<HTMLElement | null>(null);
const mediaInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const { isOverDropZone } = useDropZone(dropTarget, { onDrop: handleDrop });
const slideCount = computed(() => playback.items.filter(item => item.type !== 'section').length);

async function handleDrop(files: File[] | null) {
  if (!files || !editorPlaylistId.value || uploading.value || !canEdit.value) return;
  // Capture the destination once: changing channels during a slow upload must
  // not send later files to a different playlist.
  const playlistId = editorPlaylistId.value;
  const channelId = props.channel!.id;
  const canWriteDestination = () => identity.can(channelId, 'author') && !presence.controlledByOther(channelId)
    && content.channels.some(channel => channel.id === channelId && channel.playlistId === playlistId);
  uploading.value = true;
  try {
    for (const file of files) {
      if (!canWriteDestination()) break;
      if (file.type.startsWith('image') || file.type.startsWith('video')) {
        const { path } = await api.uploadMedia('backgrounds', file);
        if (!canWriteDestination()) throw new Error('Presentation control changed while uploading. The slide was not added.');
        await content.addItem(playlistId, {
          type: file.type.startsWith('video') ? 'video' : 'image',
          title: file.name,
          durationMs: 30000,
          background: { kind: file.type.startsWith('video') ? 'video' : 'image', src: path, fit: 'cover', overlayOpacity: 0 },
        });
      } else if (file.type.startsWith('audio')) {
        const { path } = await api.uploadMedia('music', file);
        if (!canWriteDestination()) throw new Error('Presentation control changed while uploading. The music queue was not changed.');
        await content.updateMusic({
          queue: [...content.content.music.queue, path],
          current: content.content.music.current ?? path,
        });
        toast.success(`Added "${file.name}" to music queue`);
      }
    }
  } catch (error) {
    toast.error(`Could not upload media: ${(error as Error).message}`);
  } finally {
    uploading.value = false;
    if (mediaInput.value) mediaInput.value.value = '';
  }
}

function selectMedia(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (files) void handleDrop(Array.from(files));
}

// The default new-slide type follows the channel's kind.
function defaultTypeForKind(kind?: string): ItemType {
  switch (kind) {
    case 'prayer':
      return 'prayer';
    case 'lyrics':
      return 'lyrics';
    case 'announcement':
      return 'announcement';
    case 'presentation':
      return 'text';
    default:
      return 'scripture';
  }
}

async function addSlide() {
  if (!editorPlaylistId.value || !canEdit.value) return;
  const playlistId = editorPlaylistId.value;
  await content.addItem(playlistId, {
    type: defaultTypeForKind(props.channel?.kind),
    title: '',
    body: 'Tap edit to fill this in…',
    background: { kind: 'color', color: '#0a0a0c', overlayOpacity: 0 },
  });
}

async function onSorted(e: { oldIndex?: number; newIndex?: number }) {
  if (!editorPlaylistId.value || !canEdit.value) return;
  if (typeof e.oldIndex !== 'number' || typeof e.newIndex !== 'number') return;
  if (e.oldIndex === e.newIndex) return;
  const { oldIndex, newIndex } = e;
  const playlistId = editorPlaylistId.value;
  const channelId = props.channel?.id;
  const ok = await content.reorderItems(playlistId, oldIndex, newIndex);
  if (!ok) return;
  if (props.channel?.id !== channelId) return;
  // Keep the same slide "current" — only after the save lands.
  if (playback.index === oldIndex) playback.index = newIndex;
  else if (oldIndex < playback.index && newIndex >= playback.index) playback.index--;
  else if (oldIndex > playback.index && newIndex <= playback.index) playback.index++;
}

const kindLabels: Record<string, string> = { prayer: 'Prayer presentation', announcement: 'Announcements', presentation: 'Presentation' };
const kindLabel = (kind?: string) => kindLabels[kind ?? ''] ?? 'Presentation';
</script>

<template>
  <main ref="dropTarget" class="panel presentation-editor" :class="{ 'drop-active': isOverDropZone }" aria-label="Slide editor">
    <input ref="mediaInput" type="file" class="hidden" accept="image/*,video/*,audio/*" multiple aria-label="Upload presentation media" @change="selectMedia" />
    <header class="presentation-editor-heading">
      <div class="min-w-0">
        <h1 class="text-[13px] font-semibold text-white truncate">
          {{ channel?.name ?? editorPlaylist?.name ?? 'No channel selected' }}
        </h1>
        <p class="presentation-editor-meta">{{ kindLabel(channel?.kind) }}<span>·</span>{{ slideCount }} {{ slideCount === 1 ? 'slide' : 'slides' }}</p>
      </div>
      <div class="presentation-editor-actions">
        <div class="flex items-center gap-0.5 panel-soft p-0.5" role="group" aria-label="Slide view">
          <button
            class="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
            :class="slideView === 'list' ? 'bg-white/[0.10] text-white' : 'text-white/55 hover:text-white hover:bg-white/[0.06]'"
            title="List view"
            :aria-pressed="slideView === 'list'"
            @click="setSlideView('list')"
          >
            <LayoutList :size="14" />
          </button>
          <button
            class="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
            :class="slideView === 'grid' ? 'bg-white/[0.10] text-white' : 'text-white/55 hover:text-white hover:bg-white/[0.06]'"
            title="Grid view"
            :aria-pressed="slideView === 'grid'"
            @click="setSlideView('grid')"
          >
            <LayoutGrid :size="14" />
          </button>
        </div>
        <Button variant="ghost" size="md" class="hidden sm:inline-flex !h-8 !w-8 !p-0" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" @click="emit('open-shortcuts')">
          <KeyboardIcon :size="14" />
        </Button>
        <Button variant="ghost" size="md" class="!h-8 !text-xs" :disabled="!editorPlaylistId || uploading || !canEdit" title="Upload images, videos or audio" @click="mediaInput?.click()">
          <Upload :size="14" />
          <span class="hidden xl:inline">{{ uploading ? 'Uploading…' : 'Import' }}</span>
        </Button>
        <Button variant="accent" size="md" class="!h-8 !text-xs" :disabled="!editorPlaylistId || !canEdit" @click="addSlide">
          <Plus :size="14" />
          <span>New slide</span>
        </Button>
      </div>
    </header>

    <div v-if="!editorPlaylist || playback.items.length === 0" class="presentation-empty">
      <div class="max-w-sm text-center">
        <div class="mx-auto h-10 w-10 rounded-lg bg-white/[0.04] border border-hair flex items-center justify-center mb-4">
          <Upload :size="20" class="text-white/55" />
        </div>
        <div class="text-base font-medium text-white tracking-display">
          {{ content.channels.length === 0 ? 'Create your first presentation' : !editorPlaylist ? 'Choose a presentation' : 'Your playlist is ready' }}
        </div>
        <p class="text-sm text-white/55 mt-1.5 leading-relaxed">
          <template v-if="content.channels.length === 0">Choose New presentation in the Playlists panel to begin.</template>
          <template v-else-if="!editorPlaylist">Select or create a presentation from the Playlists panel.</template>
          <template v-else>Add a slide, import media, or drag files into this workspace.</template>
        </p>
        <div v-if="editorPlaylist" class="flex items-center justify-center flex-wrap gap-2 mt-5">
          <Button variant="accent" size="md" :disabled="!canEdit" @click="addSlide"><Plus :size="14" />New slide</Button>
          <Button variant="default" size="md" :disabled="uploading || !canEdit" @click="mediaInput?.click()"><Upload :size="14" />{{ uploading ? 'Uploading…' : 'Import media' }}</Button>
        </div>
      </div>
    </div>

    <VueDraggable
      v-else
      :model-value="playback.items"
      handle=".drag-handle"
      :animation="180"
      :disabled="!canEdit"
      ghost-class="opacity-30"
      :class="[
        'presentation-slide-list',
        slideView === 'grid' ? 'grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2.5 auto-rows-min' : 'flex flex-col gap-1.5',
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
        :editable="canEdit"
        :playlist-id="editorPlaylistId"
        @edit="canEdit && emit('edit', item)"
        @duplicate="canEdit && content.duplicateItem(editorPlaylistId!, item.id)"
        @delete="canEdit && content.removeItem(editorPlaylistId!, item.id)"
        @jump="playback.jumpTo(i)"
      />
    </VueDraggable>
    <div class="presentation-editor-footer"><span>{{ !canEdit ? 'Read-only workspace' : uploading ? 'Uploading media…' : isOverDropZone ? 'Drop media to import' : 'Drag to reorder · Double-click a slide to show it' }}</span><span class="hidden sm:inline">{{ playback.mode === 'auto' ? 'Auto advance' : 'Manual control' }}</span></div>
  </main>
</template>

<style scoped>
.presentation-editor { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.presentation-editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border-hair); flex-shrink: 0; }
.presentation-editor-meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 10px; color: var(--text-muted); }
.presentation-editor-meta span { opacity: .5; }
.presentation-editor-actions { display: flex; flex-shrink: 0; align-items: center; gap: 5px; }
.presentation-slide-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px 100px; scroll-padding-block: 12px 100px; }
.presentation-editor-footer { min-height: 30px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 5px; padding: 7px 12px; border-top: 1px solid var(--border-hair); color: var(--text-muted); font-size: 9px; flex-shrink: 0; }
.presentation-empty { flex: 1; min-height: 200px; overflow-y: auto; display: flex; align-items: center; justify-content: center; padding: 30px 20px 110px; }
.drop-active { outline: 2px solid var(--accent); outline-offset: -3px; background: #7dd3fc08; }
@media (max-width: 600px) { .presentation-editor-heading { flex-wrap: wrap; padding: 10px; gap: 10px; } .presentation-editor-heading>div:first-child { flex: 1 0 100%; } .presentation-editor-actions { width: 100%; justify-content: flex-end; } .presentation-editor-actions>div:first-child { margin-right: auto; } .presentation-slide-list { padding: 8px 8px 110px; } .presentation-empty { min-height: 180px; padding: 24px 14px 100px; } }
</style>
