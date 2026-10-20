<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Upload, Wand2, Plus, Trash2 } from 'lucide-vue-next';
import type { Item, ItemType } from '@/types';
import { api, mediaUrl } from '@/lib/api';
import { shortId } from '@/lib/ids';
import { toast } from 'vue-sonner';

const FIT_MODES: { value: 'cover' | 'contain' | 'fill'; label: string }[] = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'fill', label: 'Fill' },
];

// Probe a video element off-screen to read its natural duration. We resolve
// even on error so an unsupported codec doesn't hang the dialog.
function probeVideoDurationMs(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const cleanup = () => {
      v.src = '';
      v.removeAttribute('src');
    };
    v.addEventListener('loadedmetadata', () => {
      const ms = Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null;
      cleanup();
      resolve(ms);
    });
    v.addEventListener('error', () => {
      cleanup();
      resolve(null);
    });
    v.src = url;
  });
}

const props = defineProps<{ open: boolean; item: Item | null }>();
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'save', item: Item): void;
}>();

const draft = ref<Item | null>(null);
const backgrounds = ref<{ name: string; path: string }[]>([]);
const uploading = ref(false);

watch(
  () => [props.open, props.item],
  async ([open, item]) => {
    if (open && item) {
      draft.value = JSON.parse(JSON.stringify(item)) as Item;
      try {
        backgrounds.value = await api.listMedia('backgrounds');
      } catch {
        backgrounds.value = [];
      }
    }
  },
  { immediate: true },
);

const TYPES: { value: ItemType; label: string }[] = [
  { value: 'scripture', label: 'Scripture' },
  { value: 'text', label: 'Text' },
  { value: 'prayer', label: 'Prayer' },
  { value: 'prayer-sub', label: 'Prayer (sub)' },
  { value: 'lyrics', label: 'Lyrics' },
  { value: 'announcement', label: 'Announcement' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'section', label: 'Section' },
];

// ── Lyrics stanza editing ──
function addStanza() {
  if (!draft.value) return;
  draft.value.stanzas = [...(draft.value.stanzas ?? []), { id: shortId('stz'), label: '', lines: '' }];
}
function removeStanza(id: string) {
  if (!draft.value?.stanzas) return;
  draft.value.stanzas = draft.value.stanzas.filter((s) => s.id !== id);
}

async function onUpload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || !draft.value) return;
  uploading.value = true;
  try {
    const { path } = await api.uploadMedia('backgrounds', file);
    draft.value.background = {
      ...(draft.value.background ?? { kind: 'image', overlayOpacity: 0.35, fit: 'cover' }),
      kind: file.type.startsWith('video') ? 'video' : 'image',
      src: path,
    };
    backgrounds.value = await api.listMedia('backgrounds');
  } catch (err) {
    toast.error(`Upload failed: ${(err as Error).message}`);
  } finally {
    uploading.value = false;
  }
}

function pickBackground(path: string) {
  if (!draft.value) return;
  const isVideo = /\.(mp4|webm|mov)$/i.test(path);
  draft.value.background = {
    ...(draft.value.background ?? { overlayOpacity: 0.35, fit: 'cover' }),
    kind: isVideo ? 'video' : 'image',
    src: path,
  };
}

function pickColor(color: string) {
  if (!draft.value) return;
  draft.value.background = { kind: 'color', color, overlayOpacity: 0 };
}

function setFit(fit: 'cover' | 'contain' | 'fill') {
  if (!draft.value || !draft.value.background) return;
  draft.value.background = { ...draft.value.background, fit };
}

async function autofillDurationFromVideo() {
  if (!draft.value) return;
  const src = draft.value.background?.src;
  const url = mediaUrl(src);
  if (!url) {
    toast.error('Pick a video background first.');
    return;
  }
  const ms = await probeVideoDurationMs(url);
  if (ms == null || ms <= 0) {
    toast.error('Could not read the video duration.');
    return;
  }
  draft.value.durationMs = ms;
  toast.success(`Set duration to ${(ms / 1000).toFixed(1)}s`);
}

function save() {
  if (draft.value) emit('save', draft.value);
  emit('update:open', false);
}

const COLORS = ['#0a0a0c', '#1e3a8a', '#7c2d12', '#064e3b', '#581c87', '#831843'];
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Edit slide</DialogTitle>
      </DialogHeader>
      <template v-if="draft">
      <!-- type -->
      <div class="grid gap-1.5">
        <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Type</label>
        <div class="flex gap-1.5 flex-wrap">
          <button
            v-for="t in TYPES"
            :key="t.value"
            class="px-3 h-8 rounded-lg text-xs font-medium border transition-colors"
            :class="
              draft.type === t.value
                ? 'bg-accent/15 text-accent border-accent/40'
                : 'bg-white/[0.04] text-white/65 border-hair hover:bg-white/[0.08]'
            "
            @click="draft.type = t.value"
          >
            {{ t.label }}
          </button>
        </div>
      </div>

      <!-- title -->
      <div class="grid gap-1.5">
        <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">
          {{
            draft.type === 'prayer' || draft.type === 'prayer-sub'
              ? 'Prayer point'
              : draft.type === 'lyrics'
                ? 'Song title'
                : draft.type === 'announcement'
                  ? 'Headline'
                  : 'Title'
          }}
        </label>
        <input
          v-model="draft.title"
          class="w-full rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white"
        />
      </div>

      <!-- subtitle (announcement) -->
      <div v-if="draft.type === 'announcement'" class="grid gap-1.5">
        <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Subtitle</label>
        <input
          v-model="draft.subtitle"
          class="w-full rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white"
        />
      </div>

      <!-- lyrics stanza editor -->
      <div v-if="draft.type === 'lyrics'" class="grid gap-2">
        <div class="flex items-center justify-between">
          <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Stanzas</label>
          <button class="flex items-center gap-1 text-xs text-accent hover:text-white transition-colors" @click="addStanza">
            <Plus :size="11" /> Add stanza
          </button>
        </div>
        <div v-for="st in draft.stanzas ?? []" :key="st.id" class="panel-soft p-2.5 grid gap-1.5">
          <div class="flex items-center gap-2">
            <input
              v-model="st.label"
              placeholder="Verse 1 / Chorus (optional)"
              class="flex-1 rounded-lg bg-white/[0.05] border border-hair focus:border-accent/60 outline-none px-2.5 py-1.5 text-xs text-white"
            />
            <button class="h-7 w-7 rounded-lg flex items-center justify-center text-white/45 hover:text-red-300 hover:bg-red-500/15 transition-colors" @click="removeStanza(st.id)">
              <Trash2 :size="13" />
            </button>
          </div>
          <textarea
            v-model="st.lines"
            rows="3"
            placeholder="One line per row…"
            class="w-full rounded-lg bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-2.5 py-1.5 text-sm text-white resize-none"
          />
        </div>
        <p v-if="!(draft.stanzas?.length)" class="text-xs text-white/35">No stanzas yet — add one to start.</p>
      </div>

      <!-- body (everything except lyrics) -->
      <div v-else class="grid gap-1.5">
        <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">
          {{
            draft.type === 'prayer' || draft.type === 'prayer-sub'
              ? 'Supporting scripture'
              : draft.type === 'scripture'
                ? 'Passage'
                : 'Body'
          }}
        </label>
        <textarea
          v-model="draft.body"
          rows="3"
          class="w-full rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white resize-none"
        />
      </div>

      <!-- reference + duration -->
      <div class="grid grid-cols-2 gap-3">
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Reference</label>
          <input
            v-model="draft.reference"
            class="w-full rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white"
          />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em] flex items-center justify-between">
            <span>Duration (s)</span>
            <button
              v-if="draft.type === 'video' && draft.background?.kind === 'video'"
              class="flex items-center gap-1 text-accent hover:text-white transition-colors normal-case tracking-normal"
              title="Read natural duration from the video"
              @click="autofillDurationFromVideo"
            >
              <Wand2 :size="11" />
              Auto
            </button>
          </label>
          <input
            type="number"
            min="0"
            :value="Math.round(draft.durationMs / 1000)"
            class="w-full rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white tnum"
            @input="draft.durationMs = Number(($event.target as HTMLInputElement).value) * 1000"
          />
        </div>
      </div>

      <!-- background -->
      <div class="grid gap-1.5">
        <div class="flex items-center justify-between">
          <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Background</label>
          <label class="cursor-pointer text-xs text-accent hover:text-white flex items-center gap-1">
            <Upload :size="11" />
            {{ uploading ? 'Uploading…' : 'Upload' }}
            <input
              type="file"
              class="hidden"
              accept="image/*,video/*"
              @change="onUpload"
            />
          </label>
        </div>
        <div class="grid grid-cols-6 gap-1.5">
          <button
            v-for="c in COLORS"
            :key="c"
            class="h-12 rounded-lg border border-hair hover:border-hairglow transition-all"
            :style="{ background: c }"
            :class="{ 'ring-2 ring-accent': draft.background?.kind === 'color' && draft.background.color === c }"
            @click="pickColor(c)"
          />
          <button
            v-for="b in backgrounds"
            :key="b.path"
            class="h-12 rounded-lg overflow-hidden border border-hair hover:border-hairglow transition-all"
            :class="{ 'ring-2 ring-accent': draft.background?.src === b.path }"
            @click="pickBackground(b.path)"
          >
            <img :src="mediaUrl(b.path)" class="h-full w-full object-cover" />
          </button>
        </div>
      </div>

      <!-- fit mode -->
      <div v-if="draft.background && draft.background.kind !== 'color'" class="grid gap-1.5">
        <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Fit</label>
        <div class="flex gap-1.5">
          <button
            v-for="f in FIT_MODES"
            :key="f.value"
            class="px-3 h-8 rounded-lg text-xs font-medium border transition-colors"
            :class="
              (draft.background.fit ?? 'cover') === f.value
                ? 'bg-accent/15 text-accent border-accent/40'
                : 'bg-white/[0.04] text-white/65 border-hair hover:bg-white/[0.08]'
            "
            @click="setFit(f.value)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>

      <!-- overlay opacity -->
      <div v-if="draft.background && draft.background.kind !== 'color'" class="grid gap-2">
        <div class="flex items-center justify-between">
          <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Overlay</label>
          <span class="text-xs text-white/55 tnum">
            {{ Math.round((draft.background.overlayOpacity ?? 0) * 100) }}%
          </span>
        </div>
        <Slider
          :model-value="[draft.background.overlayOpacity ?? 0.35]"
          :min="0"
          :max="1"
          :step="0.01"
          @update:model-value="
            (v) => v && (draft!.background!.overlayOpacity = v[0])
          "
        />
      </div>
      </template>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button variant="accent" @click="save">Save</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
