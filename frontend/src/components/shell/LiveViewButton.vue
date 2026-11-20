<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { openStudioProjection } from '@/lib/tauri';

defineProps<{ channelId?: string; studio?: boolean }>();

function openLiveView() {
  openStudioProjection();
}
</script>

<template>
  <Button variant="accent" size="md" class="lumen-live-view shrink-0" title="Open Live View" @click="openLiveView">
    <ExternalLink :size="16" />Open Live View
  </Button>
</template>

<style scoped>
.lumen-live-view { height: 34px; padding: 0 12px; gap: 8px; border-radius: var(--radius-control); font-size: 12px; font-weight: 550; background: #ddfb730d; border-color: #ddfb7330; }
.lumen-live-view:hover { background: #ddfb7319; border-color: #ddfb7355; }
@media (pointer: coarse) { .lumen-live-view { height: 36px; } }
</style>
