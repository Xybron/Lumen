<script setup lang="ts">
import { Zap, Hand } from 'lucide-vue-next';
import type { Mode } from '@/types';

const props = defineProps<{ mode: Mode }>();
const emit = defineEmits<{ (e: 'update:mode', v: Mode): void }>();

function set(m: Mode) {
  if (m !== props.mode) emit('update:mode', m);
}

</script>

<template>
  <div
    class="mode-toggle"
    role="group"
    aria-label="Presentation mode"
  >
    <button
      class="mode-option"
      :class="{ active: mode === 'auto' }"
      :title="'Auto'"
      :aria-pressed="mode === 'auto'"
      @click="set('auto')"
    >
      <Zap :size="13" />
      <span>Auto</span>
    </button>
    <button
      class="mode-option"
      :class="{ active: mode === 'manual' }"
      :title="'Manual'"
      :aria-pressed="mode === 'manual'"
      @click="set('manual')"
    >
      <Hand :size="13" />
      <span>Manual</span>
    </button>
  </div>
</template>

<style scoped>
.mode-toggle { display: inline-flex; align-items: center; padding: 3px; gap: 2px; border: 1px solid var(--border-hair); border-radius: var(--radius-control, 7px); background: #0002; }
.mode-option { min-height: 27px; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 3px 9px; border-radius: 5px; color: var(--text-muted); font-size: 11px; transition: background .12s, color .12s; }
.mode-option:hover { color: var(--text-primary); }
.mode-option.active { background: var(--surface-3, #25272b); color: var(--text-primary); box-shadow: 0 1px 2px #0003; }
.mode-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
