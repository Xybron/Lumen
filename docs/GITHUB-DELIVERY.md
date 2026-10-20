# GitHub-driven delivery

This setup uses the existing private `Xybron/Lumen` repository and the existing
Supabase **LAB** project (`xfppsgiothkvhndmbixx`). It does not create another
Supabase project, a paid branch, or a paid Cloudflare subscription.

## What is deployed

The `cloud/` package is an isolated Cloudflare foundation. It is **not** the
current Studio server, a production workstation, the Watch video relay, or a
finished collaborative editor. The local backend still owns Program, scenes,
Main audio, connected devices, stream keys, recordings and media processing.
This workflow does not copy the church's runtime data to the cloud, apply
database migrations or start streams. Cloudflare Workers cannot replace the
Node/Chromium/FFmpeg production engine simply by uploading the existing backend.

Native macOS/Windows build, signing and the desktop updater are separate work.
They are deliberately not enabled here. Eventually desktop updates should be
versioned releases installed off-air, not automatic replacements during service.

## Branch and release rules

The workflow is `.github/workflows/delivery.yml`:

| Trigger | Checks | Deployment |
| --- | --- | --- |
| Pull request into `prod` or `cloud-staging` | Build and tests | Never; no deployment secrets |
| Push to `codex/**` | Build and tests | Never |
| Push to `prod` | Build and tests | Never automatically |
| Push to `cloud-staging` | Build and tests | Staging only, after checks pass |
| Manual run, `checks` target | Build and tests | Never |
| Manual run, `staging` target on `cloud-staging` | Build and tests | Staging after checks pass |
| Manual run, `production` target on `prod`, with exact confirmation | Build and tests | Production after checks pass |

Production requires typing `DEPLOY LUMEN PRODUCTION`. A manual deployment from
another branch fails before installing dependencies. Deployments only run in
`Xybron/Lumen`; a fork cannot inherit deployment behavior or credentials. A
deployment checks out the same event revision that passed its checks.

**Production is deliberately not configured yet.** `cloud/targets.json` contains
the reviewed LAB/staging target and a `null` production target. Even a correctly
confirmed manual production run fails closed before uploading anything. Review
the product-owned production account, database target and configuration in a
separate change before enabling it; do not silently promote LAB into production.

GitHub must see the workflow on the default branch before its manual **Run
workflow** button becomes available. Review and merge it into `prod` first;
doing so never deploys production. Hosted jobs stay disabled until the
`LUMEN_FREE_CI_ENABLED` repository variable is explicitly set to `true` after
checking the account's free minutes and blocked overages. Once enabled, the
merge runs tests. Create `cloud-staging` from
the reviewed revision when staging is ready. Do not auto-merge arbitrary work
into that deployment branch.

Suggested routine: development branch → reviewed pull request → `cloud-staging`
→ verify staging → reviewed changes to `prod` → explicitly dispatch production.
Keep repository access restricted to trusted team members. Where the account's
plan supports them, add branch protection and environment restrictions too.
The workflow does not assume paid required-reviewer protection is available on
a private GitHub Free repository.

## Authorise automated deployment

Local `wrangler login` authorises the local computer only. It does **not**
authorise a GitHub runner, and its OAuth credential must not be copied into CI.

In repository **Settings → Secrets and variables → Actions** configure:

- Secret `CLOUDFLARE_API_TOKEN`: a dedicated, least-privilege Cloudflare token
  scoped to the intended Cloudflare account. For this binding-free foundation,
  grant Workers Scripts edit and Account Settings read as required by Wrangler.
  Do not use a Global API Key or grant DNS, billing, R2 or unrelated account
  access. If a later feature needs more permissions, review that change first.
- Variable `CLOUDFLARE_ACCOUNT_ID`: the verified account ID, not a secret key.
  It must exactly match the reviewed destination in `cloud/targets.json`.
- Variable `LUMEN_WORKERS_FREE_CONFIRMED`: set to `true` only after confirming
  the intended account is on **Workers Free** in Cloudflare. A successful OAuth
  login or a `standard` default usage-model response does not establish that the
  account is on Free. Leave this unset if the plan cannot be verified; deployment
  will fail closed. This is an operator attestation, not automatic billing
  verification; remove it and pause deployment if the account's plan changes.
- Variable `LUMEN_FREE_CI_ENABLED`: set to `true` only after verifying that free
  Actions minutes remain and that overage spending is blocked. Until then all
  hosted checks and deployments are skipped without allocating a runner.

The private GitHub Free setup intentionally uses **repository-level** secrets
and variables and does not declare deployment environments. Private environments
and their secrets/protection features can require a paid GitHub plan. They may
be added later only after reviewing plan support; upgrading is not required by
this workflow. Missing deployment credentials fail with an explanatory message
before deployment rather than silently succeeding. The opt-in variable is a
runner-cost guard, not a substitute for the account's blocked-spending policy.

Only a user authorised to grant account access should create/approve these
credentials. Never paste a token into chat, a command checked into Git, a
workflow input, an issue, or logs. Rotate a credential if exposed. The workflow
uses only `contents: read` for its GitHub token and disables persistent checkout
credentials. There are no `pull_request_target` jobs or untrusted artifact
downloads. Tests never receive Cloudflare or Supabase secrets.

Do not also enable Cloudflare's automatic Git build integration for the same
Worker unless replacing this workflow intentionally; two deployment pipelines
would bypass the intended single release path and waste build minutes.

## Free-tier guardrails

- Only bounded Linux runner jobs; no macOS/Windows build matrix or GPU runners.
- Superseded checks are cancelled. An in-progress deployment is not interrupted
  by a newer one; deployments are serialised per environment.
- No scheduled polling, Actions cache, uploaded build artifacts, Docker registry
  pushes, package publishing or desktop release downloads in this workflow.
- Existing lockfiles are installed with `npm ci`; action implementations are
  pinned to verified official full commit SHAs, not moving tags.
- Tests cover the frontend/backend build, backend unit/integration suite,
  independent Watch relay, cloud foundation and isolated PowerSync scaffold.
  The PowerSync checks validate generated credentials, pinned manifests and
  Compose configuration; they do not start containers or connect to LAB.
  Hardware/browser end-to-end
  production tests still need the church's actual machines.
- Cloudflare deployment must stay on Workers Free. Do not enable paid Workers,
  R2, Containers or paid Supabase projects/branches to get a failing build past
  a limit. No such upgrade is performed by this workflow.

These constraints reduce usage, but they are not a billing guarantee. GitHub
Free private-repository minutes are an account-level allowance shared with
other repositories. Before enabling the first hosted run, confirm the account
has free minutes and that Actions overage spending is blocked. Once the free
allowance is exhausted, stop hosted runs; do not authorise paid overages
automatically. In **Billing → Budgets and alerts**, check the Actions budget's
**Stop usage when budget limit is reached** setting; an email alert alone does
not prevent charges. Check every
applicable Actions spending budget: an existing broader allowance can undermine
a new repository-only $0 limit. The account owner must resolve any such budget
before enabling CI; this setup does not change personal billing settings.
A self-hosted runner is an alternative, but must be explicitly configured and
isolated from production machines and untrusted pull requests.
Set `LUMEN_FREE_CI_ENABLED` back to `false` to stop future jobs from allocating
hosted runners; already running jobs must be cancelled separately.

## Reproduce checks locally

From the repository root:

```sh
npm ci
npm --prefix frontend ci
npm --prefix backend ci
npm --prefix watch-relay ci
npm --prefix cloud ci
npm run build
npm test
npm --prefix watch-relay test
npm --prefix cloud test
npm --prefix cloud run check
node --test infra/powersync/scaffold.test.mjs
```

Dependencies include native SQLite/Sharp and a bundled FFmpeg download; the CI
runner needs their supported Linux builds and network access during install.
`cloud`'s check includes TypeScript validation and a staging Wrangler dry run;
neither requires deployment secrets or `LUMEN_WORKERS_FREE_CONFIRMED`. The
PowerSync Compose check uses Docker Compose locally without starting Docker;
the test reports a skip if Compose is unavailable on a developer's machine.
Tests use isolated temporary fixtures, not the church's live station directory.
No browser automation test is implicitly treated as proof of actual physical
camera, audio interface, Windows or macOS release readiness.

## Rollback and boundaries

To roll back the cloud foundation, review a known-good revision on the appropriate
branch and run the same checked deployment path. This does not restore or rewrite
local station state. Do not roll back by copying another workstation's SQLite
database, manifest, stream keys or audio device bindings.

LAB schema/auth configuration, tenant RLS, offline conflict handling and
PowerSync replication need their own reviewed migrations and tests before cloud
collaboration is enabled. A green deployment of this foundation alone is not
proof that multi-user collaboration or offline cloud synchronisation is ready.

References: [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[GitHub Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions),
[budget enforcement](https://docs.github.com/en/billing/how-tos/set-up-budgets),
[Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
