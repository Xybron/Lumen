<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { UsersRound } from 'lucide-vue-next';
import { useTeamStore } from '@/stores/team';

const team = useTeamStore();
const route = useRoute();
const label = computed(() => team.user ? 'Team workspace' : 'Connect your team');
</script>

<template>
  <RouterLink v-if="team.enabled && route.name !== 'team'" to="/team" class="team-header-button" :title="label" :aria-label="label">
    <UsersRound :size="15" />
    <span>Team</span>
    <span v-if="team.pendingCount" class="team-header-count" :aria-label="`${team.pendingCount} changes waiting to sync`">{{ team.pendingCount }}</span>
  </RouterLink>
</template>

<style scoped>
.team-header-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:32px;padding:7px 10px;border:1px solid var(--border-hair);border-radius:7px;background:transparent;color:var(--text-muted);font-size:11px;white-space:nowrap;text-decoration:none}
.team-header-button:hover{background:var(--bg-hover);color:var(--text-primary)}
.team-header-button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.team-header-count{padding:1px 4px;min-width:16px;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-size:9px;text-align:center}
</style>
