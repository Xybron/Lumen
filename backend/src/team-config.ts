import { Router } from 'express';

/** Public client configuration only. Never read a service-role or database key. */
export function teamConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.LUMEN_TEAM_LOCAL_TEST !== 'true') return { enabled: false as const };
  if (env.NODE_ENV === 'production') throw new Error('The isolated team test launcher is not a production authentication gateway.');
  const url = new URL(env.LUMEN_TEAM_SUPABASE_URL ?? 'https://xfppsgiothkvhndmbixx.supabase.co');
  const sync = new URL(env.LUMEN_TEAM_POWERSYNC_URL ?? 'http://127.0.0.1:8189');
  const publishableKey = env.LUMEN_TEAM_PUBLISHABLE_KEY ?? 'sb_publishable_4jSgOWLWJviBajnzSGg_OA_LxsZXa9a';
  if (url.origin !== 'https://xfppsgiothkvhndmbixx.supabase.co' || url.href !== `${url.origin}/` || !publishableKey.startsWith('sb_publishable_')) throw new Error('Team rehearsal requires LAB and a public publishable key.');
  if (sync.protocol !== 'http:' || sync.hostname !== '127.0.0.1' || sync.username || sync.password || sync.pathname !== '/' || sync.search || sync.hash) throw new Error('Local PowerSync must use a literal loopback origin.');
  return { enabled: true as const, supabaseUrl: url.origin, publishableKey, powerSyncUrl: sync.origin, projectRef: 'xfppsgiothkvhndmbixx', isolated: true };
}

export function createTeamConfigRouter() {
  const router = Router();
  const config = teamConfiguration();
  router.get('/team/config', (_req, res) => { res.set('Cache-Control', 'no-store').json(config); });
  return router;
}
