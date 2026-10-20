import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

/** @typedef {{ DEPLOYMENT_ENV?: string, SUPABASE_URL?: string, ALLOWED_ORIGINS?: string }} Env */
/** @typedef {import('jose').JWTVerifyGetKey} KeySet */
/** @typedef {{ getKeySet?: (issuer: string) => KeySet }} Options */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {Env} env */
export function readConfig(env) {
  if (!['staging', 'production'].includes(env.DEPLOYMENT_ENV ?? '')) {
    throw new Error('Missing deployment environment');
  }
  const url = new URL(env.SUPABASE_URL ?? '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Supabase must be an HTTPS origin');
  }
  const origins = (env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    const local = env.DEPLOYMENT_ENV === 'staging' &&
      ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.protocol === 'http:';
    if (origin !== parsed.origin || parsed.username || parsed.password ||
        (!local && parsed.protocol !== 'https:')) {
      throw new Error('Invalid allowed origin');
    }
  }
  return { environment: env.DEPLOYMENT_ENV, issuer: `${url.origin}/auth/v1`, origins };
}

/** @param {Options} [options] */
export function createWorker(options = {}) {
  /** @type {{ issuer: string, keys: KeySet } | undefined} */
  let cached;
  /** @param {string} issuer @returns {KeySet} */
  const getKeySet = options.getKeySet ?? (issuer => {
    if (cached?.issuer !== issuer) {
      cached = {
        issuer,
        keys: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
          timeoutDuration: 4000,
          cooldownDuration: 30000,
          cacheMaxAge: 600000,
        }),
      };
    }
    return cached.keys;
  });

  return {
    /** @param {Request} request @param {Env} env */
    async fetch(request, env) {
      const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Vary': 'Origin',
      });
      /** @param {unknown} body @param {number} [status] */
      const json = (body, status = 200) => new Response(
        request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers },
      );
      let config;
      try { config = readConfig(env); }
      catch { return json({ error: 'cloud_not_configured' }, 503); }

      const origin = request.headers.get('Origin');
      if (origin) {
        if (!config.origins.includes(origin)) return json({ error: 'origin_not_allowed' }, 403);
        headers.set('Access-Control-Allow-Origin', origin);
      }
      const path = new URL(request.url).pathname;
      if (!['/healthz', '/api/session'].includes(path)) return json({ error: 'not_found' }, 404);
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('Access-Control-Request-Method');
        const requested = request.headers.get('Access-Control-Request-Headers') ?? '';
        if (!origin || !['GET', 'HEAD'].includes(method ?? '') ||
            requested.split(',').some(h => h.trim() && h.trim().toLowerCase() !== 'authorization')) {
          return json({ error: 'preflight_not_allowed' }, 403);
        }
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD');
        headers.set('Access-Control-Allow-Headers', 'Authorization');
        return new Response(null, { status: 204, headers });
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        headers.set('Allow', 'GET, HEAD, OPTIONS');
        return json({ error: 'method_not_allowed' }, 405);
      }
      if (path === '/healthz') {
        return json({ service: 'lumen-cloud', environment: config.environment, status: 'ok',
          capabilities: { identity: true, collaboration: false, sync: false, productionControl: false } });
      }
      headers.set('WWW-Authenticate', 'Bearer');
      const authorization = request.headers.get('Authorization') ?? '';
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
      if (!match || authorization.length > 8192) return json({ error: 'unauthorized' }, 401);
      try {
        const { payload } = await jwtVerify(match[1], getKeySet(config.issuer), {
          issuer: config.issuer,
          audience: 'authenticated',
          algorithms: ['ES256', 'RS256'],
          requiredClaims: ['sub', 'exp', 'iat', 'session_id'],
          clockTolerance: 5,
        });
        if (payload.role !== 'authenticated' || payload.is_anonymous === true ||
            !UUID.test(payload.sub ?? '') || typeof payload.session_id !== 'string' ||
            !UUID.test(payload.session_id) || typeof payload.iat !== 'number' ||
            payload.iat > Date.now() / 1000 + 5) {
          return json({ error: 'unauthorized' }, 401);
        }
        headers.delete('WWW-Authenticate');
        // This proves identity only. Membership, revocation and capabilities must be
        // checked server-side before any future room, sync or production operation.
        return json({ user: { id: payload.sub }, environment: config.environment });
      } catch (error) {
        const unavailable = !(error instanceof errors.JOSEError) ||
          error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid ||
          error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC';
        return json({ error: unavailable ? 'identity_unavailable' : 'unauthorized' }, unavailable ? 503 : 401);
      }
    },
  };
}

export default createWorker();
