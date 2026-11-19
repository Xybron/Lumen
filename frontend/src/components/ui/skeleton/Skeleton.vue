<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  width?: string | number;
  height?: string | number;
  radius?: string | number;
}>();
const dimension = (value?: string | number) => typeof value === 'number' ? `${value}px` : value;
const style = computed(() => ({
  width: dimension(props.width),
  height: dimension(props.height),
  borderRadius: dimension(props.radius),
}));
</script>

<template>
  <span class="skeleton" :style="style" aria-hidden="true" />
</template>

<style scoped>
.skeleton {
  position: relative;
  display: block;
  width: 100%;
  height: 12px;
  max-width: 100%;
  flex-shrink: 0;
  overflow: hidden;
  isolation: isolate;
  border-radius: 5px;
  background: var(--skeleton-base, color-mix(in srgb, var(--text-muted, #a1a4ab) 11%, transparent));
}
.skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 15%, var(--skeleton-highlight, #ffffff09) 48%, transparent 80%);
  transform: translateX(-100%);
  animation: skeleton-shimmer 2s ease-in-out infinite;
}
@keyframes skeleton-shimmer {
  100% { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton::after { animation: none; display: none; }
}
</style>
