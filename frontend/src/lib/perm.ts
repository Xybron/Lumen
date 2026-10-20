import type { Role } from '@/types';

// Permission math, shared by the identity store (and later presence/role UIs).
// Mirrors backend auth.ts: owner ⊃ author ⊃ viewer.
export type Perm = 'view' | 'author' | 'owner';

export const ROLE_RANK: Record<Role, number> = { viewer: 0, author: 1, owner: 2 };
export const PERM_MIN: Record<Perm, number> = { view: 0, author: 1, owner: 2 };
