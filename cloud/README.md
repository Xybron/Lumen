# Lumen cloud foundation

Isolated, binding-free Cloudflare Worker for **staging**, connected only to LAB's
public Auth signing keys. This is not the Studio application or finished cloud
collaboration. It never reads or writes the station's scenes, keys, Main audio,
recordings, files or live controls. It creates no Supabase schema or users.

## Local verification

```sh
npm --prefix cloud ci
npm --prefix cloud test
npm --prefix cloud run check
npm --prefix cloud run dev
# In another terminal:
npm --prefix cloud run probe -- http://127.0.0.1:8787
```

`check` type-checks and performs a **dry-run** bundle; it does not deploy.
The development server binds only to loopback and does not start the station.

- `GET /healthz`: small public liveness response, no upstream requests or secrets.
  It reports collaboration/sync/production control as unavailable; healthy here
  does **not** imply LAB, PowerSync or a church workstation is online.
- `GET /api/session`: verifies a Supabase user access JWT against LAB's public
  JWKS, exact issuer/audience, allowed asymmetric algorithms, expiration,
  user/session IDs, role and non-anonymous identity. It returns only the user's
  ID. No cookies, login UI, refresh tokens, keys or user-editable metadata are
  used to grant authority. Missing, expired, forged or wrong-project JWTs fail.
  Signing keys are cached at most 10 minutes with a bounded fetch deadline.
- All station, media, sync and control routes are absent. Writes return 404/405.
  Cross-origin requests need an exact configured origin. There is no wildcard
  CORS or generic proxy, and responses are not cached.

JWT verification alone does not prove current membership or immediate session
revocation. **Do not add sensitive endpoints** until tenant membership/RLS,
revocation, server-side capabilities, rate limits and audit tests are in place.
Local station accounts are not automatically Supabase accounts. No migration
or cloud sign-up is silently performed by this scaffold.

## Deployment

Targets are reviewed in `targets.json`; identifiers there are not secrets.
LAB is staging-only. `production` is deliberately null and cannot deploy until
its eventual product-owned account/database/domain are explicitly configured.

Before a staging deployment, verify Workers **Free** in the Cloudflare dashboard.
CLI login confirms access but does not prove billing status. This account's
CLI credential could not read billing subscriptions; `default_usage_model:
standard` alone is not proof of a free or paid subscription. Never grant broader
billing access just to deploy this foundation. No plan upgrade is automatic here.

After confirming the plan, set `CLOUDFLARE_ACCOUNT_ID` to the reviewed staging
account and `LUMEN_WORKERS_FREE_CONFIRMED=true` in the invoking environment, then
run `npm --prefix cloud run deploy:staging`. The guard rejects extra CLI overrides,
wrong accounts, incomplete targets and resource bindings. Do not bypass it with
raw Wrangler deploy commands. No R2, Containers, D1, Durable Objects, DNS change,
custom domain, paid plan, logs storage or scheduled polling is provisioned.

After deployment, run `npm --prefix cloud run probe -- https://<worker>.workers.dev`.
This checks liveness, unauthenticated/forged-token denial, CORS and absent live
controls, without creating users or affecting production.

For GitHub credentials, safe branch promotion and budget activation see
[GitHub delivery](../docs/GITHUB-DELIVERY.md). Local Wrangler OAuth must stay on
this computer, never in GitHub secrets. Cloud integration, desktop releases and
the self-hosted sync service have separate lifecycles; neither a Git push nor
this Worker can silently restart the production engine during a service.
