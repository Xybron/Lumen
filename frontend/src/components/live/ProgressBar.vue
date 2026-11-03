<script setup lang="ts">
import { onBeforeUnmount, ref, watchEffect } from 'vue';

const props = defineProps<{
  clock: { elapsedMs: number; receivedAt: number };
  durationMs: number;
  playing: boolean;
  manual?: boolean;
}>();
const fill = ref<HTMLElement>(), tipTrack = ref<HTMLElement>();
let animations: Animation[] = [], duration = 0;

function clear() {
  for (const animation of animations) animation.cancel();
  animations = [];
  duration = 0;
}
watchEffect(() => {
  if (!fill.value || !tipTrack.value || props.manual || !(props.durationMs > 0)) {
    clear();
    return;
  }
  if (duration !== props.durationMs) {
    clear();
    duration = props.durationMs;
    const timing = { duration, fill: 'both' as const };
    animations = [
      fill.value.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], timing),
      tipTrack.value.animate([{ transform: 'translateX(0%)' }, { transform: 'translateX(100%)' }], timing),
    ];
  }
  const { elapsedMs, receivedAt } = props.clock;
  const position = Math.max(0, Math.min(duration, elapsedMs + (props.playing ? performance.now() - receivedAt : 0)));
  for (const animation of animations) {
    if (!props.playing && animation.playState !== 'paused') animation.pause();
    else if (props.playing && animation.playState === 'paused') animation.play();
    // Leave a correctly running compositor animation alone between ticks.
    // A seek, new cue or pause takes effect at the station's sampled position.
    if (!props.playing || Math.abs(Number(animation.currentTime) - position) > 32) animation.currentTime = position;
  }
}, { flush: 'post' });
onBeforeUnmount(clear);
</script>

<template>
  <div class="absolute top-0 left-0 right-0 h-[5px] z-30 pointer-events-none">
    <template v-if="!manual">
      <div ref="fill" class="firey-fill absolute inset-0" />
      <div ref="tipTrack" class="absolute inset-0">
        <div class="firey-tip absolute top-1/2 -translate-y-1/2 -translate-x-1/2" />
      </div>
    </template>
    <div
      v-else
      class="h-full w-full bg-white/10"
    />
  </div>
</template>

<style scoped>
/* Firey progress: hottest at the leading edge.
 * Mirrors the dialog preview bar — ember → orange → yellow → white-hot.
 * Stretched a touch wider on the leading section so the projector audience
 * still reads the heat at viewing distance. */
.firey-fill {
  height: 100%;
  transform-origin: left;
  transform: scaleX(0);
  background: linear-gradient(
    90deg,
    #4a0a05 0%,
    #7a1a08 18%,
    #c8350c 38%,
    #ff6a14 60%,
    #ffb43c 80%,
    #ffe9a3 94%,
    #ffffff 100%
  );
  box-shadow:
    0 0 8px rgba(255, 120, 30, 0.6),
    0 0 18px rgba(255, 80, 20, 0.4);
}

.firey-tip {
  width: 14px;
  height: 14px;
  border-radius: 9999px;
  background: radial-gradient(
    circle at center,
    #ffffff 0%,
    #ffe28a 35%,
    #ff9a30 70%,
    rgba(255, 90, 20, 0) 100%
  );
  filter: drop-shadow(0 0 7px rgba(255, 200, 80, 0.9))
    drop-shadow(0 0 14px rgba(255, 80, 20, 0.6));
  pointer-events: none;
}

</style>
