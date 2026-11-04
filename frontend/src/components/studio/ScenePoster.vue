<script setup lang="ts">
import { computed } from 'vue';
import { sampleAnimation } from '@/lib/studio/animation';
import ChannelPoster from './ChannelPoster.vue';
import type { Item } from '@/types';
import type { SceneLayer, StudioScene, StudioSource } from '../../../../shared/production';
const props = withDefaults(defineProps<{ scene: StudioScene; sources?: StudioSource[]; animationTime?: number | null; animationLayerId?: string | null;
  channels?: Record<string, { item?: Item; textChannel: boolean }>; posterForMedia?: (path: string | undefined, kind: 'image' | 'video') => string | undefined;
  previewMedia?: boolean; streamForSource?: (id: string) => MediaStream | null }>(), { animationTime: null, animationLayerId: null, previewMedia: false });
const layers = computed(() => props.scene.layers.filter(layer => {
  if (!layer.visible) return false;
  const channel = channelFor(layer.sourceId);
  return !channel || !!channel.item || !(channel.textChannel || layer.channelStyle === 'overlay');
}));
function sourceFor(id?: string) { return props.sources?.find(source => source.id === id); }
function channelFor(id?: string) { const source = sourceFor(id); return source?.kind === 'channel' && source.channelId ? props.channels?.[source.channelId] : undefined; }
function mediaUrl(id?: string) { const source = sourceFor(id); return source?.url ? props.posterForMedia && source.kind === 'image' ? props.posterForMedia(source.url, 'image') : `/${source.url.replace(/^\//, '')}` : undefined; }
function stream(id?: string) { return id ? props.streamForSource?.(id) ?? null : null; }
function styleFor(layer: SceneLayer) {
  const pose = sampleAnimation(layer.animation, props.animationLayerId && props.animationLayerId !== layer.id ? null : props.animationTime);
  return {
    left: layer.x + pose.x / 19.2 + '%', top: layer.y + pose.y / 10.8 + '%', width: layer.width + '%', height: layer.height + '%', opacity: layer.opacity * pose.opacity,
    transform: `rotate(${pose.rotation}deg) scale(${pose.scale})`, transformOrigin: 'center',
    background: layer.background, color: layer.color, fontSize: layer.fontSize / 19.2 + 'cqw', fontWeight: layer.fontWeight,
    textAlign: layer.align, justifyContent: layer.align === 'left' ? 'flex-start' : layer.align === 'right' ? 'flex-end' : 'center', borderRadius: layer.radius / 19.2 + 'cqw',
  };
}
</script>
<template>
  <div class="scene-poster" :style="{ background: scene.background }" aria-hidden="true">
    <div v-for="layer in layers" :key="layer.id" class="poster-layer" :data-layer-id="layer.id" :style="styleFor(layer)">
      <span v-if="layer.kind === 'text'">{{ layer.text }}</span>
      <ChannelPoster v-else-if="channelFor(layer.sourceId)?.item" :item="channelFor(layer.sourceId)!.item!" :layer="layer" :overlay="channelFor(layer.sourceId)!.textChannel || layer.channelStyle === 'overlay'" :poster-for-media="posterForMedia" />
      <template v-else-if="channelFor(layer.sourceId)" />
      <img v-else-if="sourceFor(layer.sourceId)?.kind === 'image' && mediaUrl(layer.sourceId)" :src="mediaUrl(layer.sourceId)" :style="{ objectFit: layer.fit }" loading="lazy" decoding="async" draggable="false" alt="" />
      <img v-else-if="!previewMedia && sourceFor(layer.sourceId)?.kind === 'video' && posterForMedia?.(sourceFor(layer.sourceId)?.url, 'video')" :src="posterForMedia(sourceFor(layer.sourceId)?.url, 'video')" :style="{ objectFit: layer.fit }" loading="lazy" decoding="async" draggable="false" alt="" />
      <video v-else-if="previewMedia && sourceFor(layer.sourceId)?.kind === 'video'" :src="mediaUrl(layer.sourceId)" :style="{ objectFit: layer.fit }" muted autoplay loop playsinline />
      <video v-else-if="previewMedia && stream(layer.sourceId)" :srcObject="stream(layer.sourceId)" :style="{ objectFit: layer.fit }" muted autoplay playsinline />
      <div v-else-if="layer.kind === 'source'" class="source-placeholder" :class="{ 'channel-overlay-placeholder': sourceFor(layer.sourceId)?.kind === 'channel' && layer.channelStyle === 'overlay' }"><span>{{ sourceFor(layer.sourceId)?.name ?? 'Source' }}<small v-if="previewMedia">{{ sourceFor(layer.sourceId)?.kind === 'channel' && layer.channelStyle === 'overlay' ? 'Channel overlay · content updates from its channel' : 'Source placeholder · live output is unchanged' }}</small></span></div>
    </div>
  </div>
</template>
<style scoped>
.scene-poster { position: absolute; inset: 0; container-type: inline-size; overflow: hidden; }
.poster-layer { position: absolute; display: flex; align-items: center; overflow: hidden; line-height: 1.24; }
.poster-layer > span { white-space: pre-wrap; padding: 0 .4cqw; width: 100%; }
.poster-layer img, .poster-layer video { width: 100%; height: 100%; }
.source-placeholder { width: 100%; height: 100%; background: #12191c; display: grid; place-items: center; font-size: 3cqw; color: #667c84; }
.source-placeholder small { display: block; margin-top: .6cqw; font-size: 1.7cqw; opacity: .7; }
.channel-overlay-placeholder { background: transparent; color: inherit; font-size: inherit; text-align: inherit; }
.channel-overlay-placeholder small { font-size: .8em; }
</style>
