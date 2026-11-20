<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Upload, Wand2, Plus, Trash2, Film, Headphones, VolumeX, Images, Sparkles, FileText, Layers3, Monitor, Check, Type, Palette, Clock3, AlignLeft, AlignCenter, AlignRight, Folder } from 'lucide-vue-next';
import PreviewSurface from './PreviewSurface.vue';
import { useContentStore } from '@/stores/content';
import { groupOptions } from '@/lib/presentation-groups';
import { computePrayerLabels } from '@/lib/prayers';
import BackgroundLayer from '@/components/live/BackgroundLayer.vue';
import MediaImagePicker from '@/components/media/MediaImagePicker.vue';
import { mediaAssetReference } from '@/lib/media-library';
import { useIdentityStore } from '@/stores/identity';
import type { MediaLibraryAsset } from '../../../../shared/media-library';
import type { Item, ItemType } from '@/types';
import { api, mediaUrl, type MediaLibraryFile } from '@/lib/api';
import { MAX_MEDIA_BYTES, mediaExtensions, mediaFileLabel } from '@/lib/studio/media-library';
import { probeVideoDurationMs } from '@/lib/media-duration';
import { shortId } from '@/lib/ids';
import { toast } from 'vue-sonner';

const FIT_MODES: { value: 'cover' | 'contain' | 'fill'; label: string; description: string }[] = [
  { value: 'cover', label: 'Cover', description: 'Crop to the frame' },
  { value: 'contain', label: 'Contain', description: 'Show the whole image' },
  { value: 'fill', label: 'Fill', description: 'Stretch to the frame' },
];
const LAYOUTS: { value: NonNullable<Item['layout']>; label: string; description: string }[] = [
  { value: 'general', label: 'General', description: 'Title, text & reference' },
  { value: 'statement', label: 'One thought', description: 'A single bold message' },
  { value: 'quote', label: 'Quote', description: 'Words worth reflecting on' },
  { value: 'key-points', label: 'Key points', description: 'Clear, readable takeaways' },
];
const ALIGNMENTS = [{ value: 'left', label: 'Align left', icon: AlignLeft }, { value: 'center', label: 'Align center', icon: AlignCenter }, { value: 'right', label: 'Align right', icon: AlignRight }] as const;

const props = defineProps<{ open: boolean; item: Item | null; playlistId?: string }>();
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'save', item: Item): void;
}>();

const draft = ref<Item | null>(null);
const content = useContentStore();
const playlist = computed(() => content.playlists.find(p => p.id === props.playlistId));
const groups = computed(() => playlist.value ? groupOptions(playlist.value) : []);
const prayerLabel = computed(() => draft.value && playlist.value ? computePrayerLabels(playlist.value.items)[draft.value.id]?.display : undefined);
const contentType = computed(() => ['image','video'].includes(draft.value?.type ?? '') ? 'image' : draft.value?.type === 'prayer-sub' ? 'prayer' : draft.value?.type);
const types = computed(() => { const values: {value:ItemType;label:string}[] = [{value:'prayer',label:'Prayer'},{value:'image',label:'Media'},{value:'notes',label:'Notes'}]; if (draft.value && !['prayer','prayer-sub','image','video','notes'].includes(draft.value.type)) values.push({value:draft.value.type,label:'Existing '+draft.value.type}); return values; });
const identity = useIdentityStore();
const imagePickerOpen = ref(false);
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
const titleLabel = computed(() => ['prayer', 'prayer-sub'].includes(draft.value?.type ?? '') ? 'Prayer point' : draft.value?.type === 'lyrics' ? 'Song title' : draft.value?.type === 'announcement' ? 'Headline' : 'Title');
const bodyLabel = computed(() => ['prayer', 'prayer-sub'].includes(draft.value?.type ?? '') ? 'Supporting scripture' : draft.value?.type === 'scripture' ? 'Passage' : 'Body');
const selectedMediaName = computed(() => {
  const src = draft.value?.background?.src;
  if (!src) return '';
  const file = backgrounds.value.find(file => file.path === src);
  if (file) return mediaFileLabel(file);
  try { return decodeURIComponent(src.split('/').pop() || src).replace(/^\d{13}-/, ''); } catch { return src.split('/').pop() || src; }
});
const previewLayout = computed(() => isMediaSlide.value ? (draft.value?.background?.fit ?? 'cover') : LAYOUTS.find(layout => layout.value === draft.value?.layout)?.label ?? 'General');

watch(
  () => [props.open, props.item],
  async ([open, item]) => {
    imagePickerOpen.value = false;
    if (open && item) {
      draft.value = JSON.parse(JSON.stringify(item)) as Item;
      draft.value.layout ??= 'general';
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
  imagePickerOpen.value = false;
  if (!draft.value) return;
  draft.value.type = type;
  draft.value.document = undefined;
  listening.value = false;
  durationProbe++;
  readingDuration.value = false;
  if ((type === 'video' || type === 'image') && draft.value.background?.kind !== type) draft.value.background = undefined;
}

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
function chooseLibraryImage(asset: MediaLibraryAsset) {
  if (!props.open || !draft.value || asset.origin !== 'library' || asset.kind === 'audio' || (isMediaSlide.value && asset.kind !== draft.value.type)) return;
  setBackground(mediaAssetReference(asset, true), asset.kind);
  imagePickerOpen.value = false;
  void api.listMedia('backgrounds').then(files => { backgrounds.value = files; }).catch(() => {});
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

const COLORS = [{ color: '#0a0a0c', name: 'Midnight' }, { color: '#1e3a8a', name: 'Royal blue' }, { color: '#7c2d12', name: 'Terracotta' }, { color: '#064e3b', name: 'Forest' }, { color: '#581c87', name: 'Violet' }, { color: '#831843', name: 'Berry' }];
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="slide-editor-dialog">
      <DialogHeader class="slide-edit-header">
        <div class="editor-heading-icon"><Layers3 :size="20" /></div>
        <div>
          <DialogTitle class="editor-title">Edit slide</DialogTitle>
          <DialogDescription class="editor-description">Shape your content. See it as your audience will.</DialogDescription>
        </div>
      </DialogHeader>

      <div v-if="draft" class="slide-edit-body">
        <div class="slide-edit-fields" tabindex="0" role="region" aria-label="Slide settings">
          <section class="editor-section" aria-labelledby="slide-content-heading">
            <div class="section-heading"><FileText :size="15" /><h3 id="slide-content-heading">Content</h3><span class="section-hint">What’s on screen</span></div>
            <div class="type-switch" role="group" aria-label="Slide type">
              <button v-for="t in types" :key="t.value" type="button" :aria-pressed="contentType === t.value" @click="contentType !== t.value && changeType(t.value)">
                <Sparkles v-if="t.value === 'prayer'" :size="15" /><Images v-else-if="t.value === 'image'" :size="15" /><FileText v-else :size="15" />{{ t.label }}
              </button>
            </div>
            <div v-if="draft.document" class="document-source"><FileText :size="16" /><span><strong>{{ draft.document.type === 'pdf' ? 'PDF' : 'PowerPoint' }}</strong> · {{ draft.document.sourceName }}<small>Slide {{ draft.document.page }} of {{ draft.document.totalPages }}</small></span></div>
            <div v-if="isMediaSlide && !draft.document" class="editor-field media-kind-field">
              <span class="field-label">Media type</span>
              <div class="compact-segment" role="group" aria-label="Media type"><button v-for="kind in (['image', 'video'] as const)" :key="kind" type="button" :aria-pressed="draft.type === kind" @click="changeType(kind)"><Images v-if="kind === 'image'" :size="14" /><Film v-else :size="14" />{{ kind === 'image' ? 'Image' : 'Video' }}</button></div>
            </div>
            <label class="editor-field"><span class="field-label">{{ titleLabel }}</span><input v-model="draft.title" class="editor-input" :placeholder="titleLabel === 'Prayer point' ? 'What are we praying for?' : 'Give this slide a title'" /></label>
            <label v-if="draft.type === 'announcement'" class="editor-field"><span class="field-label">Subtitle</span><input v-model="draft.subtitle" class="editor-input" placeholder="Add a little more context" /></label>
            <div v-if="draft.type === 'lyrics'" class="editor-field">
              <div class="field-row"><span class="field-label">Stanzas</span><button type="button" class="editor-link" @click="addStanza"><Plus :size="13" />Add stanza</button></div>
              <div v-for="(st, i) in draft.stanzas ?? []" :key="st.id" class="stanza-card">
                <div class="field-row"><input v-model="st.label" :aria-label="`Stanza ${i + 1} label`" placeholder="Verse 1 / Chorus (optional)" class="editor-input" /><button type="button" class="icon-action" :aria-label="`Remove stanza ${i + 1}`" @click="removeStanza(st.id)"><Trash2 :size="15" /></button></div>
                <textarea v-model="st.lines" :aria-label="`Stanza ${i + 1} lines`" rows="3" placeholder="One line per row…" class="editor-input" />
              </div>
              <p v-if="!draft.stanzas?.length" class="field-help">Add a stanza to start building your song.</p>
            </div>
            <label v-if="hasText && draft.type !== 'lyrics'" class="editor-field"><span class="field-label">{{ bodyLabel }}<span class="field-optional">Optional</span></span><textarea v-model="draft.body" rows="3" class="editor-input" :placeholder="bodyLabel === 'Supporting scripture' ? 'Add the passage that supports this prayer…' : draft.layout === 'key-points' ? 'Write each point on a new line…' : 'Write the message for your audience…'" /></label>
            <label v-if="['scripture', 'prayer', 'prayer-sub', 'text', 'notes'].includes(draft.type)" class="editor-field"><span class="field-label">Reference<span class="field-optional">Optional</span></span><input v-model="draft.reference" class="editor-input" placeholder="e.g. John 4:14" /></label>
            <div class="content-details">
              <label class="editor-field"><span class="field-label"><Folder :size="13" />Place in group</span><select class="editor-input" :value="draft.groupId ?? ''" @change="draft.groupId = ($event.target as HTMLSelectElement).value || undefined"><option value="">Presentation</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.label }}</option></select></label>
              <div v-if="draft.type !== 'section'" class="editor-field editor-duration-field"><label class="field-label" for="slide-duration"><Clock3 :size="13" />Duration</label><div class="unit-input"><input id="slide-duration" type="number" min="0" step="1" aria-label="Duration in seconds" :value="Math.round(draft.durationMs / 1000)" @input="draft.durationMs = Math.max(0, Number(($event.target as HTMLInputElement).value) * 1000)" /><span>sec</span></div></div>
            </div>
            <div v-if="draft.type !== 'section'" class="timing-help"><p class="field-help">{{ readingDuration ? 'Reading video length…' : 'Duration applies in Auto. Manual advances when you’re ready.' }}</p><button v-if="draft.type === 'video' && draft.background?.kind === 'video'" type="button" class="editor-link" @click="autofillDurationFromVideo"><Wand2 :size="13" />Use video length</button></div>
          </section>

          <section v-if="hasText" class="editor-section" aria-labelledby="slide-layout-heading">
            <div class="section-heading"><Layers3 :size="15" /><h3 id="slide-layout-heading">Layout</h3><span class="section-hint">Start with a composition</span></div>
            <div class="layout-options" data-testid="slide-layout-options" role="group" aria-label="Slide layout">
              <button v-for="layout in LAYOUTS" :key="layout.value" type="button" class="visual-choice layout-choice" :aria-label="layout.label" :aria-pressed="draft.layout === layout.value" :title="layout.description" @click="draft.layout = layout.value">
                <span class="layout-mini" :class="`layout-mini--${layout.value}`" aria-hidden="true"><span class="mini-kicker" /><span class="mini-title" /><span class="mini-body"><i /><i /><i /></span><span class="mini-reference" /><span v-if="layout.value === 'quote'" class="mini-quote">“</span></span>
                <span class="choice-label">{{ layout.label }}<Check v-if="draft.layout === layout.value" :size="12" /></span>
              </button>
            </div>
            <p class="field-help">{{ LAYOUTS.find(layout => layout.value === draft!.layout)?.description }}. The preview updates as you edit.</p>
          </section>

          <section v-if="hasText" class="editor-section" aria-labelledby="slide-type-heading">
            <div class="section-heading"><Type :size="15" /><h3 id="slide-type-heading">Typography</h3></div>
            <div class="editor-field"><span class="field-label">Text size</span><div class="compact-segment size-options" role="group" aria-label="Text size"><button v-for="size in (['sm', 'md', 'lg', 'xl', '2xl'] as const)" :key="size" type="button" :aria-pressed="(draft.typography?.size ?? 'lg') === size" @click="updateTypography({ size })">{{ size.toUpperCase() }}</button></div></div>
            <div class="typography-details">
              <div class="editor-field"><span class="field-label">Alignment</span><div class="compact-segment" role="group" aria-label="Text alignment"><button v-for="align in ALIGNMENTS" :key="align.value" type="button" :aria-label="align.label" :title="align.label" :aria-pressed="(draft.typography?.align ?? 'center') === align.value" @click="updateTypography({ align: align.value })"><component :is="align.icon" :size="16" /></button></div></div>
              <label class="editor-field"><span class="field-label">Weight</span><select class="editor-input" :value="draft.typography?.weight ?? 500" @change="updateTypography({ weight: Number(($event.target as HTMLSelectElement).value) })"><option :value="400">Regular</option><option :value="500">Medium</option><option :value="600">Semibold</option><option :value="700">Bold</option></select></label>
            </div>
          </section>

          <section v-if="draft.type !== 'section'" class="editor-section" aria-labelledby="slide-background-heading">
            <div class="section-heading"><Images v-if="isMediaSlide" :size="15" /><Palette v-else :size="15" /><h3 id="slide-background-heading">{{ draft.type === 'video' ? 'Video' : draft.type === 'image' ? 'Image' : 'Background' }}</h3></div>
            <div v-if="!isMediaSlide" class="color-options" role="group" aria-label="Background color">
              <button v-for="c in COLORS" :key="c.color" type="button" :aria-label="`Use ${c.color} background`" :title="c.name" :aria-pressed="draft.background?.kind === 'color' && draft.background.color === c.color" :style="{ background: c.color }" @click="pickColor(c.color)"><Check v-if="draft.background?.kind === 'color' && draft.background.color === c.color" :size="15" /></button>
            </div>
            <div class="media-actions"><button v-if="identity.can('*', 'author')" type="button" class="editor-action" :disabled="uploading" @click="imagePickerOpen = true"><Images :size="15" />Choose from Media</button><label class="editor-action upload-action" :class="{ 'is-disabled': uploading }"><Upload :size="14" />{{ uploading ? 'Uploading…' : 'Upload' }}<input type="file" :accept="fileAccept" :disabled="uploading" aria-label="Upload slide media" @change="onUpload" /></label></div>
            <div v-if="draft.background?.src && ['image', 'video'].includes(draft.background.kind)" class="selected-asset"><Film v-if="draft.background.kind === 'video'" :size="15" /><Images v-else :size="15" /><span :title="selectedMediaName">{{ selectedMediaName }}</span><span class="asset-selected"><Check :size="12" />Selected</span></div>
            <div v-if="mediaChoices.length" class="media-grid" role="group" aria-label="Recent media">
              <button v-for="b in mediaChoices" :key="b.path" type="button" :aria-label="`Use ${mediaFileLabel(b)}`" :title="mediaFileLabel(b)" :aria-pressed="draft.background?.src === b.path" @click="pickBackground(b.path)"><img v-if="b.thumbnail || mediaExtensions.image.test(b.name)" :src="mediaUrl(b.thumbnail || b.path)" alt="" loading="lazy" /><Film v-else :size="20" /><span v-if="draft.background?.src === b.path" class="asset-check"><Check :size="11" /></span></button>
            </div>
            <p v-if="isMediaSlide && !draft.background?.src" class="field-help media-empty">Choose or upload {{ draft.type === 'video' ? 'a video' : 'an image' }} to finish this slide.</p>

            <div v-if="draft.background && ['image', 'video'].includes(draft.background.kind)" class="editor-field fit-field">
              <span class="field-label">Fit<span class="field-optional">How media fills the screen</span></span>
              <div class="fit-options" data-testid="slide-fit-options" role="group" aria-label="Media fit">
                <button v-for="f in FIT_MODES" :key="f.value" type="button" class="visual-choice fit-choice" :aria-label="f.label" :aria-pressed="(draft.background.fit ?? 'cover') === f.value" @click="setFit(f.value)">
                  <span class="fit-mini" :class="`fit-mini--${f.value}`" aria-hidden="true"><span class="fit-art"><svg viewBox="0 0 80 60" preserveAspectRatio="none"><rect width="80" height="60" rx="1" fill="currentColor" opacity=".12"/><circle cx="57" cy="17" r="7" fill="currentColor" opacity=".75"/><path d="M0 55 25 22 45 44 58 30 80 56V60H0Z" fill="currentColor" opacity=".7"/></svg></span></span>
                  <span class="choice-label">{{ f.label }}<Check v-if="(draft.background.fit ?? 'cover') === f.value" :size="12" /></span><span class="choice-description">{{ f.description }}</span>
                </button>
              </div>
            </div>
            <div v-if="hasText && draft.background && ['image', 'video'].includes(draft.background.kind)" class="editor-field overlay-field"><div class="field-row"><span class="field-label">Darken background</span><span class="field-help tnum">{{ Math.round((draft.background.overlayOpacity ?? 0) * 100) }}%</span></div><Slider aria-label="Darken background" :model-value="[draft.background.overlayOpacity ?? 0.35]" :min="0" :max="1" :step="0.01" @update:model-value="v => v && (draft!.background!.overlayOpacity = v[0])" /><p class="field-help">Keep text readable over busy images and video.</p></div>
          </section>

          <section v-if="draft.background?.kind === 'video'" class="editor-section" aria-labelledby="slide-video-heading">
            <div class="section-heading"><Film :size="15" /><h3 id="slide-video-heading">Video playback</h3></div>
            <div class="video-monitor"><BackgroundLayer :background="draft.background" :listen="listening && !draft.background.muted" /></div>
            <div class="video-actions"><button type="button" class="editor-action" :aria-pressed="draft.background.loop ?? true" @click="draft.background.loop = !(draft.background.loop ?? true)">Loop video: {{ (draft.background.loop ?? true) ? 'On' : 'Off' }}</button><button type="button" class="editor-action" :aria-pressed="draft.background.muted ?? false" @click="toggleVideoMute"><VolumeX :size="13" />{{ draft.background.muted ? 'Slide muted' : 'Mute slide' }}</button><button type="button" class="editor-action" :disabled="draft.background.muted" :aria-pressed="listening" @click="listening = !listening"><Headphones :size="13" />{{ listening ? 'Listening' : 'Listen here' }}</button></div>
            <div class="editor-field"><label class="field-row" for="slide-video-volume"><span class="field-label">Video volume</span><span class="field-help tnum">{{ Math.round((draft.background.volume ?? 1) * 100) }}%</span></label><input id="slide-video-volume" type="range" min="0" max="1" step="0.01" :value="draft.background.volume ?? 1" class="w-full accent-sky-300" @input="draft.background.volume = Number(($event.target as HTMLInputElement).value)" /></div>
            <p class="field-help">Mute and volume apply to Studio audio. Unmute the presentation channel in Studio to send sound. Listen here plays through this computer.</p>
          </section>
        </div>

        <aside class="slide-edit-preview" aria-label="Audience preview">
          <div class="preview-heading"><span><Monitor :size="15" />Audience preview</span><span class="preview-live"><i />Live update</span></div>
          <div class="preview-canvas"><PreviewSurface :item="draft" :prayer-label="prayerLabel" /></div>
          <div class="preview-meta"><span class="preview-slide-title">{{ draft.title || 'Untitled slide' }}</span><span class="preview-format">16:9<span>·</span>{{ previewLayout }}</span></div>
          <div class="preview-note"><Layers3 :size="15" /><p>Your audience sees this design.<br /><span>Save, then send to Program when you’re ready.</span></p></div>
        </aside>
      </div>

      <footer class="slide-edit-footer" data-slot="dialog-footer">
        <span class="footer-note"><span />Changes stay in this editor until saved</span>
        <div class="footer-actions"><Button variant="ghost" @click="emit('update:open', false)">Cancel</Button><Button class="editor-save" :disabled="uploading || readingDuration" @click="save">{{ uploading ? 'Uploading…' : readingDuration ? 'Reading video…' : 'Save' }}</Button></div>
      </footer>
    </DialogContent>
  </Dialog>
  <MediaImagePicker v-model:open="imagePickerOpen" :accepted-kinds="draft?.type === 'video' ? ['video'] : draft?.type === 'image' ? ['image'] : ['image', 'video']" :selected-path="draft?.background?.src" @select="chooseLibraryImage" />
</template>

<style scoped>
:global(.slide-editor-dialog) { width: 1180px; max-width: calc(100vw - 40px); height: min(860px, calc(100dvh - 48px)); max-height: calc(100dvh - 48px); padding: 0; gap: 0; overflow: hidden; border-radius: 16px; background: #18191c; box-shadow: 0 32px 100px #0008; transition-property: opacity, transform; }
.slide-edit-header { display: flex; flex-direction: row; align-items: center; flex: 0 0 auto; gap: 12px; padding: 21px 26px; border-bottom: 1px solid #ffffff0d; text-align: left; }
.editor-heading-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: #ffffff05; border: 1px solid #ffffff0c; color: #a7d6e5; }
.editor-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.025em; }
.editor-description { margin-top: 3px; font-size: 12px; color: #92969f; }
.slide-edit-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); flex: 1 1 0%; min-height: 0; overflow: hidden; }
.slide-edit-fields { min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #ffffff25 transparent; padding: 0 26px 28px; scroll-padding-block: 20px; outline: none; }
.slide-edit-fields:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.editor-section { display: grid; gap: 15px; padding: 24px 0; border-bottom: 1px solid #ffffff0b; }
.editor-section:last-child { border-bottom: 0; padding-bottom: 4px; }
.section-heading { display: flex; align-items: center; gap: 8px; color: #a7abb4; margin-bottom: 2px; }
.section-heading h3 { color: #eceef2; font-size: 13px; font-weight: 600; letter-spacing: -.01em; }
.section-hint { margin-left: auto; font-size: 11px; color: #858993; }
.editor-field { display: grid; gap: 7px; min-width: 0; }
.field-label { display: flex; align-items: center; gap: 6px; color: #b7bbc4; font-size: 12px; font-weight: 500; }
.field-optional { margin-left: auto; font-size: 10px; color: #777d88; font-weight: 400; }
.field-help { color: #8e949e; font-size: 11px; line-height: 1.6; margin: 0; }
.field-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.editor-input, .unit-input { width: 100%; min-width: 0; border-radius: 7px; border: 1px solid #ffffff13; background: #222428; color: #e8eaf0; font-size: 13px; line-height: 20px; outline: none; transition: border-color .15s, box-shadow .15s; }
.editor-input { padding: 9px 11px; }
.editor-input::placeholder { color: #727884; }
.editor-input:hover, .unit-input:hover { border-color: #ffffff26; }
.editor-input:focus, .unit-input:focus-within { border-color: #ddfb7380; box-shadow: 0 0 0 3px #ddfb730c; }
textarea.editor-input { resize: vertical; min-height: 96px; max-height: 240px; }
select.editor-input { cursor: pointer; color-scheme: dark; padding-right: 8px; }
.type-switch, .compact-segment { display: flex; align-items: stretch; padding: 3px; gap: 3px; border: 1px solid #ffffff0b; border-radius: 8px; background: #101113; min-width: 0; }
.type-switch { flex-wrap: wrap; }
.type-switch button, .compact-segment button { display: flex; flex: 1 1 0%; justify-content: center; align-items: center; gap: 7px; min-width: 0; padding: 7px 9px; border: 1px solid transparent; border-radius: 5px; color: #9197a1; font-size: 12px; font-weight: 500; transition: background .15s, color .15s; }
.type-switch button:hover, .compact-segment button:hover { color: #e3e9ef; background: #ffffff07; }
.type-switch button[aria-pressed="true"], .compact-segment button[aria-pressed="true"] { color: #b6e8fa; border-color: #ddfb7326; background: #26343d; box-shadow: 0 1px 3px #0004; }
.media-kind-field { grid-template-columns: 1fr 1fr; align-items: center; }
.media-kind-field .compact-segment button { padding: 5px 8px; }
.content-details { display: grid; grid-template-columns: minmax(0, 1fr) 118px; gap: 14px; }
.unit-input { display: flex; align-items: center; padding-right: 11px; }
.unit-input input { background: transparent; outline: none; width: 100%; min-width: 0; padding: 9px 0 9px 11px; font-variant-numeric: tabular-nums; }
.unit-input span { color: #818895; font-size: 11px; }
.timing-help { display: grid; gap: 7px; margin-top: -6px; }
.typography-details { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
.compact-segment button { min-height: 30px; }
.size-options button { font-size: 11px; letter-spacing: .025em; }
.layout-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.visual-choice { display: flex; flex-direction: column; gap: 8px; padding: 7px; background: #1e2024; border: 1px solid #ffffff13; border-radius: 8px; text-align: left; color: #929ca9; transition: border-color .15s, background .15s; min-width: 0; }
.visual-choice:hover { background: #25292e; border-color: #ffffff35; }
.visual-choice[aria-pressed="true"] { border-color: #ddfb739c; background: #ddfb7309; color: #a6e1fc; box-shadow: 0 0 0 1px #ddfb7316; }
.choice-label { display: flex; align-items: center; justify-content: space-between; gap: 3px; color: #c8cdd6; font-size: 11px; font-weight: 500; line-height: 16px; }
[aria-pressed="true"] > .choice-label { color: #b1e3f8; }
.choice-description { color: #858c97; font-size: 10px; line-height: 1.45; }
.layout-mini { position: relative; display: flex; flex-direction: column; justify-content: center; align-items: center; width: 100%; aspect-ratio: 16 / 10; padding: 10px; background: #101215; border: 1px solid #ffffff0b; border-radius: 4px; gap: 4px; overflow: hidden; }
.mini-kicker { width: 22%; height: 2px; background: currentColor; opacity: .7; }
.mini-title { width: 68%; height: 4px; background: currentColor; border-radius: 1px; }
.mini-body { display: grid; justify-items: center; gap: 2px; width: 100%; }
.mini-body i { display: block; width: 83%; height: 2px; background: currentColor; opacity: .4; border-radius: 1px; }
.mini-body i:last-child { width: 50%; }
.mini-reference { width: 22%; height: 2px; background: currentColor; opacity: .6; }
.layout-mini--statement .mini-kicker, .layout-mini--statement .mini-reference, .layout-mini--statement .mini-body i:last-child { display: none; }
.layout-mini--statement .mini-title { height: 2px; width: 35%; opacity: .4; margin-bottom: 2px; }
.layout-mini--statement .mini-body { gap: 3px; }
.layout-mini--statement .mini-body i { height: 6px; width: 90%; opacity: .85; }
.layout-mini--statement .mini-body i:nth-child(2) { width: 68%; }
.layout-mini--quote { padding-top: 18px; }
.layout-mini--quote .mini-kicker { display: none; }
.layout-mini--quote .mini-title { height: 2px; width: 35%; opacity: .5; }
.layout-mini--quote .mini-body i { height: 3px; opacity: .7; }
.mini-quote { position: absolute; top: 0; left: 8px; font-size: 28px; font-family: Georgia, serif; line-height: 1.4; opacity: .6; }
.layout-mini--key-points { align-items: start; gap: 5px; }
.layout-mini--key-points .mini-kicker, .layout-mini--key-points .mini-reference { display: none; }
.layout-mini--key-points .mini-title { width: 65%; }
.layout-mini--key-points .mini-body { justify-items: start; gap: 4px; padding-left: 6px; }
.layout-mini--key-points .mini-body i { position: relative; width: 85%; }
.layout-mini--key-points .mini-body i::before { content: ''; position: absolute; width: 2px; height: 2px; border-radius: 50%; background: currentColor; left: -6px; }
.color-options { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
.color-options button { display: grid; place-items: center; height: 32px; border-radius: 6px; border: 1px solid #ffffff20; color: white; transition: box-shadow .15s; }
.color-options button[aria-pressed="true"] { box-shadow: 0 0 0 2px #18191c, 0 0 0 3px #ddfb73; }
.media-actions, .video-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.editor-action { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid #ffffff18; border-radius: 7px; padding: 8px 11px; font-size: 11px; font-weight: 500; color: #c8cdd6; background: #ffffff03; cursor: pointer; transition: background .15s, border-color .15s; }
.editor-action:hover { background: #ffffff08; border-color: #ffffff30; }
.editor-action[aria-pressed="true"] { color: #9fdef8; border-color: #ddfb7355; background: #ddfb730b; }
.editor-action:disabled, .is-disabled { opacity: .45; cursor: default; }
.upload-action { color: #9edbf4; }
.upload-action input { position: absolute; inset: 0; opacity: 0; width: 100%; cursor: pointer; }
.upload-action:focus-within { outline: 2px solid #ddfb73; outline-offset: 3px; }
.selected-asset { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid #ffffff0b; border-radius: 6px; background: #121416; color: #8f99a7; min-width: 0; }
.selected-asset > span:first-of-type { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
.selected-asset > svg { flex: 0 0 auto; }
.asset-selected { display: flex; gap: 4px; align-items: center; color: #a8c9bc; font-size: 10px; }
.media-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); grid-auto-rows: max-content; align-content: start; gap: 7px; max-height: 159px; overflow-y: auto; padding: 2px 3px 2px 2px; scrollbar-width: thin; scrollbar-color: #ffffff25 transparent; }
.media-grid button { position: relative; display: grid; place-items: center; aspect-ratio: 16 / 10; border: 1px solid #ffffff12; border-radius: 6px; background: #101113; color: #87909e; overflow: hidden; }
.media-grid button img { width: 100%; height: 100%; object-fit: cover; }
.media-grid button:hover { border-color: #ffffff60; }
.media-grid button[aria-pressed="true"] { border-color: #ddfb73; box-shadow: 0 0 0 1px #ddfb73; }
.asset-check { display: grid; place-items: center; position: absolute; right: 3px; bottom: 3px; width: 16px; height: 16px; border-radius: 4px; background: #b7e7fa; color: #163345; }
.media-empty { padding: 12px; border: 1px dashed #ffffff20; border-radius: 7px; text-align: center; }
.fit-field { gap: 10px; margin-top: 2px; }
.fit-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.fit-choice { padding: 10px; gap: 5px; }
.fit-mini { display: flex; align-items: center; justify-content: center; position: relative; width: 100%; aspect-ratio: 16 / 9; background: #0d1014; border: 1px solid #ffffff18; border-radius: 3px; overflow: hidden; margin-bottom: 5px; }
.fit-art { display: block; flex: 0 0 auto; width: 100%; aspect-ratio: 4 / 3; }
.fit-art svg { width: 100%; height: 100%; }
.fit-mini--contain .fit-art { width: 75%; }
.fit-mini--fill .fit-art { height: 100%; aspect-ratio: auto; }
.overlay-field { padding-top: 5px; gap: 13px; }
.video-monitor { position: relative; aspect-ratio: 16 / 9; max-width: 260px; border-radius: 7px; overflow: hidden; background: black; }
.editor-link { display: flex; align-items: center; width: fit-content; gap: 5px; font-size: 11px; color: #9edbf4; }
.editor-link:hover { color: #d5f2ff; }
.icon-action { display: grid; place-items: center; flex: 0 0 auto; padding: 8px; border-radius: 6px; color: #a4aab4; }
.icon-action:hover { color: #fda4af; background: #fb718510; }
.stanza-card { display: grid; gap: 8px; }
.document-source { display: flex; gap: 9px; padding: 11px; border-radius: 7px; border: 1px solid #ddfb7322; background: #ddfb7305; color: #9aa8b6; font-size: 11px; overflow-wrap: anywhere; }
.document-source svg { flex-shrink: 0; color: #9edbf4; }
.document-source strong { color: #c8e3f0; font-weight: 500; }
.document-source small { display: block; font-size: 10px; margin-top: 4px; }
.slide-edit-preview { min-width: 0; padding: 25px 26px; border-left: 1px solid #ffffff0b; background: #121417; overflow-y: auto; scrollbar-width: thin; }
.preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 23px; color: #c6ccd6; font-size: 12px; font-weight: 500; }
.preview-heading > span { display: flex; align-items: center; gap: 7px; }
.preview-heading .preview-live { color: #8a949f; font-size: 10px; font-weight: 400; }
.preview-live i { width: 5px; height: 5px; border-radius: 50%; background: #9fbea9; box-shadow: 0 0 0 3px #9fbea90c; }
.preview-canvas { padding: 6px; background: #1c1f24; border: 1px solid #ffffff13; border-radius: 10px; box-shadow: 0 14px 40px #0003; }
.preview-canvas :deep(> div) { border-radius: 5px; border: 0; }
.preview-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 2px; color: #8a939f; font-size: 10px; }
.preview-slide-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 60px; color: #a4acb7; }
.preview-format { display: flex; align-items: center; gap: 8px; text-transform: capitalize; }
.preview-format > span { color: #464d59; }
.preview-note { display: flex; align-items: start; gap: 10px; margin-top: 16px; padding-top: 18px; border-top: 1px solid #ffffff09; color: #929ba8; font-size: 11px; line-height: 1.7; }
.preview-note svg { flex-shrink: 0; margin-top: 2px; color: #74818f; }
.preview-note p span { color: #747d8a; }
.slide-edit-footer { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; gap: 16px; padding: 16px 26px; border-top: 1px solid #ffffff0e; background: #1a1c20; }
.footer-note { display: flex; align-items: center; gap: 7px; color: #858e9b; font-size: 11px; }
.footer-note > span { width: 5px; height: 5px; background: #6e7785; border-radius: 50%; }
.footer-actions { display: flex; align-items: center; gap: 9px; margin-left: auto; }
.footer-actions :deep(button) { height: 35px; padding-inline: 17px; font-size: 12px; border-radius: 7px; }
.footer-actions :deep(.editor-save) { min-width: 84px; background: #b5e3f4; color: #182c36; border: 1px solid #c2e9f8; box-shadow: inset 0 1px #ffffff4d; }
.footer-actions :deep(.editor-save:hover) { background: #cfedfa; }
button:focus-visible { outline: 2px solid #ddfb73; outline-offset: 3px; }
@media (max-width: 1000px) and (min-width: 761px) {
  .slide-edit-body { grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr); }
  .slide-edit-fields, .slide-edit-preview { padding-inline: 18px; }
  .layout-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .layout-mini { aspect-ratio: 2 / 1; }
  .section-hint { display: none; }
  .fit-choice { padding: 7px; }
  .choice-description { font-size: 9px; }
}
@media (max-width: 760px) {
  :global(.slide-editor-dialog) { width: calc(100vw - 20px); max-width: calc(100vw - 20px); height: calc(100dvh - 24px); max-height: calc(100dvh - 24px); border-radius: 12px; }
  .slide-edit-header { padding: 17px 18px; gap: 10px; }
  .editor-description { font-size: 11px; max-width: 230px; line-height: 1.5; padding-right: 10px; }
  .editor-title { font-size: 16px; }
  .editor-heading-icon { width: 32px; height: 32px; flex-shrink: 0; }
  .slide-edit-body { display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain; scroll-padding-block: 16px; }
  .slide-edit-fields { flex: 0 0 auto; overflow: visible; padding: 0 18px 24px; }
  .slide-edit-preview { order: -1; flex: 0 0 auto; padding: 18px; border-left: 0; border-bottom: 1px solid #ffffff0c; overflow: visible; }
  .preview-heading { margin-bottom: 13px; }
  .preview-canvas { max-width: 480px; margin: 0 auto; }
  .preview-meta { padding-bottom: 0; }
  .preview-note { display: none; }
  .section-hint { font-size: 10px; }
  .editor-section { padding-block: 22px; }
  .layout-options { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  .layout-mini { aspect-ratio: 2.1 / 1; }
  .content-details { grid-template-columns: minmax(0, 1fr) 100px; gap: 11px; }
  .fit-options { gap: 7px; }
  .fit-choice { padding: 7px; }
  .choice-description { font-size: 9px; }
  .choice-label { font-size: 11px; }
  .field-optional { font-size: 9px; }
  .media-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .asset-selected { font-size: 0; }
  .slide-edit-footer { padding: 12px 18px; }
  .footer-note { display: none; }
  .footer-actions { width: 100%; justify-content: space-between; }
}
@media (prefers-reduced-motion: reduce) { button, .editor-input, .unit-input { transition: none; } }
</style>
