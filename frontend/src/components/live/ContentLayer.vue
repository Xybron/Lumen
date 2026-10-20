<script setup lang="ts">
import { computed } from 'vue';
import type { Item } from '@/types';
import CueCanvas from './CueCanvas.vue';

const props = defineProps<{ item?: Item; prayerLabel?: string }>();

const sizeClass = computed(() => {
  const s = props.item?.typography?.size ?? 'lg';
  return {
    sm: 'text-3xl md:text-4xl',
    md: 'text-4xl md:text-5xl',
    lg: 'text-5xl md:text-6xl',
    xl: 'text-6xl md:text-7xl',
    '2xl': 'text-7xl md:text-8xl',
  }[s];
});

// Prayer titles are usually full sentences (not single verses), so the default
// sits between scripture body size and the full scripture hero size — bigger
// than the supporting verse but small enough to accommodate long topics in 2-3
// balanced lines.
const prayerTitleSizeClass = computed(() => {
  const s = props.item?.typography?.size ?? 'lg';
  return {
    sm: 'text-3xl md:text-4xl',
    md: 'text-4xl md:text-[3.25rem]',
    lg: 'text-[2.75rem] md:text-[3.75rem]',
    xl: 'text-5xl md:text-7xl',
    '2xl': 'text-6xl md:text-8xl',
  }[s];
});

const alignClass = computed(() => {
  const a = props.item?.typography?.align ?? 'center';
  return { left: 'text-left items-start', center: 'text-center items-center', right: 'text-right items-end' }[a];
});

const weight = computed(() => props.item?.typography?.weight ?? 500);

const isPrayer = computed(
  () => props.item?.type === 'prayer' || props.item?.type === 'prayer-sub',
);
const isLyrics = computed(() => props.item?.type === 'lyrics');
const isAnnouncement = computed(() => props.item?.type === 'announcement');

// Lyrics stanzas → display lines. A stanza's `lines` are newline-delimited.
const lyricStanzas = computed(() =>
  (props.item?.stanzas ?? []).map((s) => ({
    id: s.id,
    label: s.label,
    lines: (s.lines ?? '').split('\n'),
  })),
);
</script>

<template>
  <!-- Prayer point — number/letter on top, prayer point as hero, supporting
       scripture and reference rendered smaller below. -->
  <CueCanvas v-if="item?.id.startsWith('cue_')" :text="item.body ?? ''" :reference="item.reference" :attribution="item.subtitle" :theme="{background:item.background?.color ?? '#0a0a0c',color:item.color ?? '#f4f4f5',size:item.typography?.size ?? 'lg',align:item.typography?.align ?? 'center'}" />
  <div v-else-if="item && isPrayer" class="absolute inset-0 flex flex-col justify-center px-16 md:px-32" :class="alignClass">
    <div class="w-full max-w-8xl space-y-6">
      <div v-if="prayerLabel"
        class="text-2xl md:text-3xl font-semibold tracking-[0.18em] uppercase text-accent drop-shadow-[0_2px_18px_rgba(125,211,252,0.45)]"
        :class="alignClass">
        Prayer {{ prayerLabel }}
      </div>
      <div v-if="item.title" class="tracking-tight leading-[1.2] text-white drop-shadow-2xl text-balance"
        :class="[prayerTitleSizeClass, alignClass]" :style="{ fontWeight: weight }">
        {{ item.title }}
      </div>
      <div v-if="item.body" class="text-xl md:text-3xl leading-[1.5] text-white/80 max-w-4xl mx-auto"
        :class="alignClass">
        {{ item.body }}
      </div>
      <div v-if="item.reference" class="text-lg md:text-2xl font-medium text-accent/90 tracking-wide"
        :class="alignClass">
        {{ item.reference }}
      </div>
    </div>
  </div>

  <!-- Lyrics — stanzas stacked, centered, large. One slide = one projected group. -->
  <div v-else-if="item && isLyrics" class="absolute inset-0 flex flex-col justify-center px-16 md:px-32" :class="alignClass">
    <div class="w-full max-w-6xl space-y-8">
      <div v-for="st in lyricStanzas" :key="st.id" class="space-y-2">
        <div
          v-if="st.label"
          class="text-base md:text-xl font-semibold tracking-[0.18em] uppercase text-accent/90"
          :class="alignClass"
        >
          {{ st.label }}
        </div>
        <div
          class="tracking-tight leading-[1.25] text-white drop-shadow-2xl text-balance"
          :class="[sizeClass, alignClass]"
          :style="{ fontWeight: weight }"
        >
          <div v-for="(line, li) in st.lines" :key="li">{{ line }}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Announcement — lower-third frosted band. -->
  <div v-else-if="item && isAnnouncement" class="absolute inset-0 flex flex-col justify-end pb-[12vh] px-16 md:px-32" :class="alignClass">
    <div class="w-full max-w-5xl rounded-3xl bg-black/45 backdrop-blur-xl border border-white/10 px-10 py-7 space-y-2" :class="alignClass">
      <div v-if="item.title" class="text-4xl md:text-6xl font-semibold tracking-display text-white drop-shadow-2xl" :style="{ fontWeight: weight }">
        {{ item.title }}
      </div>
      <div v-if="item.subtitle" class="text-2xl md:text-3xl text-accent/90 font-medium">{{ item.subtitle }}</div>
      <div v-if="item.body" class="text-xl md:text-2xl text-white/80 leading-[1.4]">{{ item.body }}</div>
    </div>
  </div>

  <!-- Scripture / text / fallback. -->
  <div v-else-if="item" class="absolute inset-0 flex flex-col justify-center px-16 md:px-32" :class="alignClass">
    <div class="max-w-5xl w-full">
      <div v-if="item.body" class="tracking-display leading-[1.2] text-white drop-shadow-2xl" :class="sizeClass"
        :style="{ fontWeight: weight }">
        {{ item.body }}
      </div>
      <div v-else-if="item.title" class="tracking-display leading-[1.1] text-white drop-shadow-2xl" :class="sizeClass"
        :style="{ fontWeight: weight }">
        {{ item.title }}
      </div>
      <div v-if="item.reference" class="mt-8 text-2xl md:text-3xl font-medium text-white/75 tracking-wide">
        {{ item.reference }}
      </div>
    </div>
  </div>
</template>
