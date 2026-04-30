<script setup lang="ts">
import { computed } from 'vue';
import { Zap, Hand } from 'lucide-vue-next';
import type { Mode } from '@/types';

const props = defineProps<{ mode: Mode }>();
const emit = defineEmits<{ (e: 'update:mode', v: Mode): void }>();

function set(m: Mode) {
  if (m !== props.mode) emit('update:mode', m);
}

// CSS variables drive the sliding indicator width — 36px below md (icon-only
// chips), 88px at md+ (labeled chips). No JS measurement needed.
const indicatorStyle = computed(() => ({
  width: 'var(--tt-w)',
  left: props.mode === 'auto' ? '4px' : 'calc(100% - var(--tt-w) - 4px)',
}));
</script>

<template>
  <div
    class="mode-toggle relative inline-flex items-center rounded-full p-1 bg-white/[0.04] border border-hair"
  >
    <div
      class="absolute top-1 bottom-1 rounded-full bg-white/[0.10] border border-hairglow shadow-[0_4px_12px_rgba(0,0,0,0.3)] transition-all duration-300 ease-out-quart"
      :style="indicatorStyle"
    />
    <button
      class="relative z-10 flex items-center justify-center gap-1.5 h-7 rounded-full text-xs font-medium tracking-tight transition-colors w-9 md:w-[88px] px-2 md:px-3.5"
      :class="mode === 'auto' ? 'text-white' : 'text-white/55 hover:text-white/80'"
      :title="'Auto'"
      :aria-pressed="mode === 'auto'"
      @click="set('auto')"
    >
      <Zap :size="13" />
      <span class="hidden md:inline">Auto</span>
    </button>
    <button
      class="relative z-10 flex items-center justify-center gap-1.5 h-7 rounded-full text-xs font-medium tracking-tight transition-colors w-9 md:w-[88px] px-2 md:px-3.5"
      :class="mode === 'manual' ? 'text-white' : 'text-white/55 hover:text-white/80'"
      :title="'Manual'"
      :aria-pressed="mode === 'manual'"
      @click="set('manual')"
    >
      <Hand :size="13" />
      <span class="hidden md:inline">Manual</span>
    </button>
  </div>
</template>

<style scoped>
.mode-toggle {
  --tt-w: 36px;
}
@media (min-width: 768px) {
  .mode-toggle {
    --tt-w: 88px;
  }
}
</style>
