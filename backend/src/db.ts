import Database from 'better-sqlite3';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './paths.js';
import { hashPassword } from './pw.js';

// SQLite holds IDENTITY + OPS state only (users, sessions, roles, presence
// ownership). The deck content stays in content.json — this DB never touches it.
// It is the LOCAL authority: auth never depends on the VPS, so the station keeps
// working (login, role checks) even when the VPS is unreachable.

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  pw_hash      TEXT NOT NULL,
  pw_salt      TEXT NOT NULL,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

-- Per-channel role grant; channel_id '*' means all channels.
CREATE TABLE IF NOT EXISTS role_grants (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

-- Soft-ownership snapshot for presence/takeover crash recovery (Step 6).
CREATE TABLE IF NOT EXISTS channel_ownership (
  channel_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  soft       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ops_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  user_id    TEXT,
  channel_id TEXT,
  action     TEXT,
  detail     TEXT
);

-- Capture agents (pro SDI/HDMI/NDI inputs). Operational state, never in
-- content.json (it churns). The token is hashed like a user password.
CREATE TABLE IF NOT EXISTS capture_agents (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_salt TEXT NOT NULL,
  platform   TEXT,
  version    TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT,
  status     TEXT NOT NULL DEFAULT 'offline'
);

CREATE TABLE IF NOT EXISTS capture_inputs (
  agent_id   TEXT NOT NULL,
  input_id   TEXT NOT NULL,
  label      TEXT,
  signal     TEXT,
  transport  TEXT,
  uri        TEXT,
  state      TEXT NOT NULL DEFAULT 'idle',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, input_id)
);

-- RTMP egress targets. The stream_key is a SECRET and lives ONLY here (never in
-- content.json, which has a public GET). Joined to Content.destinations[] by id.
CREATE TABLE IF NOT EXISTS stream_targets (
  destination_id TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,
  rtmp_url       TEXT NOT NULL,
  stream_key     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Phone/contributor uploads awaiting operator approval. The file sits in
-- media/incoming/ until approved (moved to media/<target_kind>/) or rejected.
CREATE TABLE IF NOT EXISTS media_staging (
  id          TEXT PRIMARY KEY,        -- stg_xxxxxx
  filename    TEXT NOT NULL,           -- on-disk name in media/incoming/
  orig_name   TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER,
  target_kind TEXT NOT NULL,           -- 'backgrounds' | 'music'
  contributor TEXT,                    -- free-text name from the phone form
  thumbnail   TEXT,                    -- rel path if generated
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  decided_by  TEXT
);
`;

export function initDb(): Database.Database {
  const instance = new Database(path.join(DATA_DIR, 'lumen.db'));
  instance.pragma('journal_mode = WAL');
  instance.exec(SCHEMA);
  if (!instance.prepare('SELECT version FROM schema_version LIMIT 1').get()) {
    instance.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  }
  db = instance;
  seedAdmin();
  return instance;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('db not initialized — call initDb() first');
  return db;
}

// On a fresh DB, seed a local admin so the operator can log in immediately.
function seedAdmin() {
  const { c } = getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (c > 0) return;
  const { hash, salt } = hashPassword('admin');
  getDb()
    .prepare(
      'INSERT INTO users (id, username, display_name, pw_hash, pw_salt, is_admin, created_at) VALUES (?,?,?,?,?,1,?)',
    )
    .run(`usr_${randomBytes(5).toString('hex')}`, 'admin', 'Administrator', hash, salt, new Date().toISOString());
  console.log('\n  ┌──────────────────────────────────────────────────┐');
  console.log('  │  Lumen: seeded default admin account               │');
  console.log('  │    username: admin     password: admin             │');
  console.log('  │  Change the password after first login.            │');
  console.log('  └──────────────────────────────────────────────────┘\n');
}
