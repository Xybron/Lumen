<script setup lang="ts">
import { Toaster } from '@/components/ui/sonner';
import { useRoute } from 'vue-router';
import { computed, defineAsyncComponent } from 'vue';
import SceneShortcutListener from '@/components/studio/SceneShortcutListener.vue';
import StudioMultiviewOverlay from '@/components/studio/StudioMultiviewOverlay.vue';
import ConfirmationDialog from '@/components/shell/ConfirmationDialog.vue';
import ExportProgressOverlay from '@/components/clips/ExportProgressOverlay.vue';
import BroadcastPanel from '@/components/broadcast/BroadcastPanel.vue';
import { useIdentityStore } from '@/stores/identity';
const route = useRoute(), identity = useIdentityStore();
const channelOrStudio = computed(() => route.name === 'dashboard' || route.name === 'studio');
const exportSurface = computed(() => ['dashboard', 'studio', 'studio-multiview', 'switch', 'recordings', 'clip-editor'].includes(String(route.name)));
const TeamIntegration = defineAsyncComponent(() => import('@/components/team/TeamIntegration.vue'));
const teamSurface = computed(() => channelOrStudio.value || route.name === 'team');
</script>

<template>
  <RouterView />
  <TeamIntegration v-if="teamSurface" />
  <SceneShortcutListener v-if="identity.ready && identity.isAuthenticated && (channelOrStudio || route.name === 'studio-multiview')" />
  <StudioMultiviewOverlay v-if="identity.ready && identity.isAuthenticated && identity.can('*', 'author') && channelOrStudio" />
  <ConfirmationDialog />
  <ExportProgressOverlay v-if="exportSurface" :visible="exportSurface" />
  <BroadcastPanel v-if="identity.ready && identity.isAuthenticated && identity.can('*', 'author') && (channelOrStudio || route.name === 'studio-multiview' || route.name === 'switch')" />
  <Toaster theme="dark" position="bottom-right" />
</template>
