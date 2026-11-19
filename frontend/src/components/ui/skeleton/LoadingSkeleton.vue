<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: 'Loading…' });
</script>

<template>
  <div class="loading-skeleton" role="status" aria-live="polite" :aria-label="label">
    <span class="sr-only">{{ label }}</span>
    <slot />
  </div>
</template>
