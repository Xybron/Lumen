<script setup lang="ts">
import { computed } from 'vue';
import type { Item } from '@/types';

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
</script>

<template>
  <!-- Prayer point — number/letter on top, prayer point as hero, supporting
       scripture and reference rendered smaller below. -->
  <div v-if="item && isPrayer" class="absolute inset-0 flex flex-col justify-center px-16 md:px-32" :class="alignClass">
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
