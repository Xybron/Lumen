<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ScenePoster from './ScenePoster.vue';
import { useContentStore } from '@/stores/content';
import { useEnginesStore } from '@/stores/engines';
import { useStudioStore } from '@/stores/studio';
import { useSourceStillPosters } from '@/composables/useSourceStillPosters';
import { subscribeTopics } from '@/lib/ws';
import { ensureScenePosterMedia, scenePosterMedia } from '@/lib/studio/scene-poster-media';
import type { StudioScene, StudioSource } from '../../../../shared/production';

const props = defineProps<{ scene: StudioScene; sources: StudioSource[] }>();
const content = useContentStore(), engines = useEnginesStore(), studio = useStudioStore();
const root = ref<HTMLElement>(), visible = ref(false);
let observer: IntersectionObserver | undefined;
const sources = computed(() => {
  const ids = new Set(props.scene.layers.filter(layer => layer.visible && layer.opacity > 0 && layer.x < 100 && layer.y < 100 && layer.x + layer.width > 0 && layer.y + layer.height > 0).map(layer => layer.sourceId));
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
  ...props.scene.layers.filter(layer => layer.visible).map(layer => layer.mediaBackground?.url),
].filter((path): path is string => !!path))]);
const liveInputs = computed(() => {
  studio.connectedSources; // Capture replacement/disconnection invalidates this list.
  if (!visible.value) return [];
  return sources.value.flatMap(source => {
    if (!['camera', 'screen'].includes(source.kind)) return [];
    const track = studio.sourceStream(source.id)?.getVideoTracks().find(track => track.readyState === 'live');
    return track ? [{ id: source.id, track }] : [];
  });
});
const sourceStills = useSourceStillPosters(liveInputs);
watch(mediaPaths, paths => ensureScenePosterMedia(paths), { immediate: true });
onMounted(() => {
  observer = new IntersectionObserver(entries => { visible.value = entries.some(entry => entry.isIntersecting); }, { rootMargin: '100px' });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="root" class="scene-thumbnail-content" aria-hidden="true">
    <ScenePoster v-if="visible" :scene="scene" :sources="sources" :channels="channels" :poster-for-media="scenePosterMedia" :source-stills="sourceStills" />
  </div>
</template>

<style scoped>
.scene-thumbnail-content { position: absolute; inset: 0; pointer-events: none; }
</style>
