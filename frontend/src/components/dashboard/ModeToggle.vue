<script setup lang="ts">
import { computed } from 'vue';
import { Zap, Hand } from 'lucide-vue-next';
import type { Mode } from '@/types';

const props = withDefaults(
  defineProps<{ mode: Mode; compact?: boolean }>(),
  { compact: false },
);
const emit = defineEmits<{ (e: 'update:mode', v: Mode): void }>();

function set(m: Mode) {
  if (m !== props.mode) emit('update:mode', m);
}

// Compact mode collapses to icon-only chips on small screens; full mode keeps
// labels at every size.
const buttonWidth = computed(() => (props.compact ? 'w-9 sm:w-[88px]' : 'w-[88px]'));
const indicatorStyle = computed(() => {
  if (props.compact) {
    // CSS variables let us drive width via media queries without JS.
    return {
      width: 'var(--tt-w, 36px)',
      left: props.mode === 'auto' ? '4px' : 'calc(100% - var(--tt-w, 36px) - 4px)',
    };
  }
  return {
    width: '88px',
    left: props.mode === 'auto' ? '4px' : 'calc(100% - 92px)',
  };
});
</script>

<template>
  <div
    class="mode-toggle relative inline-flex items-center rounded-full p-1 bg-white/[0.04] border border-hair"
    :class="{ 'mode-toggle--compact': compact }"
  >
    <div
      class="absolute top-1 bottom-1 rounded-full bg-white/[0.10] border border-hairglow shadow-[0_4px_12px_rgba(0,0,0,0.3)] transition-all duration-300 ease-out-quart"
      :style="indicatorStyle"
    />
    <button
      class="relative z-10 flex items-center justify-center gap-1.5 h-7 rounded-full text-xs font-medium tracking-tight transition-colors px-2 sm:px-3.5"
      :class="[
        buttonWidth,
        mode === 'auto' ? 'text-white' : 'text-white/55 hover:text-white/80',
      ]"
      @click="set('auto')"
    >
      <Zap :size="12" />
      <span :class="compact ? 'hidden sm:inline' : ''">Auto</span>
    </button>
    <button
      class="relative z-10 flex items-center justify-center gap-1.5 h-7 rounded-full text-xs font-medium tracking-tight transition-colors px-2 sm:px-3.5"
      :class="[
        buttonWidth,
        mode === 'manual' ? 'text-white' : 'text-white/55 hover:text-white/80',
      ]"
      @click="set('manual')"
    >
      <Hand :size="12" />
      <span :class="compact ? 'hidden sm:inline' : ''">Manual</span>
    </button>
  </div>
</template>

<style scoped>
.mode-toggle--compact {
  --tt-w: 36px;
}
@media (min-width: 640px) {
  .mode-toggle--compact {
    --tt-w: 88px;
  }
}
</style>
