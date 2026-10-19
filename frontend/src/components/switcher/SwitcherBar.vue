<script setup lang="ts">
import { ArrowRightLeft } from 'lucide-vue-next';

defineProps<{ canTake: boolean }>();
defineEmits<{ (e: 'take'): void }>();
</script>

<template>
  <div class="flex items-center justify-center gap-4 panel px-4 py-3">
    <div class="text-xs text-white/45 uppercase tracking-[0.14em]">
      <span class="text-amber-300">Preview</span> → <span class="text-accent">Program</span>
    </div>
    <button
      class="h-12 px-8 rounded-2xl bg-accent text-black font-bold text-lg tracking-wide hover:bg-accent/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
      :disabled="!canTake"
      @click="$emit('take')"
    >
      <ArrowRightLeft :size="18" /> TAKE
    </button>
  </div>
</template>
