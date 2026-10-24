<script setup lang="ts">
import { ref } from 'vue';
import { UsersRound, Trash2, Loader2 } from 'lucide-vue-next';
import { useTeamStore } from '@/stores/team';
import { useConfirmation } from '@/composables/useConfirmation';

const team = useTeamStore(), { confirmAction } = useConfirmation();
const working = ref<string | null>(null), error = ref(''), notice = ref('');
function label(member: { user_id: string; name?: string }) { return member.name || (member.user_id === team.user?.id ? team.profileName || 'You' : `Teammate · ${member.user_id.slice(0, 8)}`); }
async function change(member: { user_id: string; role: string; name?: string }, nextRole: 'owner' | 'editor' | 'viewer' | null, element?: HTMLSelectElement) {
  if (working.value || team.role !== 'owner' || nextRole === member.role) return;
  error.value = ''; notice.value = '';
  const previous = member.role, teamId = team.teamId;
  const accepted = await confirmAction({
    title: nextRole === null ? 'Remove this teammate?' : 'Change team access?',
    description: nextRole === null ? `${label(member)} will lose access to this workspace. Offline copies already saved on their device cannot be remotely erased. Station operator permissions are separate.` : `${label(member)} will become an ${nextRole}. This affects shared preparation only, not local live controls.`,
    confirmLabel: nextRole === null ? 'Remove access' : 'Change access', tone: nextRole === null ? 'danger' : 'default',
  });
  if (!accepted || team.role !== 'owner' || team.teamId !== teamId || !team.members.some(item => item.user_id === member.user_id && item.role === previous)) { if (element) element.value = previous; return; }
  working.value = member.user_id;
  try { await team.setMemberRole(member.user_id, nextRole); notice.value = nextRole === null ? 'Team access removed.' : 'Team access updated.'; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Team access could not be updated.'; if (element) element.value = previous; }
  finally { working.value = null; }
}
function changeFromEvent(member: { user_id: string; role: string; name?: string }, event: Event) { const element = event.target as HTMLSelectElement; const value = element.value; if (value === 'owner' || value === 'editor' || value === 'viewer') void change(member, value, element); }
</script>

<template>
  <section class="team-members" aria-label="Team access">
    <h3><UsersRound :size="15" />Team access<span>{{ team.members.length }}</span></h3>
    <p>Owners manage membership. Editors prepare drafts; viewers can read them. The last owner cannot be removed.</p>
    <div class="team-members-list"><div v-for="member in team.members" :key="member.user_id" class="team-member"><span><b>{{ label(member) }}</b><small v-if="member.user_id === team.user?.id">You</small></span><select :value="member.role" :aria-label="`Access for ${label(member)}`" :disabled="!!working || team.role !== 'owner'" @change="changeFromEvent(member, $event)"><option value="owner">Owner</option><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button type="button" class="team-icon-button danger" :disabled="!!working || team.role !== 'owner'" :aria-label="`Remove ${label(member)} from team`" @click="change(member, null)"><Loader2 v-if="working === member.user_id" :size="14" class="team-spinner" /><Trash2 v-else :size="14" /></button></div></div>
    <p v-if="error" class="team-error" role="alert">{{ error }}</p><p v-if="notice" class="team-notice" role="status">{{ notice }}</p>
  </section>
</template>
