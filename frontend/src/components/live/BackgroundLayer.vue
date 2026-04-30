<script setup lang="ts">
import { computed } from 'vue';
import type { Background } from '@/types';
import { mediaUrl } from '@/lib/api';

const props = defineProps<{ background?: Background }>();

const url = computed(() => mediaUrl(props.background?.src));
const fit = computed(() => props.background?.fit ?? 'cover');
const overlay = computed(() => props.background?.overlayOpacity ?? 0.35);
const color = computed(() => props.background?.color ?? '#0a0a0c');
const gradient = computed(() => props.background?.gradient);
</script>

<template>
  <div class="absolute inset-0 overflow-hidden">
    <template v-if="background?.kind === 'image' && url">
      <img :src="url" class="absolute inset-0 h-full w-full" :style="{ objectFit: fit }" />
    </template>
    <template v-else-if="background?.kind === 'video' && url">
      <video
        :src="url"
        class="absolute inset-0 h-full w-full"
        :style="{ objectFit: fit }"
        autoplay
        muted
        loop
        playsinline
      />
    </template>
    <template v-else-if="background?.kind === 'gradient' && gradient">
      <div class="absolute inset-0" :style="{ background: gradient }" />
    </template>
    <template v-else>
      <div class="absolute inset-0" :style="{ background: color }" />
    </template>
    <div
      class="absolute inset-0 bg-black"
      :style="{ opacity: overlay }"
      aria-hidden="true"
    />
  </div>
</template>
