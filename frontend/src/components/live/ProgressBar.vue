<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ progress: number; manual?: boolean }>();

const pct = computed(() => Math.max(0, Math.min(1, props.progress)) * 100);
const widthPct = computed(() => `${pct.value}%`);
</script>

<template>
  <div class="absolute top-0 left-0 right-0 h-[5px] z-30 pointer-events-none">
    <template v-if="!manual">
      <div
        class="firey-fill absolute inset-y-0 left-0 will-change-[width]"
        :style="{ width: widthPct }"
      />
      <div
        class="firey-tip absolute top-1/2 -translate-y-1/2 -translate-x-1/2 will-change-[left]"
        :style="{ left: widthPct }"
      />
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

/* Width and tip position are driven every animation frame from the parent —
 * no CSS transition needed (and adding one only smears between rAF samples). */
</style>
