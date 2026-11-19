<script setup lang="ts">
import { computed, ref } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import {
  Play,
  LoaderCircle,
  Pause,
  SkipForward,
  Music2,
  ListMusic,
  Trash2,
  GripVertical,
  Plus,
  Repeat,
  Shuffle,
  CircleSlash2,
  Headphones,
} from 'lucide-vue-next';
import { Slider } from '@/components/ui/slider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useMusicStore } from '@/stores/music';
import { useContentStore } from '@/stores/content';
import { api } from '@/lib/api';
import { toast } from 'vue-sonner';
import type { MusicMode } from '@/types';
import MediaImagePicker from '@/components/media/MediaImagePicker.vue';
import { mediaAssetReference, type MediaLibraryAsset } from '@/lib/media-library';
import { useIdentityStore } from '@/stores/identity';

// The media picker is a second root. Responsive layout attributes belong on
// the player itself, otherwise its hidden phone/desktop copy enters the grid.
defineOptions({ inheritAttrs: false });

const music = useMusicStore();
const content = useContentStore();
const identity = useIdentityStore(), mediaPickerOpen = ref(false);

const queueOpen = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

async function chooseTrack(asset: MediaLibraryAsset) {
  if (!identity.can('*', 'author') || asset.origin !== 'library' || asset.kind !== 'audio') return;
  const path = mediaAssetReference(asset);
  const saved = await content.save(draft => {
    if (!draft.music.queue.includes(path)) draft.music.queue.push(path);
    if (!draft.music.current) draft.music.current = path;
  });
  if (saved) { mediaPickerOpen.value = false; toast.success(`Added “${asset.displayName}” to music.`); }
}

const trackName = computed(() => {
  const t = music.currentTrack ?? content.content.music.current;
  if (!t) return 'No track';
  return t.split('/').pop() ?? t;
});

function shortName(rel: string) {
  return rel.split('/').pop() ?? rel;
}

function setVolume(v: number[] | undefined) {
  if (!v || v.length === 0) return;
  void content.updateMusic({ volume: v[0] });
}

const MODES: { value: MusicMode; label: string; icon: typeof Repeat }[] = [
  { value: 'off', label: 'Single', icon: CircleSlash2 },
  { value: 'loop', label: 'Loop', icon: Repeat },
  { value: 'playlist', label: 'Playlist', icon: Shuffle },
];

function setMode(m: MusicMode) {
  void content.updateMusic({ mode: m });
}

async function onUpload(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files || files.length === 0) return;
  for (const file of files) {
    try {
      const { path } = await api.uploadMedia('music', file);
      await content.updateMusic({
        queue: [...content.content.music.queue, path],
        current: content.content.music.current ?? path,
      });
      toast.success(`Added "${file.name}"`);
    } catch (err) {
      toast.error(`Upload failed: ${(err as Error).message}`);
    }
  }
  if (fileInput.value) fileInput.value.value = '';
}

// Local mirror so vue-draggable-plus has a stable model; sync to store on drop.
const localQueue = computed({
  get: () => content.content.music.queue,
  set: () => {
    // no-op — store updates flow through reorderTrack().
  },
});

async function onQueueSorted(e: { oldIndex?: number; newIndex?: number }) {
  if (typeof e.oldIndex !== 'number' || typeof e.newIndex !== 'number') return;
  await music.reorderTrack(e.oldIndex, e.newIndex);
}
</script>

<template>
  <div v-bind="$attrs" class="music-mini-player flex items-center gap-2 panel-soft px-2 py-1 h-9 min-w-0 md:min-w-[220px] w-full md:w-auto">
    <Music2 :size="14" class="text-white/55" />
    <button
      class="h-6 w-6 rounded-md flex items-center justify-center bg-white/[0.06] hover:bg-white/[0.12] transition-colors disabled:opacity-40"
      :disabled="music.starting || !music.currentTrack && !content.content.music.current && content.content.music.queue.length === 0"
      :title="music.playing ? 'Pause music' : 'Play music'"
      :aria-label="music.starting ? 'Preparing music' : music.playing ? 'Pause music' : 'Play music'"
      @click="music.toggle"
    >
      <LoaderCircle v-if="music.starting" :size="11" class="animate-spin" /><Pause v-else-if="music.playing" :size="11" />
      <Play v-else :size="11" />
    </button>
    <button
      class="h-6 w-6 rounded-md flex items-center justify-center hover:bg-white/10 transition-colors text-white/60 disabled:opacity-30"
      :disabled="music.queue.length < 2"
      title="Skip"
      @click="music.skip"
    >
      <SkipForward :size="11" />
    </button>

    <button type="button" class="music-auto shrink-0 text-[10px] px-1.5 py-1 rounded-md border border-hair"
      :class="music.autoEnabled ? 'text-accent bg-accent/10' : 'text-white/55'"
      :aria-pressed="music.autoEnabled" aria-label="Music Auto" title="Automatically repeat or advance tracks"
      @click="music.setAutoEnabled(!music.autoEnabled)">Auto {{ music.autoEnabled ? 'on' : 'off' }}</button>

    <Popover v-model:open="queueOpen">
      <PopoverTrigger as-child>
        <button
          class="flex-1 min-w-0 flex items-center gap-1.5 text-xs text-white/70 hover:text-white truncate transition-colors text-left"
          title="Open queue"
        >
          <ListMusic :size="11" class="text-white/45 shrink-0" />
          <span class="truncate">{{ trackName }}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent class="w-80 max-w-[calc(100vw-24px)] p-3" align="end">
        <header class="flex items-center justify-between">
          <h3 class="text-xs font-semibold tracking-[0.12em] uppercase text-white/55">
            Music queue
          </h3>
          <label class="cursor-pointer text-xs text-accent hover:text-white flex items-center gap-1 transition-colors">
            <Plus :size="11" />
            Upload
            <input
              ref="fileInput"
              type="file"
              class="hidden"
              accept="audio/*"
              multiple
              @change="onUpload"
            />
          </label>
        </header>

        <button v-if="identity.can('*', 'author')" type="button" class="my-2 flex w-full items-center justify-center gap-2 rounded-lg border border-hair px-3 py-2 text-xs text-accent hover:bg-white/5" @click="mediaPickerOpen = true"><ListMusic :size="13" />Choose from Media</button>

        <div class="flex items-center justify-between gap-2 my-3 text-xs text-white/60">
          <span>Music feeds Program’s Main mix.</span>
          <button type="button" class="flex items-center gap-1.5 px-2 py-1 rounded-md border border-hair"
            :class="{ 'text-accent': music.monitorEnabled }" :aria-pressed="music.monitorEnabled"
            aria-label="Monitor music locally" title="Use headphones to avoid feedback"
            @click="music.setMonitorEnabled(!music.monitorEnabled)"><Headphones :size="12" />Monitor</button>
        </div>
        <p class="text-[11px] text-white/50 mb-2">When Auto is on</p>
        <div class="flex gap-1.5">
          <button
            v-for="m in MODES"
            :key="m.value"
            class="flex-1 h-7 rounded-lg text-[11px] font-medium border flex items-center justify-center gap-1 transition-colors"
            :class="
              content.content.music.mode === m.value
                ? 'bg-accent/15 text-accent border-accent/40'
                : 'bg-white/[0.04] text-white/65 border-hair hover:bg-white/[0.08]'
            "
            @click="setMode(m.value)"
          >
            <component :is="m.icon" :size="11" />
            {{ m.label }}
          </button>
        </div>

        <div
          v-if="content.content.music.queue.length === 0"
          class="text-xs text-white/45 text-center py-4"
        >
          Empty queue. Upload an audio file to get started.
        </div>

        <VueDraggable
          v-else
          v-model="localQueue"
          handle=".track-handle"
          :animation="160"
          ghost-class="opacity-30"
          class="flex flex-col gap-1 max-h-64 overflow-y-auto -mx-1 px-1"
          @end="onQueueSorted"
        >
          <div
            v-for="(track, i) in content.content.music.queue"
            :key="track"
            class="group flex items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors"
            :class="
              music.currentTrack === track
                ? 'bg-accent/12 text-accent'
                : 'text-white/75 hover:bg-white/[0.05]'
            "
          >
            <span class="text-[10px] tnum w-5 text-white/40 text-right shrink-0">
              {{ String(i + 1).padStart(2, '0') }}
            </span>
            <button
              class="flex-1 min-w-0 text-left text-xs truncate"
              :title="`Play ${shortName(track)}`"
              @click="music.jumpToTrack(track)"
            >
              {{ shortName(track) }}
            </button>
            <button
              class="opacity-0 group-hover:opacity-100 text-white/45 hover:text-red-300 transition-opacity"
              title="Remove"
              @click="music.removeTrack(track)"
            >
              <Trash2 :size="11" />
            </button>
            <div
              class="track-handle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing text-white/40 transition-opacity"
              title="Drag to reorder"
            >
              <GripVertical :size="11" />
            </div>
          </div>
        </VueDraggable>
      </PopoverContent>
    </Popover>

    <div class="w-16 shrink-0">
      <Slider
        aria-label="Music volume"
        :model-value="[music.volume]"
        :min="0"
        :max="1"
        :step="0.01"
        @update:model-value="setVolume"
      />
    </div>
  </div>
  <MediaImagePicker v-model:open="mediaPickerOpen" :accepted-kinds="['audio']" @select="chooseTrack" />
</template>

<style scoped>
.music-mini-player { border-radius: var(--radius-control, 7px); background: #0002; }
.music-mini-player button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
