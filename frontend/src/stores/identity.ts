import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/lib/api';
import type { Perm } from '@/lib/perm';
import { PERM_MIN, ROLE_RANK } from '@/lib/perm';
import type { RoleGrant, User } from '@/types';

const CACHE_KEY = 'lumen.identity';

function cachedUser(): User | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export const useIdentityStore = defineStore('identity', () => {
  // Seed from cache so the UI doesn't flash logged-out on a slow/offline boot.
  const me = ref<User | null>(cachedUser());
  const grants = ref<RoleGrant[]>([]);
  const ready = ref(false);

  function persist(user: User | null) {
    try {
      if (user) localStorage.setItem(CACHE_KEY, JSON.stringify(user));
      else localStorage.removeItem(CACHE_KEY);
    } catch {
      /* private mode / quota — fine to swallow */
    }
  }

  async function load() {
    try {
      const data = await api.me();
      if (data) {
        me.value = data.user;
        grants.value = data.grants;
        persist(data.user);
      } else {
        // Explicit 401 — definitely signed out. Clear the cache.
        me.value = null;
        grants.value = [];
        persist(null);
      }
    } catch {
      // Network/station error — keep the cached user so the operator UI stays
      // usable (offline tolerance). The local backend re-validates on next call.
    } finally {
      ready.value = true;
    }
  }

  async function login(username: string, password: string) {
    const data = await api.login(username, password);
    me.value = data.user;
    grants.value = data.grants;
    persist(data.user);
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      me.value = null;
      grants.value = [];
      persist(null);
    }
  }

  const isAuthenticated = computed(() => me.value !== null);

  // Client-side permission check (mirrors backend auth.ts). The server still
  // enforces; this is for disabling/hiding controls the user can't use.
  function can(channelId: string, perm: Perm): boolean {
    if (me.value?.isAdmin) return true;
    let best = -1;
    for (const g of grants.value) {
      if (g.channelId === channelId || g.channelId === '*') best = Math.max(best, ROLE_RANK[g.role] ?? -1);
    }
    return best >= PERM_MIN[perm];
  }

  return { me, grants, ready, isAuthenticated, load, login, logout, can };
});
