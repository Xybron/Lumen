import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { getDb } from './db.js';
import { hashPassword, verifyPassword } from './pw.js';

export const SESSION_COOKIE = 'lumen_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export type Perm = 'view' | 'author' | 'owner';

// role rank → the permissions it satisfies. owner ⊃ author ⊃ viewer.
const ROLE_RANK: Record<string, number> = { viewer: 0, author: 1, owner: 2 };
const PERM_MIN: Record<Perm, number> = { view: 0, author: 1, owner: 2 };

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  pw_hash: string;
  pw_salt: string;
  is_admin: number;
}

function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, username: row.username, displayName: row.display_name, isAdmin: !!row.is_admin };
}

export function login(username: string, password: string): { sessionId: string; user: SessionUser } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!row || !verifyPassword(password, row.pw_hash, row.pw_salt)) return null;
  const sessionId = `sess_${randomBytes(24).toString('hex')}`;
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen) VALUES (?,?,?,?,?)',
  ).run(sessionId, row.id, now.toISOString(), exp.toISOString(), now.toISOString());
  return { sessionId, user: toSessionUser(row) };
}

export function logout(sessionId: string) {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// Resolve a session id to its user, sliding the expiry's last_seen. Expired
// sessions are deleted. This is the LOCAL authority — no network involved.
export function sessionUser(sessionId: string | undefined): SessionUser | null {
  if (!sessionId) return null;
  const db = getDb();
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | { id: string; user_id: string; expires_at: string }
    | undefined;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) as UserRow | undefined;
  return u ? toSessionUser(u) : null;
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function readSession(req: Request): SessionUser | null {
  return sessionUser(parseCookie(req.headers.cookie, SESSION_COOKIE));
}

// Resolve a user from a raw Cookie header — used to authenticate WebSocket
// connections from their upgrade request (the httpOnly cookie rides along
// automatically; the browser JS never has to read it).
export function userFromCookieHeader(cookieHeader: string | undefined): SessionUser | null {
  return sessionUser(parseCookie(cookieHeader, SESSION_COOKIE));
}

// Express middleware: 401 unless a valid session is present. Attaches the user.
export function requireSession(req: Request, res: Response, next: NextFunction) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  (req as Request & { user?: SessionUser }).user = user;
  next();
}

export function userCan(user: SessionUser, channelId: string, perm: Perm): boolean {
  if (user.isAdmin) return true;
  const rows = getDb()
    .prepare('SELECT role FROM role_grants WHERE user_id = ? AND (channel_id = ? OR channel_id = ?)')
    .all(user.id, channelId, '*') as Array<{ role: string }>;
  let best = -1;
  for (const r of rows) best = Math.max(best, ROLE_RANK[r.role] ?? -1);
  return best >= PERM_MIN[perm];
}

export function grantsFor(user: SessionUser): Array<{ channelId: string; role: string }> {
  if (user.isAdmin) return [{ channelId: '*', role: 'owner' }];
  return getDb()
    .prepare('SELECT channel_id AS channelId, role FROM role_grants WHERE user_id = ?')
    .all(user.id) as Array<{ channelId: string; role: string }>;
}

// ── User management (admin) ──────────────────────────────────────────────────
export function createUser(
  username: string,
  displayName: string,
  password: string,
  isAdmin = false,
): SessionUser | null {
  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return null; // taken
  const { hash, salt } = hashPassword(password);
  const id = `usr_${randomBytes(5).toString('hex')}`;
  db.prepare(
    'INSERT INTO users (id, username, display_name, pw_hash, pw_salt, is_admin, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(id, username, displayName, hash, salt, isAdmin ? 1 : 0, new Date().toISOString());
  return { id, username, displayName, isAdmin };
}

export function updatePassword(userId: string, newPassword: string): boolean {
  const { hash, salt } = hashPassword(newPassword);
  const r = getDb().prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(hash, salt, userId);
  return r.changes > 0;
}

export function setGrant(userId: string, channelId: string, role: string) {
  getDb()
    .prepare(
      'INSERT INTO role_grants (user_id, channel_id, role) VALUES (?,?,?) ' +
        'ON CONFLICT(user_id, channel_id) DO UPDATE SET role = excluded.role',
    )
    .run(userId, channelId, role);
}

export function listUsers(): Array<SessionUser & { grants: Array<{ channelId: string; role: string }> }> {
  const rows = getDb()
    .prepare('SELECT id, username, display_name, is_admin FROM users ORDER BY created_at')
    .all() as Array<{ id: string; username: string; display_name: string; is_admin: number }>;
  return rows.map((r) => {
    const u: SessionUser = { id: r.id, username: r.username, displayName: r.display_name, isAdmin: !!r.is_admin };
    return { ...u, grants: grantsFor(u) };
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  if (!user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  (req as Request & { user?: SessionUser }).user = user;
  next();
}
