<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { useTeamStore } from '@/stores/team';
import TeamPresenceOverlay from './TeamPresenceOverlay.vue';
const team = useTeamStore();
let mounted = false;
onMounted(() => {
  mounted = true;
  void team.init().then(() => { if (mounted) team.resumePresence(); });
});
onBeforeUnmount(() => { mounted = false; team.suspendPresence(); });
</script>

<template><TeamPresenceOverlay v-if="team.enabled && team.user" /></template>
