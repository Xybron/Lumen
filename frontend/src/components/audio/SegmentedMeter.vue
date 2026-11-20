<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ percent: number; label: string }>();
const value = computed(() => Number.isFinite(props.percent) ? Math.min(100, Math.max(0, props.percent)) : 0);
</script>

<template>
  <div class="segmented-meter" role="meter" :aria-label="label" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(value)">
    <i v-for="segment in 30" :key="segment" :class="{ lit: value >= segment * 100 / 30, warm: segment > 24, peak: segment > 28 }" />
  </div>
</template>

<style scoped>
.segmented-meter { display:flex; gap:2px; height:9px; min-width:20px; width:100%; }
.segmented-meter i { flex:1; min-width:0; border-radius:1px; background:#35383d; }
.segmented-meter i.lit { background:#b8e65a; }
.segmented-meter i.lit.warm { background:#e8c54e; }
.segmented-meter i.lit.peak { background:#ec766a; }
</style>
