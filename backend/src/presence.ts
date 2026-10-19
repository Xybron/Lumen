import { getDb } from './db.js';

// Channel ownership persistence. Ownership is "soft": a controller holds a
// channel until they release it or someone takes over. Persisting to SQLite lets
// ownership survive a station restart / crash (the in-memory map is rehydrated
// from here on boot).

export function loadOwners(): Record<string, string> {
  const rows = getDb().prepare('SELECT channel_id, user_id FROM channel_ownership').all() as Array<{
    channel_id: string;
    user_id: string;
  }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.channel_id] = r.user_id;
  return out;
}

export function saveOwner(channelId: string, userId: string) {
  getDb()
    .prepare(
      'INSERT INTO channel_ownership (channel_id, user_id, claimed_at, soft) VALUES (?,?,?,1) ' +
        'ON CONFLICT(channel_id) DO UPDATE SET user_id = excluded.user_id, claimed_at = excluded.claimed_at',
    )
    .run(channelId, userId, new Date().toISOString());
}
