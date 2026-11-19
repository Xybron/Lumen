<script setup lang="ts">
import Skeleton from './Skeleton.vue';
</script>

<template>
  <span class="skeleton-indicator" aria-hidden="true">
    <Skeleton height="4px" radius="2px" />
    <Skeleton width="65%" height="4px" radius="2px" />
  </span>
</template>

<style scoped>
.skeleton-indicator {
  --skeleton-base: color-mix(in srgb, currentColor 22%, transparent);
  --skeleton-highlight: color-mix(in srgb, currentColor 18%, transparent);
  display: inline-flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
