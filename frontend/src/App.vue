<script setup lang="ts">
import { Toaster } from '@/components/ui/sonner';
import { useRoute } from 'vue-router';
import { computed, defineAsyncComponent, provide, ref } from 'vue';
import { useEventListener, useFullscreen } from '@vueuse/core';
import { toast } from 'vue-sonner';
import SceneShortcutListener from '@/components/studio/SceneShortcutListener.vue';
import StudioMultiviewOverlay from '@/components/studio/StudioMultiviewOverlay.vue';
import ConfirmationDialog from '@/components/shell/ConfirmationDialog.vue';
import ExportProgressOverlay from '@/components/clips/ExportProgressOverlay.vue';
import BroadcastPanel from '@/components/broadcast/BroadcastPanel.vue';
import BroadcastAlert from '@/components/broadcast/BroadcastAlert.vue';
import SharedOutputsDialog from '@/components/studio/SharedOutputsDialog.vue';
import { useIdentityStore } from '@/stores/identity';
import { appFullscreenKey } from '@/composables/useAppFullscreen';
import { sceneShortcutSurfaceBlocked } from '@/lib/studio/scene-shortcuts';
import { mediaReturnPath } from '@/lib/media-navigation';
const route = useRoute(), identity = useIdentityStore();
const studioStatusHeight = ref(44);
const workspaceListeners = computed(() => route.name === 'studio'
  ? { 'status-height': (height: number) => { studioStatusHeight.value = height; } } : {});
const fullscreen = useFullscreen(document.documentElement);
provide(appFullscreenKey, fullscreen);
const separateOutputRoutes = new Set(['live', 'live-channel', 'output', 'studio-output']);
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (separateOutputRoutes.has(String(route.name)) || !fullscreen.isSupported.value ||
    event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
    event.key.toLowerCase() !== 'f' ||
    sceneShortcutSurfaceBlocked(event.target instanceof Element ? event.target : null, document, false)) return;
  event.preventDefault();
  void fullscreen.toggle().catch(() => toast.error('Fullscreen is unavailable in this window.'));
});
const channelOrStudio = computed(() => route.name === 'dashboard' || route.name === 'studio');
const preserveStudio = computed(() => channelOrStudio.value || route.name === 'media' ||
  (['switch', 'recordings', 'clip-editor'].includes(String(route.name)) && !!mediaReturnPath(route.query)));
const exportSurface = computed(() => ['dashboard', 'studio', 'media', 'studio-multiview', 'switch', 'recordings', 'clip-editor'].includes(String(route.name)));
const broadcastSurface = computed(() => identity.ready && identity.isAuthenticated && identity.can('*', 'author') && (exportSurface.value || route.name === 'team'));
const TeamIntegration = defineAsyncComponent(() => import('@/components/team/TeamIntegration.vue'));
const teamSurface = computed(() => channelOrStudio.value || route.name === 'media' || route.name === 'team');
</script>

<template>
  <RouterView v-slot="{ Component }">
    <!-- Keep the decoded Studio monitors available while editing channels or media,
         including the usage destinations opened from Media.
         Other routes and sign-out release the cached workspace. -->
    <KeepAlive :include="preserveStudio && identity.isAuthenticated ? ['StudioView'] : []">
      <component :is="Component" v-on="workspaceListeners" />
    </KeepAlive>
  </RouterView>
  <TeamIntegration v-if="teamSurface" />
  <SceneShortcutListener v-if="identity.ready && identity.isAuthenticated && (channelOrStudio || route.name === 'studio-multiview')" />
  <StudioMultiviewOverlay v-if="identity.ready && identity.isAuthenticated && identity.can('*', 'author') && channelOrStudio" />
  <ConfirmationDialog />
  <ExportProgressOverlay v-if="exportSurface" :visible="exportSurface" />
  <template v-if="broadcastSurface"><BroadcastPanel /><BroadcastAlert /><SharedOutputsDialog /></template>
  <Toaster theme="dark" position="bottom-right" :class="route.name === 'studio' ? 'studio-toaster' : ''" :style="{ '--studio-status-height': studioStatusHeight + 'px' }" />
</template>
