<script setup lang="ts">
// The operator shell. Gates the authoring surface behind sign-in (Live outputs
// at /live/:channelId stay public, read-only mirrors). Engines live app-level in
// the registry, so switching the focused channel never interrupts the others.
import { computed, onMounted, watch } from 'vue';
import LiveViewButton from '@/components/shell/LiveViewButton.vue';
import BroadcastButton from '@/components/broadcast/BroadcastButton.vue';
import { useIdentityStore } from '@/stores/identity';
import { useEnginesStore } from '@/stores/engines';
import { usePresenceStore } from '@/stores/presence';
import { useConnection } from '@/lib/ws';
import ChannelView from '@/views/ChannelView.vue';
import ChannelNav from '@/components/shell/ChannelNav.vue';
import LoginGate from '@/components/shell/LoginGate.vue';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';
import WorshipView from '@/views/WorshipView.vue';
import { useContentStore } from '@/stores/content';
import '@/styles/workspaces.css';

const identity = useIdentityStore();
const engines = useEnginesStore();
const presence = usePresenceStore();
const connection = useConnection();
const content = useContentStore();
const channel = computed(() => content.channels.find(c => c.id === engines.focusedChannelId));
const isWorshipChannel = computed(() => !!channel.value && ['scripture', 'lyrics'].includes(channel.value.kind));

onMounted(async () => { await identity.load(); if(identity.isAuthenticated) await content.load(); });
watch(() => identity.isAuthenticated, value => { if(value) void content.load(); });

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
  <div v-else-if="identity.isAuthenticated" class="lumen-shell">
    <WorkspaceHeader class="lumen-header-channel">
      <div class="lumen-channel-actions">
        <span v-if="isWorshipChannel" class="w-offline"><span />Offline library</span>
        <BroadcastButton />
        <LiveViewButton class="ml-auto shrink-0" title="Open final Program live view" />
      </div>
    </WorkspaceHeader>
    <main class="lumen-main">
      <WorshipView v-if="isWorshipChannel && channel" :key="channel.id" :channel="channel" />
      <ChannelView v-else />
    </main>
    <ChannelNav />
  </div>
  <div
    v-else
    class="h-screen w-screen bg-base flex items-center justify-center text-white/40 text-sm tracking-display"
  >
    Loading…
  </div>
</template>
