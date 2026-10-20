import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/recordings',
      name: 'recordings',
      component: () => import('@/views/RecordingsView.vue'),
    },
    {
      path: '/recordings/:recordingId/editor',
      name: 'clip-editor',
      component: () => import('@/views/ClipEditorView.vue'),
    },
    {
      path: '/studio/multiview',
      name: 'studio-multiview',
      component: () => import('@/views/StudioMultiviewView.vue'),
    },
    {
      path: '/studio',
      name: 'studio',
      component: () => import('@/views/StudioView.vue'),
    },
    {
      path: '/studio/engine',
      name: 'studio-engine',
      component: () => import('@/views/StudioEngineView.vue'),
    },
    {
      path: '/studio/output/:outputId',
      name: 'studio-output',
      component: () => import('@/views/StudioOutputView.vue'),
    },
    {
      path: '/',
      name: 'dashboard',
      component: () => import('@/views/AppShell.vue'),
    },
    {
      // Bare /live resolves to the first channel as a fallback.
      path: '/live',
      name: 'live',
      component: () => import('@/views/LiveView.vue'),
    },
    {
      // Each channel has its own dedicated projection output.
      path: '/live/:channelId',
      name: 'live-channel',
      component: () => import('@/views/LiveView.vue'),
    },
    {
      // Public mobile page for teammates to contribute media (no login).
      path: '/contribute',
      name: 'contribute',
      component: () => import('@/views/ContributeView.vue'),
    },
    {
      // A destination output that follows the Program bus (or its pinned route).
      path: '/out/:destinationId',
      name: 'output',
      component: () => import('@/views/OutputView.vue'),
    },
    {
      // The Program/Preview switcher operator surface.
      path: '/switch',
      name: 'switch',
      component: () => import('@/views/SwitcherView.vue'),
    },
    {
      // Public page: contribute a camera/screen as a WebRTC source.
      path: '/cam',
      name: 'cam',
      component: () => import('@/views/CameraPublishView.vue'),
    },
  ],
});
