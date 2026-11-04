<script setup lang="ts">
import { computed } from 'vue';
import { channelText } from '@/lib/studio/channel-overlay';
import { channelPosterLayout } from '@/lib/studio/channel-poster-layout';
import type { Item } from '@/types';
import type { SceneLayer } from '../../../../shared/production';

const props = defineProps<{ item: Item; layer: SceneLayer; overlay: boolean; posterForMedia?: (path: string | undefined, kind: 'image' | 'video') => string | undefined }>();
// Measuring is event-driven, at design resolution. No resize loop, playback
// engine, media stream, or animation frame is needed for a sidebar thumbnail.
const layout = computed(() => {
  const item = props.item, layer = props.layer;
  const width = props.overlay ? layer.width * 19.2 : 1920;
  const height = props.overlay ? layer.height * 10.8 : 1080;
  return channelPosterLayout(item, width, height,
    props.overlay ? layer.fontSize : ({ sm: 42, md: 54, lg: 68, xl: 82, '2xl': 100 })[item.typography?.size ?? 'lg'],
    props.overlay ? layer.fontWeight : item.typography?.weight ?? 500);
});
const visual = computed(() => ['image', 'video'].includes(props.item.type));
const background = computed(() => props.item.background);
const image = computed(() => {
  const bg = background.value;
  if (props.overlay && !visual.value || !bg || !['image', 'video'].includes(bg.kind)) return;
  return props.posterForMedia?.(bg.src, bg.kind as 'image' | 'video');
});
const width = computed(() => props.overlay ? props.layer.width * 19.2 : 1920);
const height = computed(() => props.overlay ? props.layer.height * 10.8 : 1080);
const scale = computed(() => props.overlay ? 1 : props.layer.width / 100);
const align = computed(() => props.overlay ? props.layer.align : props.item.typography?.align ?? 'center');
const backgroundStyle = computed(() => props.overlay ? {} : {
  background: background.value?.kind === 'gradient' ? background.value.gradient : background.value?.color ?? '#121820',
  color: props.item.color ?? '#ffffff',
});
</script>

<template>
  <div class="poster-channel" :class="{ 'is-overlay': overlay }" :style="backgroundStyle" :data-item-id="item.id">
    <img v-if="image" :src="image" :style="{ objectFit: overlay ? layer.fit : background?.fit ?? 'cover' }" loading="lazy" decoding="async" draggable="false" alt="" />
    <div v-if="!overlay && background?.overlayOpacity" class="poster-shade" :style="{ opacity: background.overlayOpacity }" />
    <template v-if="!visual">
      <div v-for="(block, i) in layout.blocks" :key="i" class="poster-channel-text" :style="{
        left: layout.padding / width * 100 + '%', width: layout.contentWidth / width * 100 + '%', top: block.top / height * 100 + '%',
        fontSize: block.fontSize * scale / 19.2 + 'cqw', lineHeight: block.lineHeight / block.fontSize,
        fontWeight: block.fontWeight, opacity: block.opacity, textAlign: align,
      }">{{ block.lines.join('\n') }}</div>
    </template>
    <span v-else-if="!image" class="poster-video-name">{{ item.title || channelText(item) || 'Video' }}</span>
  </div>
</template>

<style scoped>
.poster-channel { position: absolute; inset: 0; overflow: hidden; }
.poster-channel img,.poster-shade { position: absolute; inset: 0; width: 100%; height: 100%; }
.poster-shade { background: #000; }
.poster-channel-text { position: absolute; white-space: pre-wrap; overflow-wrap: anywhere; }
.poster-video-name { position: absolute; inset: 0; display: grid; place-items: center; padding: 5%; text-align: center; font-size: 2.4cqw; color: #a5b2b9; background: #12191c; }
</style>
