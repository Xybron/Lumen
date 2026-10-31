<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Upload, Wand2, Plus, Trash2, Film, Headphones, VolumeX } from 'lucide-vue-next';
import BackgroundLayer from '@/components/live/BackgroundLayer.vue';
import type { Item, ItemType } from '@/types';
import { api, mediaUrl, type MediaLibraryFile } from '@/lib/api';
import { MAX_MEDIA_BYTES, mediaExtensions } from '@/lib/studio/media-library';
import { probeVideoDurationMs } from '@/lib/media-duration';
import { shortId } from '@/lib/ids';
import { toast } from 'vue-sonner';

const FIT_MODES: { value: 'cover' | 'contain' | 'fill'; label: string }[] = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'fill', label: 'Fill' },
];

const props = defineProps<{ open: boolean; item: Item | null }>();
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'save', item: Item): void;
}>();

const draft = ref<Item | null>(null);
const backgrounds = ref<MediaLibraryFile[]>([]);
const uploading = ref(false);
const listening = ref(false);
const readingDuration = ref(false);
let durationProbe = 0;
const isMediaSlide = computed(() => draft.value?.type === 'image' || draft.value?.type === 'video');
const hasText = computed(() => !!draft.value && !['image', 'video', 'section'].includes(draft.value.type));
const mediaChoices = computed(() => backgrounds.value.filter(file => draft.value?.type === 'video'
  ? mediaExtensions.video.test(file.name)
  : draft.value?.type === 'image' ? mediaExtensions.image.test(file.name)
    : mediaExtensions.image.test(file.name) || mediaExtensions.video.test(file.name)));
const fileAccept = computed(() => draft.value?.type === 'video' ? '.mp4,.webm,.mov,.m4v'
  : draft.value?.type === 'image' ? '.png,.jpg,.jpeg,.webp,.gif'
    : '.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov,.m4v');

watch(
  () => [props.open, props.item],
  async ([open, item]) => {
    if (open && item) {
      draft.value = JSON.parse(JSON.stringify(item)) as Item;
      listening.value = false;
      durationProbe++;
      readingDuration.value = false;
      try {
        backgrounds.value = await api.listMedia('backgrounds');
      } catch {
        backgrounds.value = [];
      }
    }
  },
  { immediate: true },
);

function changeType(type: ItemType) {
  if (!draft.value) return;
  draft.value.type = type;
  listening.value = false;
  durationProbe++;
  readingDuration.value = false;
  if ((type === 'video' || type === 'image') && draft.value.background?.kind !== type) draft.value.background = undefined;
}

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
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !draft.value) return;
  const kind = mediaExtensions.video.test(file.name) ? 'video' : mediaExtensions.image.test(file.name) ? 'image' : null;
  if (!kind || (isMediaSlide.value && kind !== draft.value.type)) {
    toast.error(draft.value.type === 'video' ? 'Choose a video for this slide.'
      : draft.value.type === 'image' ? 'Choose an image for this slide.' : 'Choose an image or video for this background.');
    return;
  }
  if (!file.size || file.size > MAX_MEDIA_BYTES) {
    toast.error(file.size ? 'This file is larger than 512 MB. Choose a smaller file.' : 'This file is empty. Choose another file.');
    return;
  }
  uploading.value = true;
  try {
    const { path } = await api.uploadMedia('backgrounds', file);
    setBackground(path, kind);
    backgrounds.value = await api.listMedia('backgrounds');
  } catch (err) {
    toast.error((err as Error).message || 'This file could not be uploaded. Try again.');
  } finally {
    uploading.value = false;
  }
}

function setBackground(path: string, kind: 'image' | 'video') {
  if (!draft.value) return;
  const previous = draft.value.background;
  draft.value.background = {
    kind,
    src: path,
    fit: previous?.fit ?? 'cover',
    overlayOpacity: isMediaSlide.value ? 0 : (previous?.overlayOpacity ?? 0.35),
    ...(kind === 'video' ? {
      loop: previous?.kind === 'video' ? (previous.loop ?? true) : false,
      muted: previous?.kind === 'video' ? (previous.muted ?? false) : false,
      volume: previous?.kind === 'video' ? (previous.volume ?? 1) : 1,
    } : {}),
  };
  listening.value = false;
  if (draft.value.type === 'video') void setNaturalDuration(path);
}

function pickBackground(path: string) {
  setBackground(path, mediaExtensions.video.test(path) ? 'video' : 'image');
}

function pickColor(color: string) {
  if (!draft.value) return;
  draft.value.background = { kind: 'color', color, overlayOpacity: 0 };
  listening.value = false;
  durationProbe++;
  readingDuration.value = false;
}

function setFit(fit: 'cover' | 'contain' | 'fill') {
  if (!draft.value || !draft.value.background) return;
  draft.value.background = { ...draft.value.background, fit };
}

function updateTypography(patch: Partial<NonNullable<Item['typography']>>) {
  if (draft.value) draft.value.typography = { ...draft.value.typography, ...patch };
}

function toggleVideoMute() {
  if (draft.value?.background?.kind !== 'video') return;
  draft.value.background.muted = !draft.value.background.muted;
  if (draft.value.background.muted) listening.value = false;
}

async function autofillDurationFromVideo() {
  if (!draft.value) return;
  const src = draft.value.background?.src;
  const url = mediaUrl(src);
  if (!url) {
    toast.error('Pick a video background first.');
    return;
  }
  const ms = await setNaturalDuration(src!);
  if (ms == null || ms <= 0) {
    toast.error('Could not read the video duration.');
    return;
  }
  toast.success(`Set duration to ${(ms / 1000).toFixed(1)}s`);
}

async function setNaturalDuration(path: string): Promise<number | null> {
  const sequence = ++durationProbe;
  readingDuration.value = true;
  try {
    const ms = await probeVideoDurationMs(mediaUrl(path)!);
    if (sequence !== durationProbe || draft.value?.type !== 'video' || draft.value.background?.src !== path) return null;
    if (ms) draft.value.durationMs = ms;
    return ms;
  } finally {
    if (sequence === durationProbe) readingDuration.value = false;
  }
}

function save() {
  if (uploading.value || readingDuration.value) return;
  if ((draft.value?.type === 'image' || draft.value?.type === 'video') &&
      (draft.value.background?.kind !== draft.value.type || !draft.value.background.src)) {
    toast.error(`Choose ${draft.value.type === 'video' ? 'a video' : 'an image'} before saving this slide.`);
    return;
  }
  if (draft.value) emit('save', draft.value);
  emit('update:open', false);
}

const COLORS = ['#0a0a0c', '#1e3a8a', '#7c2d12', '#064e3b', '#581c87', '#831843'];
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
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
            @click="changeType(t.value)"
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

      <!-- Content fields follow the selected slide type. -->
      <div v-if="hasText && draft.type !== 'lyrics'" class="grid gap-1.5">
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

      <div v-if="['scripture', 'prayer', 'prayer-sub', 'text'].includes(draft.type)" class="grid gap-1.5">
        <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Reference</label>
        <input v-model="draft.reference" class="w-full rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white" />
      </div>

      <div v-if="draft.type !== 'section'" class="grid gap-1.5">
        <div class="text-xs font-medium text-white/55 uppercase tracking-[0.1em] flex items-center justify-between">
          <span>{{ draft.type === 'video' ? 'Time on slide (seconds)' : 'Duration (seconds)' }}</span>
          <button v-if="draft.type === 'video' && draft.background?.kind === 'video'" type="button" class="flex items-center gap-1 text-accent hover:text-white transition-colors normal-case tracking-normal" title="Use the video’s full length" @click="autofillDurationFromVideo"><Wand2 :size="11" />Use video length</button>
        </div>
        <input type="number" min="0" step="1" aria-label="Duration in seconds" :value="Math.round(draft.durationMs / 1000)" class="w-full rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white tnum" @input="draft.durationMs = Math.max(0, Number(($event.target as HTMLInputElement).value) * 1000)" />
        <p v-if="draft.type === 'video'" class="text-[11px] text-white/45">{{ readingDuration ? 'Reading video length…' : 'Auto mode moves to the next slide after this time. Manual mode waits for you.' }}</p>
      </div>

      <div v-if="hasText" class="grid gap-2">
        <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">Text appearance</label>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="size in (['sm', 'md', 'lg', 'xl', '2xl'] as const)" :key="size" class="px-3 h-8 rounded-lg text-xs border" :class="(draft.typography?.size ?? 'lg') === size ? 'bg-accent/15 text-accent border-accent/40' : 'bg-white/[0.04] text-white/65 border-hair'" @click="updateTypography({ size })">{{ size.toUpperCase() }}</button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-xs text-white/55" for="slide-text-align">Align</label>
          <select id="slide-text-align" :value="draft.typography?.align ?? 'center'" class="rounded-lg bg-[#202124] border border-hair px-2 py-1.5 text-xs text-white" @change="updateTypography({ align: ($event.target as HTMLSelectElement).value as 'left' | 'center' | 'right' })"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
          <label class="text-xs text-white/55 ml-2" for="slide-text-weight">Weight</label>
          <select id="slide-text-weight" :value="draft.typography?.weight ?? 500" class="rounded-lg bg-[#202124] border border-hair px-2 py-1.5 text-xs text-white" @change="updateTypography({ weight: Number(($event.target as HTMLSelectElement).value) })"><option :value="400">Regular</option><option :value="500">Medium</option><option :value="600">Semibold</option><option :value="700">Bold</option></select>
        </div>
      </div>

      <!-- Media slides choose matching files; text slides may choose a color or backdrop. -->
      <div v-if="draft.type !== 'section'" class="grid gap-1.5">
        <div class="flex items-center justify-between">
          <label class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">{{ draft.type === 'video' ? 'Video file' : draft.type === 'image' ? 'Image file' : 'Background' }}</label>
          <label class="cursor-pointer text-xs text-accent hover:text-white flex items-center gap-1">
            <Upload :size="11" />
            {{ uploading ? 'Uploading…' : 'Upload' }}
            <input type="file" class="hidden" :accept="fileAccept" :disabled="uploading" @change="onUpload" />
          </label>
        </div>
        <div class="grid grid-cols-6 gap-1.5 max-h-40 overflow-y-auto pr-1">
          <button
            v-if="!isMediaSlide"
            v-for="c in COLORS"
            :key="c"
            type="button"
            :aria-label="`Use ${c} background`"
            class="h-12 rounded-lg border border-hair hover:border-hairglow transition-all"
            :style="{ background: c }"
            :class="{ 'ring-2 ring-accent': draft.background?.kind === 'color' && draft.background.color === c }"
            @click="pickColor(c)"
          />
          <button
            v-for="b in mediaChoices"
            :key="b.path"
            type="button"
            :aria-label="`Use ${b.name}`"
            :title="b.name"
            class="h-12 rounded-lg overflow-hidden border border-hair hover:border-hairglow transition-all"
            :class="{ 'ring-2 ring-accent': draft.background?.src === b.path }"
            @click="pickBackground(b.path)"
          >
            <img v-if="b.thumbnail || mediaExtensions.image.test(b.name)" :src="mediaUrl(b.thumbnail || b.path)" class="h-full w-full object-cover" />
            <span v-else class="h-full w-full flex items-center justify-center text-white/45"><Film :size="18" /></span>
          </button>
        </div>
        <p v-if="isMediaSlide && !draft.background?.src" class="text-[11px] text-amber-300/80">Choose or upload {{ draft.type === 'video' ? 'a video' : 'an image' }} to finish this slide.</p>
      </div>

      <!-- fit mode -->
      <div v-if="draft.background && ['image', 'video'].includes(draft.background.kind)" class="grid gap-1.5">
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

      <div v-if="draft.background?.kind === 'video'" class="grid gap-2 rounded-xl border border-hair bg-white/[0.025] p-3">
        <div class="relative aspect-video overflow-hidden rounded-lg bg-black">
          <BackgroundLayer :background="draft.background" :listen="listening && !draft.background.muted" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="px-3 h-8 rounded-lg text-xs border" :class="(draft.background.loop ?? true) ? 'bg-accent/15 text-accent border-accent/40' : 'bg-white/[0.04] text-white/65 border-hair'" :aria-pressed="draft.background.loop ?? true" @click="draft.background.loop = !(draft.background.loop ?? true)">Loop video: {{ (draft.background.loop ?? true) ? 'On' : 'Off' }}</button>
          <button type="button" class="px-3 h-8 rounded-lg text-xs border flex items-center gap-1.5" :class="draft.background.muted ? 'bg-amber-400/10 text-amber-200 border-amber-300/30' : 'bg-white/[0.04] text-white/70 border-hair'" :aria-pressed="draft.background.muted ?? false" @click="toggleVideoMute"><VolumeX :size="13" />{{ draft.background.muted ? 'Slide muted' : 'Mute slide' }}</button>
          <button type="button" class="px-3 h-8 rounded-lg text-xs border border-hair flex items-center gap-1.5 disabled:opacity-45" :disabled="draft.background.muted" :aria-pressed="listening" @click="listening = !listening"><Headphones :size="13" />{{ listening ? 'Listening' : 'Listen here' }}</button>
        </div>
        <label class="flex items-center justify-between text-xs text-white/65" for="slide-video-volume"><span>Video volume</span><span class="tnum">{{ Math.round((draft.background.volume ?? 1) * 100) }}%</span></label>
        <input id="slide-video-volume" type="range" min="0" max="1" step="0.01" :value="draft.background.volume ?? 1" class="w-full accent-sky-300" @input="draft.background.volume = Number(($event.target as HTMLInputElement).value)" />
        <p class="text-[11px] text-white/45">Slide mute and volume affect Studio audio. To send sound, unmute this presentation channel in Studio’s Audio mixer. Listen here uses this computer’s speakers; headphones help avoid feedback.</p>
      </div>

      <!-- Text over a backdrop can be dimmed for readability. -->
      <div v-if="hasText && draft.background && ['image', 'video'].includes(draft.background.kind)" class="grid gap-2">
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

      <DialogFooter class="sticky bottom-0 z-10 -mx-4 sm:-mx-6 -mb-4 sm:-mb-6 px-4 sm:px-6 py-3 bg-[#17181b]/95 backdrop-blur-lg border-t border-hair">
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button variant="accent" :disabled="uploading || readingDuration" @click="save">{{ uploading ? 'Uploading…' : readingDuration ? 'Reading video…' : 'Save' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
