import { Router } from 'express';
import {
  login,
  logout,
  readSession,
  grantsFor,
  parseCookie,
  createUser,
  setGrant,
  listUsers,
  updatePassword,
  requireAdmin,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from './auth.js';

// Identity endpoints. Mounted under /api alongside the content router.
export const identityRouter = Router();

identityRouter.post('/auth/login', (req, res) => {
  const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'bad request' });
  }
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: 'invalid credentials' });
  res.cookie(SESSION_COOKIE, result.sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ user: result.user, grants: grantsFor(result.user) });
});

identityRouter.post('/auth/logout', (req, res) => {
  const sid = parseCookie(req.headers.cookie, SESSION_COOKIE);
  if (sid) logout(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

identityRouter.get('/auth/me', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ user, grants: grantsFor(user) });
});

// ── User management (admin only) ─────────────────────────────────────────────
identityRouter.get('/users', requireAdmin, (_req, res) => {
  res.json({ users: listUsers() });
});

identityRouter.post('/users', requireAdmin, (req, res) => {
  const { username, displayName, password, isAdmin } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string' || username.length < 2 || password.length < 4) {
    return res.status(400).json({ error: 'username (≥2) and password (≥4) required' });
  }
  const user = createUser(
    username,
    typeof displayName === 'string' && displayName ? displayName : username,
    password,
    isAdmin === true,
  );
  if (!user) return res.status(409).json({ error: 'username taken' });
  res.json({ user });
});

// Change your own password (any signed-in user).
identityRouter.post('/auth/password', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  const { password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'password (≥4) required' });
  }
  updatePassword(user.id, password);
  res.json({ ok: true });
});

// Admin: reset any user's password.
identityRouter.post('/users/:id/password', requireAdmin, (req, res) => {
  const { password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'password (≥4) required' });
  }
  if (!updatePassword(String(req.params.id), password)) return res.status(404).json({ error: 'user not found' });
  res.json({ ok: true });
});

identityRouter.post('/users/:id/grants', requireAdmin, (req, res) => {
  const { channelId, role } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof channelId !== 'string' || (role !== 'owner' && role !== 'author' && role !== 'viewer')) {
    return res.status(400).json({ error: 'channelId and role (owner|author|viewer) required' });
  }
  setGrant(String(req.params.id), channelId, role);
  res.json({ ok: true });
});
