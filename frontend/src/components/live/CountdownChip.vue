<script setup lang="ts">
import { computed, watch, ref } from 'vue';

const props = defineProps<{ visible: boolean; remainingMs: number; thresholdMs: number }>();

const seconds = computed(() => Math.max(0, Math.ceil(props.remainingMs / 1000)));
const ringProgress = computed(() => {
  const pct = Math.max(0, Math.min(1, props.remainingMs / props.thresholdMs));
  return pct;
});

// The number "pulses" each tick — 0.92 → 1 spring on every change.
const pulseKey = ref(0);
watch(seconds, () => {
  pulseKey.value++;
});

const CIRC = 2 * Math.PI * 22;
const dashOffset = computed(() => CIRC * (1 - ringProgress.value));
</script>

<template>
  <Transition
    enter-active-class="transition duration-[380ms] ease-out-cubic"
    enter-from-class="opacity-0 -translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-[320ms] ease-out-cubic"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 -translate-y-3"
  >
    <div v-if="visible" class="absolute z-30" style="top: 32px; right: 32px;">
      <div class="panel relative w-[60px] h-[60px] flex items-center justify-center">
        <svg class="absolute inset-0" viewBox="0 0 60 60">
          <circle cx="30" cy="30" r="22" stroke="rgba(255,255,255,0.12)" stroke-width="2" fill="none" />
          <circle
            cx="30"
            cy="30"
            r="22"
            stroke="rgb(125,211,252)"
            stroke-width="2"
            fill="none"
            stroke-linecap="round"
            transform="rotate(-90 30 30)"
            :stroke-dasharray="CIRC"
            :stroke-dashoffset="dashOffset"
            style="transition: stroke-dashoffset 200ms linear;"
          />
        </svg>
        <Transition
          enter-active-class="transition duration-[180ms] ease-out-cubic"
          enter-from-class="scale-[0.92] opacity-60"
          enter-to-class="scale-100 opacity-100"
          mode="out-in"
        >
          <span :key="pulseKey" class="text-xl font-semibold text-white tnum tracking-display">
            {{ seconds }}
          </span>
        </Transition>
      </div>
    </div>
  </Transition>
</template>
