<script setup lang="ts">
import { Toaster } from '@/components/ui/sonner';
import { useRoute } from 'vue-router';
import { computed } from 'vue';
import SceneShortcutListener from '@/components/studio/SceneShortcutListener.vue';
import StudioMultiviewOverlay from '@/components/studio/StudioMultiviewOverlay.vue';
import ConfirmationDialog from '@/components/shell/ConfirmationDialog.vue';
import ExportProgressOverlay from '@/components/clips/ExportProgressOverlay.vue';
import BroadcastPanel from '@/components/broadcast/BroadcastPanel.vue';
import { useIdentityStore } from '@/stores/identity';
const route = useRoute(), identity = useIdentityStore();
const channelOrStudio = computed(() => route.name === 'dashboard' || route.name === 'studio');
const exportSurface = computed(() => ['dashboard', 'studio', 'studio-multiview', 'switch', 'recordings', 'clip-editor'].includes(String(route.name)));
</script>

<template>
  <RouterView />
  <SceneShortcutListener v-if="identity.ready && identity.isAuthenticated && (channelOrStudio || route.name === 'studio-multiview')" />
  <StudioMultiviewOverlay v-if="identity.ready && identity.isAuthenticated && identity.can('*', 'author') && channelOrStudio" />
  <ConfirmationDialog />
  <ExportProgressOverlay :visible="exportSurface" />
  <BroadcastPanel v-if="identity.ready && identity.isAuthenticated && identity.can('*', 'author') && (channelOrStudio || route.name === 'studio-multiview' || route.name === 'switch')" />
  <Toaster theme="dark" position="bottom-right" />
</template>
