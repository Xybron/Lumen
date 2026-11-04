<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ScenePoster from './ScenePoster.vue';
import { useContentStore } from '@/stores/content';
import { useEnginesStore } from '@/stores/engines';
import { subscribeTopics } from '@/lib/ws';
import { ensureScenePosterMedia, scenePosterMedia } from '@/lib/studio/scene-poster-media';
import type { StudioScene, StudioSource } from '../../../../shared/production';

const props = defineProps<{ scene: StudioScene; sources: StudioSource[] }>();
const content = useContentStore(), engines = useEnginesStore();
const root = ref<HTMLElement>(), visible = ref(false);
let observer: IntersectionObserver | undefined;
const sources = computed(() => {
  const ids = new Set(props.scene.layers.filter(layer => layer.visible).map(layer => layer.sourceId));
  return props.sources.filter(source => ids.has(source.id));
});
const channelIds = computed(() => sources.value.filter(source => source.kind === 'channel' && source.channelId).map(source => source.channelId!));
// The app-wide playback registry owns these topics and follows all channels
// across navigation. Cards only read it; they never prepare, play, or take cues.
// Content and Studio load in parallel. Wait until the receiving engine exists
// before requesting the relay's initial snapshot for a channel.
watch(() => channelIds.value.filter(id => !!engines.engineFor(id)), ids => subscribeTopics(ids), { immediate: true });
const channels = computed(() => Object.fromEntries(channelIds.value.map(id => {
  const engine = engines.engineFor(id);
  return [id, {
    item: engine?.blanked.value ? undefined : engine?.current.value,
    textChannel: ['scripture', 'lyrics'].includes(content.channels.find(channel => channel.id === id)?.kind ?? ''),
  }];
})));
const mediaPaths = computed(() => !visible.value ? [] : [...new Set([
  ...sources.value.filter(source => ['image', 'video'].includes(source.kind)).map(source => source.url),
  ...Object.values(channels.value).map(channel => channel.item?.background?.src),
].filter((path): path is string => !!path))]);
watch(mediaPaths, paths => ensureScenePosterMedia(paths), { immediate: true });
onMounted(() => {
  observer = new IntersectionObserver(entries => { visible.value = entries.some(entry => entry.isIntersecting); }, { rootMargin: '100px' });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="root" class="scene-thumbnail-content" aria-hidden="true">
    <ScenePoster v-if="visible" :scene="scene" :sources="sources" :channels="channels" :poster-for-media="scenePosterMedia" />
  </div>
</template>

<style scoped>
.scene-thumbnail-content { position: absolute; inset: 0; pointer-events: none; }
</style>
