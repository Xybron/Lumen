<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { Video, MonitorUp, Radio, Loader2 } from 'lucide-vue-next';
import { createPublisher, type Publisher } from '@/lib/webrtc';

// Public page: a phone/laptop becomes a camera or screen SOURCE the operator can
// put on Program. The contributor just goes live; the operator decides air time.
const via = ref<'camera' | 'screen'>('camera');
const label = ref('');
const live = ref(false);
const busy = ref(false);
const error = ref('');
const videoEl = ref<HTMLVideoElement | null>(null);
let publisher: Publisher | null = null;

async function goLive() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    publisher = await createPublisher({ via: via.value, label: label.value.trim() || undefined });
    // self-preview from the same constraints
    const preview =
      via.value === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true })
        : await navigator.mediaDevices.getUserMedia({ video: true });
    if (videoEl.value) videoEl.value.srcObject = preview;
    live.value = true;
  } catch (e) {
    error.value =
      location.protocol === 'http:' && location.hostname !== 'localhost'
        ? 'Camera needs a secure (https) connection on this network.'
        : `Couldn’t start: ${(e as Error).message}`;
  } finally {
    busy.value = false;
  }
}

function stop() {
  publisher?.stop();
  publisher = null;
  const v = videoEl.value?.srcObject as MediaStream | null;
  v?.getTracks().forEach((t) => t.stop());
  if (videoEl.value) videoEl.value.srcObject = null;
  live.value = false;
}
onBeforeUnmount(stop);
</script>

<template>
  <div class="min-h-screen w-screen bg-base text-textprimary flex items-center justify-center p-4">
    <div class="panel w-full max-w-md p-6 flex flex-col gap-5">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-2xl bg-accent/15 text-accent flex items-center justify-center">
          <Radio :size="18" />
        </div>
        <div>
          <div class="text-lg font-semibold tracking-display">Go live as a source</div>
          <div class="text-xs text-white/45">The operator can put you on the program</div>
        </div>
      </div>

      <div class="relative aspect-video w-full rounded-xl overflow-hidden bg-black border border-hair">
        <video ref="videoEl" class="h-full w-full object-contain" autoplay muted playsinline />
        <div v-if="!live" class="absolute inset-0 flex items-center justify-center text-white/35 text-sm">
          Preview appears here
        </div>
        <div v-if="live" class="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/80 text-white text-[10px] font-bold uppercase tracking-wide">
          <span class="h-1.5 w-1.5 rounded-full bg-white animate-pulse" /> Live
        </div>
      </div>

      <template v-if="!live">
        <div class="grid grid-cols-2 gap-2">
          <button
            class="h-11 rounded-xl border flex items-center justify-center gap-2 text-sm transition-colors"
            :class="via === 'camera' ? 'bg-accent/15 text-accent border-accent/40' : 'bg-white/[0.04] text-white/65 border-hair'"
            @click="via = 'camera'"
          >
            <Video :size="15" /> Camera
          </button>
          <button
            class="h-11 rounded-xl border flex items-center justify-center gap-2 text-sm transition-colors"
            :class="via === 'screen' ? 'bg-accent/15 text-accent border-accent/40' : 'bg-white/[0.04] text-white/65 border-hair'"
            @click="via = 'screen'"
          >
            <MonitorUp :size="15" /> Screen
          </button>
        </div>
        <input
          v-model="label"
          placeholder="Source name (e.g. Stage Cam)"
          class="h-10 rounded-xl bg-white/[0.05] border border-hair px-3 text-sm text-white outline-none focus:border-accent/60"
        />
        <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
        <button
          :disabled="busy"
          class="h-11 rounded-xl bg-accent text-black font-medium text-sm hover:bg-accent/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
          @click="goLive"
        >
          <Loader2 v-if="busy" :size="15" class="animate-spin" />
          {{ busy ? 'Starting…' : 'Go live' }}
        </button>
      </template>
      <button
        v-else
        class="h-11 rounded-xl bg-red-500/15 text-red-300 font-medium text-sm hover:bg-red-500/25 transition-colors"
        @click="stop"
      >
        Stop
      </button>
    </div>
  </div>
</template>
