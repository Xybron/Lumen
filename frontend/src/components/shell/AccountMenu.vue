<script setup lang="ts">
import { ref } from 'vue';
import { ChevronDown, ChevronUp, Cpu, FileArchive, LogOut, Shield } from 'lucide-vue-next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useIdentityStore } from '@/stores/identity';
import { useConfirmation } from '@/composables/useConfirmation';
import DataTransferDialog from '@/components/data-transfer/DataTransferDialog.vue';
import UsersDialog from './UsersDialog.vue';
import AgentManagerDialog from './AgentManagerDialog.vue';

withDefaults(defineProps<{ placement?: 'dock' | 'header' }>(), { placement: 'dock' });
const identity = useIdentityStore();
const { confirmAction } = useConfirmation();
const usersOpen = ref(false), agentsOpen = ref(false), transferOpen = ref(false);

async function signOut() {
  const userId = identity.me?.id;
  if (!userId || !await confirmAction({
    title: 'Sign out?',
    description: 'You will need to sign in again to control this station.',
    confirmLabel: 'Sign out',
  })) return;
  if (identity.me?.id === userId) await identity.logout();
}
</script>

<template>
  <DropdownMenu v-if="identity.me">
    <DropdownMenuTrigger as-child>
      <button type="button" class="account-trigger" :class="`account-trigger-${placement}`" :title="`Signed in as ${identity.me.displayName}`" :aria-label="`Account menu for ${identity.me.displayName}`">
        <img src="/images/lumen-profile-abstract.png" alt="" class="account-avatar" width="28" height="28" />
        <ChevronUp v-if="placement === 'dock'" :size="13" class="account-chevron" /><ChevronDown v-else :size="13" class="account-chevron" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" :side="placement === 'dock' ? 'top' : 'bottom'" :side-offset="8" class="w-48">
      <div class="px-2 py-1.5 text-xs text-white/50 truncate">{{ identity.me.displayName }}</div>
      <DropdownMenuSeparator />
      <DropdownMenuItem v-if="identity.can('*', 'author')" @select="transferOpen = true"><FileArchive :size="13" /> Data settings</DropdownMenuItem>
      <DropdownMenuItem v-if="identity.me.isAdmin" @select="usersOpen = true"><Shield :size="13" /> Team &amp; roles</DropdownMenuItem>
      <DropdownMenuItem v-if="identity.me.isAdmin" @select="agentsOpen = true"><Cpu :size="13" /> Capture agents</DropdownMenuItem>
      <DropdownMenuItem @select="signOut"><LogOut :size="13" /> Sign out</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
  <UsersDialog v-model:open="usersOpen" />
  <AgentManagerDialog v-model:open="agentsOpen" />
  <DataTransferDialog v-if="identity.can('*', 'author')" v-model:open="transferOpen" />
</template>

<style scoped>
.account-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;height:38px;padding:0 7px;border-radius:7px;color:var(--text-muted);background:transparent;cursor:pointer}
.account-trigger-header{height:36px;padding:3px 5px;border:1px solid var(--border-hair)}
.account-trigger:hover{color:var(--text-primary);background:#ffffff0a}.account-trigger:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.account-avatar{width:28px;height:28px;object-fit:cover;border-radius:50%;border:1px solid #ffffff20;background:var(--accent-soft)}.account-chevron{opacity:.6}
</style>
