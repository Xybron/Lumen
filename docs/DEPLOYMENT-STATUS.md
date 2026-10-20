# Development infrastructure status

Verified 20 October 2026. This is a development foundation, not a completed
multi-user or offline-sync rollout.

## Cloudflare staging

- Worker: `lumen-cloud-staging`.
- URL: https://lumen-cloud-staging.ronaldnettey360.workers.dev
- Deployed version: `16e62f2a-a285-4ffc-b4da-cbac4d8e83db`.
- Source implementation: Lumen commit `a8f14baf568517a38b3c4d516b10ace4077bb638`.
- Target: existing Cloudflare account; Workers Free confirmed by the account
  owner before deployment. No paid products, storage bindings, custom domains,
  DNS changes, logging storage or scheduled jobs were provisioned.
- LAB's public signing-key endpoint is configured. No tables, users,
  publications, replication logins or database credentials were created.

All five remote HTTPS probes pass: health, missing credentials, forged token,
absent production control and denied untrusted origin. This proves only the
isolated Worker's behavior; it does not prove end-to-end Lumen cloud accounts,
collaboration, PowerSync availability or offline conflict handling.

This initial bootstrap was deployed deliberately from the local CLI. GitHub's
guarded delivery workflow is prepared in [draft PR #1](https://github.com/Xybron/Lumen/pull/1),
but hosted jobs remain disabled until free Actions minutes/blocked overages and
dedicated CI credentials are configured. Never copy the local OAuth token to CI.
See [GitHub delivery](GITHUB-DELIVERY.md). The production target remains null and
`prod` has not been merged or deployed by this setup.

## Standalone PowerSync project

The requested private repository is https://github.com/Xybron/Lumen-Sync.
It is the separate source of truth for the local demo and guarded Contabo
deployment preparation. No managed PowerSync subscription is needed for its
Open Edition containers; existing server resources and maintenance still matter.

The local independent checkout lives under the ignored
`.local-projects/lumen-sync/` directory; its private credentials and Docker data
are not part of this repository. It uses only synthetic demo records. Consult
the standalone README for its commands and actual trial status before relying
on it. The earlier `infra/powersync/` scaffold remains as the original isolated
evaluation fixture, not a second production deployment target.

The standalone local trial passes on macOS arm64/Docker Engine 29.4.0: clean
first startup, anonymous denial, two-operator initial-sync isolation and restart
with retained synthetic data. Nine scaffold/guard tests pass. Host init-script
execution and internal-only port-publishing issues found during real testing
were fixed before publishing. The demo containers were stopped afterward; the
main demo's volume and private local credentials are retained for later use.

The intended VPS provider is Contabo. Actual specifications, spare capacity,
outbound IPv6 from the intended container network, deployment access, staging
hostname/proxy and tested backups remain unverified. No VPS access, host
networking changes or LAB replication is implied by creating the repository.
The owner will deploy to Contabo and choose/configure DNS later; no SSH access
or hostname approval is being requested for this completed local setup.
The standalone Contabo startup guard fails closed until those prerequisites
and Lumen's tenant-scoped data/auth/upload design are verified separately.

## Live workstation boundary

Scenes, saved stream keys, Main audio/device bindings, station databases,
recordings and the production engine remain local and unchanged. A cloud push
does not switch scenes, stream, mute audio, restart Studio or replay live
commands. Cursor presence and actual cross-device data sync are not enabled yet.
