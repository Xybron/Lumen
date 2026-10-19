<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { UserPlus, Shield, Loader2 } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, type AdminUser } from '@/lib/api';
import { useContentStore } from '@/stores/content';
import type { Role } from '@/types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

const content = useContentStore();
const users = ref<AdminUser[]>([]);
const loading = ref(false);

// channel options for grants: every channel + the "*" wildcard.
const channelOptions = computed(() => [
  { id: '*', name: 'All channels' },
  ...content.channels.map((c) => ({ id: c.id, name: c.name })),
]);

async function refresh() {
  loading.value = true;
  try {
    users.value = (await api.listUsers()).users;
  } catch (e) {
    toast.error(`Couldn't load users: ${(e as Error).message}`);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void refresh();
  },
);

// ── Create user ──
const draft = ref({ username: '', displayName: '', password: '', isAdmin: false });
const creating = ref(false);
async function createUser() {
  if (!draft.value.username.trim() || draft.value.password.length < 4) {
    toast.error('Username and a password of at least 4 characters are required.');
    return;
  }
  creating.value = true;
  try {
    await api.createUser({
      username: draft.value.username.trim(),
      password: draft.value.password,
      displayName: draft.value.displayName.trim() || undefined,
      isAdmin: draft.value.isAdmin,
    });
    draft.value = { username: '', displayName: '', password: '', isAdmin: false };
    await refresh();
    toast.success('User created');
  } catch (e) {
    toast.error(`Create failed: ${(e as Error).message}`);
  } finally {
    creating.value = false;
  }
}

// ── Grant a role ──
const grantDrafts = ref<Record<string, { channelId: string; role: Role }>>({});
function grantDraftFor(userId: string) {
  if (!grantDrafts.value[userId]) {
    grantDrafts.value[userId] = { channelId: channelOptions.value[0]?.id ?? '*', role: 'author' };
  }
  return grantDrafts.value[userId];
}
async function assignGrant(userId: string) {
  const d = grantDraftFor(userId);
  try {
    await api.setGrant(userId, d.channelId, d.role);
    await refresh();
    toast.success('Role assigned');
  } catch (e) {
    toast.error(`Grant failed: ${(e as Error).message}`);
  }
}

// ── Reset a password (admin) — lets the default admin/admin be changed ──
const pwDrafts = ref<Record<string, string>>({});
async function resetPassword(userId: string) {
  const pw = pwDrafts.value[userId];
  if (!pw || pw.length < 4) return toast.error('Password must be at least 4 characters');
  try {
    await api.setUserPassword(userId, pw);
    pwDrafts.value[userId] = '';
    toast.success('Password reset');
  } catch (e) {
    toast.error(`Reset failed: ${(e as Error).message}`);
  }
}

function channelName(id: string) {
  return id === '*' ? 'All channels' : content.channels.find((c) => c.id === id)?.name ?? id;
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Shield :size="16" class="text-accent" /> Team &amp; roles
        </DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-4 max-h-[70vh] overflow-y-auto -mx-1 px-1">
        <!-- create -->
        <form class="panel-soft p-3 grid grid-cols-2 gap-2" @submit.prevent="createUser">
          <div class="col-span-2 text-[11px] uppercase tracking-[0.12em] text-white/40 font-medium">
            Add teammate
          </div>
          <input
            v-model="draft.username"
            placeholder="Username"
            autocomplete="off"
            class="h-9 rounded-lg bg-white/[0.05] border border-hair px-2.5 text-sm text-white outline-none focus:border-accent/60"
          />
          <input
            v-model="draft.displayName"
            placeholder="Display name (optional)"
            class="h-9 rounded-lg bg-white/[0.05] border border-hair px-2.5 text-sm text-white outline-none focus:border-accent/60"
          />
          <input
            v-model="draft.password"
            type="password"
            placeholder="Password"
            autocomplete="new-password"
            class="h-9 rounded-lg bg-white/[0.05] border border-hair px-2.5 text-sm text-white outline-none focus:border-accent/60"
          />
          <div class="flex items-center gap-3">
            <label class="flex items-center gap-1.5 text-xs text-white/65 select-none">
              <input v-model="draft.isAdmin" type="checkbox" class="accent-accent" /> Admin
            </label>
            <Button type="submit" variant="accent" size="md" :disabled="creating" class="ml-auto">
              <Loader2 v-if="creating" :size="13" class="animate-spin" />
              <UserPlus v-else :size="13" />
              Add
            </Button>
          </div>
        </form>

        <!-- list -->
        <div v-if="loading" class="text-sm text-white/45 px-1 py-4 flex items-center gap-2">
          <Loader2 :size="14" class="animate-spin" /> Loading…
        </div>
        <ul v-else class="flex flex-col gap-2">
          <li v-for="u in users" :key="u.id" class="panel-soft p-3 flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <span class="h-7 w-7 rounded-full bg-accent/15 text-accent text-xs font-semibold flex items-center justify-center uppercase">
                {{ u.displayName.charAt(0) }}
              </span>
              <div class="min-w-0">
                <div class="text-sm font-medium text-white truncate">
                  {{ u.displayName }}
                  <span v-if="u.isAdmin" class="ml-1 text-[10px] uppercase tracking-wide text-accent">admin</span>
                </div>
                <div class="text-xs text-white/45">@{{ u.username }}</div>
              </div>
            </div>

            <div v-if="!u.isAdmin" class="flex flex-wrap items-center gap-1.5">
              <span
                v-for="g in u.grants"
                :key="g.channelId + g.role"
                class="text-[11px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/70 border border-hair"
              >
                {{ channelName(g.channelId) }}: <span class="text-accent">{{ g.role }}</span>
              </span>
              <span v-if="u.grants.length === 0" class="text-[11px] text-white/35">no roles yet</span>
            </div>
            <div v-else class="text-[11px] text-white/35">Full access (admin)</div>

            <!-- grant editor -->
            <div v-if="!u.isAdmin" class="flex items-center gap-1.5">
              <select
                :value="grantDraftFor(u.id).channelId"
                class="h-8 rounded-lg bg-white/[0.05] border border-hair px-2 text-xs text-white outline-none focus:border-accent/60"
                @change="grantDraftFor(u.id).channelId = ($event.target as HTMLSelectElement).value"
              >
                <option v-for="c in channelOptions" :key="c.id" :value="c.id" class="bg-base">{{ c.name }}</option>
              </select>
              <select
                :value="grantDraftFor(u.id).role"
                class="h-8 rounded-lg bg-white/[0.05] border border-hair px-2 text-xs text-white outline-none focus:border-accent/60"
                @change="grantDraftFor(u.id).role = ($event.target as HTMLSelectElement).value as Role"
              >
                <option value="owner" class="bg-base">owner</option>
                <option value="author" class="bg-base">author</option>
                <option value="viewer" class="bg-base">viewer</option>
              </select>
              <Button variant="default" size="md" @click="assignGrant(u.id)">Assign</Button>
            </div>

            <!-- password reset (admin) -->
            <div class="flex items-center gap-1.5">
              <input
                :value="pwDrafts[u.id] ?? ''"
                type="password"
                placeholder="New password…"
                class="flex-1 h-8 rounded-lg bg-white/[0.05] border border-hair px-2 text-xs text-white outline-none focus:border-accent/60"
                @input="pwDrafts[u.id] = ($event.target as HTMLInputElement).value"
              />
              <Button variant="ghost" size="md" @click="resetPassword(u.id)">Reset password</Button>
            </div>
          </li>
        </ul>
      </div>
    </DialogContent>
  </Dialog>
</template>
