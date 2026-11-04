<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, LockKeyhole, Monitor, Music2, Plus, Trash2 } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ContentLayer from '@/components/live/ContentLayer.vue';
import { worshipRequest } from '@/lib/worship/api';
import { newSongSectionId, splitSongLyrics, type SongSplitMode } from '@/lib/worship/song-paste';
import type { Item } from '@/types';
import type { Song, SongSection } from '../../../../shared/worship';

const props = defineProps<{ song: Song | null; initialSections?: SongSection[] }>();
const open = defineModel<boolean>('open');
const emit = defineEmits<{ saved: [song: Song] }>();
const title = ref(''), author = ref(''), copyright = ref('');
const lyrics = ref(''), splitMode = ref<SongSplitMode>('blank');
const sections = ref<SongSection[]>([]), index = ref(0);
const lastSplit = new Map<SongSplitMode, SongSection[]>();
const showSectionLabels = ref(false), busy = ref(false), error = ref('');
const names = ref(new Map<string, { heading: string; name: string }>());
const structured = computed(() => !!props.song || !!props.initialSections?.length);
const active = computed(() => sections.value[index.value]);
const attribution = computed(() => [author.value.trim(), copyright.value.trim()].filter(Boolean).join(' · '));

function sectionName(section: SongSection) {
  const edit = names.value.get(section.id);
  return edit && edit.heading === section.label ? edit.name : section.label;
}
const selectedName = computed({
  get: () => active.value ? sectionName(active.value) : '',
  set: name => {
    if (active.value) names.value.set(active.value.id, { heading: active.value.label, name });
  },
});
const previewItem = computed<Item | undefined>(() => {
  const section = active.value;
  if (!section?.text.trim()) return;
  return { id: `cue_${section.id}`, type: 'lyrics', durationMs: 0, body: section.text.trim(),
    reference: showSectionLabels.value ? sectionName(section).trim() : '', subtitle: attribution.value };
});

watch(open, visible => {
  if (!visible) return;
  const song = props.song;
  title.value = song?.title ?? '';
  author.value = song?.author ?? '';
  copyright.value = song?.copyright ?? '';
  lyrics.value = '';
  splitMode.value = 'blank';
  names.value.clear();
  lastSplit.clear();
  sections.value = (song?.sections ?? props.initialSections ?? []).map(section => ({ ...section }));
  showSectionLabels.value = song ? song.showSectionLabels !== false : structured.value;
  index.value = 0;
  error.value = '';
}, { immediate: true });

watch([lyrics, splitMode], ([text, mode]) => {
  if (!open.value || structured.value) return;
  const previousId = active.value?.id;
  // Switching back to a split restores the names attached to its sections.
  const parsed = splitSongLyrics(text, mode, lastSplit.get(mode) ?? sections.value);
  lastSplit.set(mode, parsed);
  const retainedIndex = parsed.findIndex(section => section.id === previousId);
  sections.value = parsed;
  index.value = retainedIndex >= 0 ? retainedIndex : Math.max(0, Math.min(index.value, parsed.length - 1));
});

function addSection() {
  sections.value.push({ id: newSongSectionId(), label: '', text: '' });
  index.value = sections.value.length - 1;
}
function moveSection(i: number, direction: number) {
  const destination = i + direction;
  if (destination < 0 || destination >= sections.value.length) return;
  const [section] = sections.value.splice(i, 1);
  sections.value.splice(destination, 0, section);
  index.value = destination;
}
function removeSection(i: number) {
  sections.value.splice(i, 1);
  index.value = Math.max(0, Math.min(i, sections.value.length - 1));
}

const limitMessage = computed(() => {
  if (sections.value.length > 100) return 'A song can have up to 100 sections. Combine sections or choose Blank line.';
  const longSection = sections.value.findIndex(section => section.text.trim().length > 4000);
  if (longSection >= 0) return `Section ${longSection + 1} is too long. Split it into sections of up to 4,000 characters.`;
  const longName = sections.value.findIndex(section => sectionName(section).trim().length > 80);
  if (longName >= 0) return `Shorten the name of section ${longName + 1} to 80 characters or fewer.`;
  return '';
});
const canSave = computed(() => !busy.value && !!title.value.trim() && sections.value.length > 0 &&
  sections.value.every(section => section.text.trim()) && !limitMessage.value);

async function save() {
  if (!canSave.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await worshipRequest<Song>('/songs', {
      method: 'POST',
      body: JSON.stringify({
        ...(props.song ? { id: props.song.id, revision: props.song.revision } : {}),
        title: title.value.trim(), author: author.value.trim(), copyright: copyright.value.trim(),
        showSectionLabels: showSectionLabels.value,
        sections: sections.value.map(section => ({ ...section, label: sectionName(section).trim(), text: section.text.trim() })),
      }),
    });
    emit('saved', result);
    open.value = false;
  } catch (cause) {
    error.value = cause instanceof TypeError ? 'Could not reach the station. Your draft is still here. Try again.' :
      cause instanceof Error ? cause.message : 'Could not save this song. Try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="value => { if (!busy) open = value }">
    <DialogContent class="w-dialog song-dialog sm:max-w-4xl" :show-close-button="!busy">
      <DialogHeader>
        <div class="song-heading">
          <span class="song-glyph"><Music2 :size="20" aria-hidden="true" /></span>
          <div><span class="song-eyebrow">Lyrics / Song library</span><DialogTitle>{{ song ? 'Edit song' : 'Add a song' }}</DialogTitle></div>
        </div>
        <DialogDescription class="sr-only">Review each section in the projection preview before saving your song.</DialogDescription>
      </DialogHeader>

      <div class="w-song-form">
        <div class="song-grid">
          <div class="song-entry">
            <label>Song title<input v-model="title" required maxlength="160" placeholder="Song title" :disabled="busy" /></label>
            <template v-if="!structured">
              <label>Lyrics<textarea v-model="lyrics" rows="10" placeholder="Paste the whole song here…" :disabled="busy" /></label>
              <label class="song-split">New section at
                <select v-model="splitMode" aria-label="New section at" :disabled="busy"><option value="blank">Blank line</option><option value="line">Every line</option></select>
              </label>
            </template>
            <template v-else>
              <div v-for="(section, i) in sections" :key="section.id" class="w-song-section" @focusin="index = i">
                <div>
                  <input v-model="section.label" maxlength="80" :aria-label="`Section ${i + 1} label`" placeholder="Section name (optional)" :disabled="busy" />
                  <button type="button" class="w-icon" :disabled="busy || i === 0" aria-label="Move section up" @click="moveSection(i, -1)"><ArrowUp :size="14" /></button>
                  <button type="button" class="w-icon" :disabled="busy || i === sections.length - 1" aria-label="Move section down" @click="moveSection(i, 1)"><ArrowDown :size="14" /></button>
                  <button type="button" class="w-icon" :disabled="busy || sections.length === 1" aria-label="Delete section" @click="removeSection(i)"><Trash2 :size="14" /></button>
                </div>
                <textarea v-model="section.text" required maxlength="4000" rows="3" :aria-label="`Section ${i + 1} lyrics`" placeholder="Lyrics for this section…" :disabled="busy" />
              </div>
              <button type="button" class="w-button add-section" :disabled="busy || sections.length >= 100" @click="addSection"><Plus :size="14" />Add section</button>
            </template>

            <details class="song-credits">
              <summary>Credits</summary>
              <label>Writer / artist<input v-model="author" maxlength="300" :disabled="busy" /></label>
              <label>Copyright / licence credit<input v-model="copyright" maxlength="1500" :disabled="busy" /></label>
            </details>
          </div>

          <section class="song-review" aria-label="Projection preview">
            <div class="song-headline"><span><Monitor :size="15" aria-hidden="true" />Projection preview</span><small>16:9</small></div>
            <div class="song-screen">
              <ContentLayer v-if="previewItem" :item="previewItem" />
              <span v-else class="song-empty">Your lyrics appear here</span>
            </div>
            <div class="song-navigation">
              <button type="button" class="w-icon" aria-label="Previous section" :disabled="index === 0" @click="index--"><ChevronLeft :size="16" /></button>
              <span aria-live="polite">{{ active ? `Section ${index + 1} of ${sections.length}` : '0 sections' }}</span>
              <button type="button" class="w-icon" aria-label="Next section" :disabled="index >= sections.length - 1" @click="index++"><ChevronRight :size="16" /></button>
            </div>
            <label v-if="!structured"><span>Section name <small aria-hidden="true">Optional</small></span>
              <input v-model="selectedName" aria-label="Section name" maxlength="80" placeholder="e.g. Chorus" :disabled="busy || !active" />
            </label>
            <label class="song-label-check"><input v-model="showSectionLabels" type="checkbox" :disabled="busy" />Show section names on screen</label>
          </section>
        </div>

        <p v-if="error || limitMessage" role="alert" class="w-error">{{ error || limitMessage }}</p>
        <footer class="song-footer">
          <span><LockKeyhole :size="13" aria-hidden="true" />Private preview</span>
          <button type="button" class="w-button primary" :disabled="!canSave" @click="save">{{ busy ? 'Saving…' : song ? 'Save song' : 'Add to library' }}</button>
        </footer>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.song-heading,.song-headline,.song-headline span,.song-footer,.song-footer>span,.song-navigation{display:flex;align-items:center;gap:8px}
.song-heading{gap:12px;padding-right:24px}
.song-glyph{width:36px;height:36px;display:grid;place-items:center;border-radius:8px;color:var(--accent);background:var(--bg-hover)}
.song-eyebrow{display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:550;color:var(--text-muted)}
.song-grid{display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.05fr);gap:22px;border-top:1px solid var(--border-hair);padding-top:18px}
.song-entry,.song-review{min-width:0;display:flex;flex-direction:column;gap:13px}
.song-entry textarea{resize:vertical;min-height:72px;line-height:1.55}
.song-entry textarea,.song-entry input,.song-review input,.song-entry select{font-size:13px}
.song-entry .song-split{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
.song-split select{width:auto;max-width:62%}
.song-credits{color:var(--text-muted);font-size:11px}
.song-credits summary{cursor:pointer}
.song-credits label{margin-top:10px}
.add-section{align-self:flex-start}
.song-review{align-self:start;position:sticky;top:0}
.song-headline{justify-content:space-between;font-size:12px;font-weight:550}
.song-headline small,.song-review label small,.song-navigation span,.song-footer>span{font-size:11px;color:var(--text-muted);font-weight:400}
.song-review label small{margin-left:4px}
.song-screen{position:relative;display:grid;place-items:center;aspect-ratio:16/9;background:#0a0a0c;border:1px solid var(--border-hair);border-radius:7px;overflow:hidden}
.song-empty{color:#a5abb2;font-size:12px}
.song-navigation{justify-content:center;gap:12px}
.song-navigation span{font-variant-numeric:tabular-nums}
.song-review .song-label-check{flex-direction:row;align-items:center;font-size:12px}
.song-label-check input{width:16px;height:16px;accent-color:var(--accent)}
.song-footer{border-top:1px solid var(--border-hair);padding-top:12px;justify-content:space-between}
@media(max-width:640px){
  .song-grid{grid-template-columns:minmax(0,1fr);gap:18px}
  .song-review{position:static;border-top:1px solid var(--border-hair);padding-top:14px}
  .song-entry textarea{max-height:26vh}
}
@media(pointer:coarse){
  .song-navigation .w-icon,.song-footer .w-button,.song-label-check{min-height:44px}
  .song-navigation .w-icon{min-width:44px}
}
</style>
