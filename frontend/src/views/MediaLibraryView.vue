<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowLeft, ShieldCheck } from 'lucide-vue-next';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';
import ChannelNav from '@/components/shell/ChannelNav.vue';
import LoginGate from '@/components/shell/LoginGate.vue';
import WorkspaceSkeleton from '@/components/shell/WorkspaceSkeleton.vue';
import MediaImageBrowser from '@/components/media/MediaImageBrowser.vue';
import { useIdentityStore } from '@/stores/identity';
import { useContentStore } from '@/stores/content';
import '@/styles/media-library.css';

const identity = useIdentityStore(), content = useContentStore(), route = useRoute();
const initialAssetId = computed(() => typeof route.query.asset === 'string' ? route.query.asset : '');
onMounted(() => { if (!identity.ready) void identity.load(); });
watch(() => identity.ready && identity.isAuthenticated, ready => { if (ready) void content.load(); }, { immediate: true });
</script>

<template>
  <LoginGate v-if="identity.ready && !identity.isAuthenticated" />
  <WorkspaceSkeleton v-else-if="!identity.ready" />
  <main v-else class="media-app" data-testid="media-library">
    <WorkspaceHeader />
    <div class="media-page-scroll">
      <MediaImageBrowser v-if="identity.can('*', 'author')" :initial-asset-id="initialAssetId" />
      <div v-else class="media-access-message"><ShieldCheck :size="30" /><h1>Author access is required</h1><p>Ask your administrator for author access to manage the station’s media library.</p><RouterLink to="/" class="media-button"><ArrowLeft :size="15" />Back to Lumen</RouterLink></div>
    </div>
    <ChannelNav />
  </main>
</template>
