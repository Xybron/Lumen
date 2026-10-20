<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Video, MonitorUp, Cpu } from 'lucide-vue-next';
import PreviewSurface from '@/components/dashboard/PreviewSurface.vue';
import { useRoutingStore } from '@/stores/routing';
import { createViewer, type Viewer } from '@/lib/webrtc';

const props = defineProps<{
  label: string;
  kind: 'channel' | 'webrtc' | 'music' | 'media' | 'capture';
  channelId: string | null;
  publisherId: string | null;
  via?: 'camera' | 'screen';
  isProgram: boolean;
  isPreview: boolean;
}>();
const emit = defineEmits<{ (e: 'preview'): void; (e: 'program'): void }>();

const routing = useRoutingStore();
const item = computed(() => (props.channelId ? routing.currentItemFor(props.channelId) : undefined));

// Lazy WebRTC viewer for camera thumbnails.
const videoEl = ref<HTMLVideoElement | null>(null);
let viewer: Viewer | null = null;
watch(
  () => props.publisherId,
  (pid) => {
    viewer?.stop();
    viewer = null;
    if (pid) {
      viewer = createViewer(pid);
      watch(viewer.stream, (s) => { if (videoEl.value) videoEl.value.srcObject = s; }, { immediate: true });
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => viewer?.stop());

const ring = computed(() =>
  props.isProgram ? 'ring-2 ring-accent' : props.isPreview ? 'ring-2 ring-amber-400' : 'ring-1 ring-hair',
);
</script>

<template>
  <button
    class="group relative aspect-video rounded-xl overflow-hidden bg-black transition-all"
    :class="ring"
    @click="emit('preview')"
    @dblclick="emit('program')"
  >
    <video v-if="publisherId" ref="videoEl" class="h-full w-full object-cover" autoplay muted playsinline />
    <PreviewSurface v-else-if="kind === 'channel'" :item="item" />
    <div v-else class="h-full w-full flex items-center justify-center text-white/40">
      <component :is="kind === 'capture' ? Cpu : via === 'screen' ? MonitorUp : Video" :size="22" />
    </div>

    <!-- label + bus tags -->
    <div class="absolute bottom-0 inset-x-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent flex items-center justify-between">
      <span class="text-[11px] font-medium text-white truncate">{{ label }}</span>
      <span v-if="isProgram" class="text-[9px] font-bold uppercase tracking-wide text-accent">PGM</span>
      <span v-else-if="isPreview" class="text-[9px] font-bold uppercase tracking-wide text-amber-300">PVW</span>
    </div>
  </button>
</template>
