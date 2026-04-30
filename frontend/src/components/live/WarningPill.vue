<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ visible: boolean; remainingMs: number }>();

const minutes = computed(() => Math.max(1, Math.ceil(props.remainingMs / 60000)));
const label = computed(() => `${minutes.value} min to go`);
</script>

<template>
  <Transition
    enter-active-class="transition duration-[380ms] ease-out-cubic"
    enter-from-class="opacity-0 translate-y-4"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-[320ms] ease-out-cubic"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-4"
  >
    <div
      v-if="visible"
      class="absolute left-1/2 -translate-x-1/2 z-30"
      style="bottom: 60px;"
    >
      <div class="panel px-5 py-2.5 flex items-center gap-2.5 text-white text-sm font-medium tnum">
        <span class="relative flex h-2 w-2">
          <span class="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-70 animate-ping" />
          <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
        </span>
        {{ label }}
      </div>
    </div>
  </Transition>
</template>
