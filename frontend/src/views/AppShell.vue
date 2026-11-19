<script setup lang="ts">
// The operator shell. Gates the authoring surface behind sign-in (Live outputs
// at /live/:channelId stay public, read-only mirrors). Engines live app-level in
// the registry, so switching the focused channel never interrupts the others.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { useIdentityStore } from '@/stores/identity';
import { useEnginesStore } from '@/stores/engines';
import { usePresenceStore } from '@/stores/presence';
import { useConnection } from '@/lib/ws';
import ChannelView from '@/views/ChannelView.vue';
import ChannelNav from '@/components/shell/ChannelNav.vue';
import LoginGate from '@/components/shell/LoginGate.vue';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';
import WorkspaceSkeleton from '@/components/shell/WorkspaceSkeleton.vue';
import WorshipView from '@/views/WorshipView.vue';
import EditItemDialog from '@/components/dashboard/EditItemDialog.vue';
import MediaMusicQueueDialog from '@/components/media/MediaMusicQueueDialog.vue';
import { useContentStore } from '@/stores/content';
import { mediaReturnPath } from '@/lib/media-navigation';
import type { Item } from '@/types';
import '@/styles/workspaces.css';

const identity = useIdentityStore();
const engines = useEnginesStore();
const presence = usePresenceStore();
const connection = useConnection();
const content = useContentStore();
const route = useRoute(), router = useRouter();
const openingContent = ref(!content.channels.length);
const contentReady = ref(false);
const mediaReturn = computed(() => mediaReturnPath(route.query));
const mediaEditOpen = ref(false), mediaEditItem = ref<Item | null>(null);
const mediaMusicOpen = ref(false), mediaMusicTrack = ref('');
const mediaEditDestination = ref<{ playlistId: string; channelId: string | null } | null>(null);
const channel = computed(() => content.channels.find(c => c.id === engines.focusedChannelId));
const isWorshipChannel = computed(() => !!channel.value && ['scripture', 'lyrics'].includes(channel.value.kind));

onMounted(() => { void identity.load(); });
// Only the shell's initial read gates mounting. ChannelView also refreshes
// content on mount, so its reads must not tear down and remount the workspace.
watch(() => identity.isAuthenticated, value => {
  if (!value) { contentReady.value = false; mediaEditOpen.value = false; mediaMusicOpen.value = false; return; }
  contentReady.value = false;
  openingContent.value = !content.channels.length;
  void content.load().finally(() => { openingContent.value = false; contentReady.value = true; });
}, { immediate: true });

// Resolve the authoring destination before deciding which channel workspace to
// mount. The previously focused channel may be Scripture/Lyrics. Opening a
// media reference must not advance that channel's playback or select a live slide.
let resolvingMediaLocation = false;
async function openMediaLocation() {
  if (resolvingMediaLocation || route.name !== 'dashboard' || !contentReady.value || !identity.ready || !identity.isAuthenticated) return;
  const channelId = typeof route.query.channel === 'string' ? route.query.channel : null;
  const playlistId = typeof route.query.playlist === 'string' ? route.query.playlist : null;
  const slideId = typeof route.query.slide === 'string' ? route.query.slide : null;
  const musicTrack = typeof route.query.music === 'string' ? route.query.music : null;
  if (!channelId && !playlistId && !slideId && !musicTrack) return;
  resolvingMediaLocation = true;
  try {
    if (musicTrack) {
      if (!identity.can('*', 'author')) toast.error('Your account cannot manage the music queue.');
      else { mediaMusicTrack.value = musicTrack; mediaMusicOpen.value = true; }
      const { music: _music, ...query } = route.query;
      await router.replace({ path: '/', query: { ...query, returnTo: mediaReturn.value ?? '/media' } });
      return;
    }
    const targetChannel = channelId ? content.channels.find(item => item.id === channelId)
      : content.channels.find(item => item.playlistId === playlistId);
    const targetPlaylist = content.playlists.find(item => item.id === (targetChannel?.playlistId ?? playlistId));
    if ((channelId && !targetChannel) || !targetPlaylist) toast.error('This presentation is no longer available. Refresh its usage in Media.');
    else if (!identity.can(targetChannel?.id ?? '*', 'author')) toast.error('Your account cannot edit this presentation.');
    else if (targetChannel && presence.controlledByOther(targetChannel.id)) toast.info('Another operator controls this channel. Take control before editing its image.');
    else {
      if (targetChannel) engines.focusChannel(targetChannel.id);
      const item = slideId ? targetPlaylist.items.find(item => item.id === slideId) : null;
      if (slideId && !item) toast.error('This slide is no longer available. Refresh its usage in Media.');
      else if (item) {
        mediaEditItem.value = item;
        mediaEditDestination.value = { playlistId: targetPlaylist.id, channelId: targetChannel?.id ?? null };
        mediaEditOpen.value = true;
      }
    }
    const { channel: _channel, playlist: _playlist, slide: _slide, ...query } = route.query;
    await router.replace({ path: '/', query: { ...query, returnTo: mediaReturn.value ?? '/media' } });
  } finally { resolvingMediaLocation = false; }
}
watch([() => route.fullPath, contentReady, () => identity.ready], () => { void openMediaLocation(); }, { immediate: true, flush: 'post' });
async function saveMediaEdit(item: Item) {
  const destination = mediaEditDestination.value;
  if (!destination || !identity.can(destination.channelId ?? '*', 'author') ||
    (destination.channelId && presence.controlledByOther(destination.channelId))) return;
  if (!content.playlists.find(playlist => playlist.id === destination.playlistId)?.items.some(slide => slide.id === item.id)) {
    toast.error('This slide was removed while it was open.'); return;
  }
  await content.updateItem(destination.playlistId, item.id, item);
}

function claimFocused() {
  const id = engines.focusedChannelId;
  if (id && identity.isAuthenticated) presence.claim(id);
}

// Claim soft ownership of whatever channel the operator is focused on. Switching
// focus moves the claim; another operator can take it over.
watch(() => engines.focusedChannelId, claimFocused, { immediate: true });

// Re-assert the claim when the socket reconnects (e.g. after a station restart),
// since server-side ownership may have been lost.
watch(connection, (status) => {
  if (status === 'online') claimFocused();
});
</script>

<template>
  <LoginGate v-if="identity.ready && !identity.isAuthenticated" />
  <WorkspaceSkeleton v-else-if="!identity.ready || openingContent" />
  <div v-else-if="identity.isAuthenticated" class="lumen-shell">
    <WorkspaceHeader class="lumen-header-channel">
      <div v-if="mediaReturn" class="lumen-channel-actions">
        <RouterLink v-if="mediaReturn" :to="mediaReturn" class="media-return-link"><ArrowLeft :size="14" />Back to Media</RouterLink>
      </div>
    </WorkspaceHeader>
    <main class="lumen-main">
      <WorshipView v-if="isWorshipChannel && channel" :key="channel.id" :channel="channel" />
      <ChannelView v-else />
    </main>
    <ChannelNav />
    <EditItemDialog v-model:open="mediaEditOpen" :item="mediaEditItem" @save="saveMediaEdit" />
    <MediaMusicQueueDialog v-model:open="mediaMusicOpen" :track="mediaMusicTrack" />
  </div>
</template>

<style scoped>
.media-return-link { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); white-space: nowrap; font-size: 12px; }
.media-return-link:hover { text-decoration: underline; }
</style>
