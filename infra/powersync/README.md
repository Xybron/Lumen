# PowerSync self-hosting evaluation

The standalone follow-on project requested for local use and Contabo deployment
is now maintained in the private [Lumen-Sync repository](https://github.com/Xybron/Lumen-Sync).
Use that repository's README for the current independent checkout and commands.
This directory remains the original synthetic-data evaluation fixture, not a
second production deployment. See [development infrastructure status](../../docs/DEPLOYMENT-STATUS.md).

Status: an **isolated local evaluation**, not Lumen's production sync service. This
does not modify LAB, start a cloud subscription, migrate any church data or wire
PowerSync into the running Studio app. It is intentionally not deployed by the
Cloudflare workflow.

## Why evaluate this

[PowerSync Open Edition](https://powersync.com/legal/licensing-terms) provides its
core sync engine without the hosted Pro subscription. It is source-available
under the Functional Source License; client SDKs use Apache 2.0. It does not
include the managed cloud dashboard or managed operations/support. Review the
license again before future product distribution.

An existing VPS may be able to run the service without a new hosting plan. That
is not a promise of zero operating cost: server capacity, storage, bandwidth,
backups, security updates and monitoring still need to be accounted for. Do not
upgrade the VPS or enable any paid Supabase/Cloudflare feature without approval.

## Run the isolated evaluation

Prerequisites: Node.js 22+, Docker Engine/Desktop and Docker Compose. These
commands run from the repository root. The stack is never started by tests or
the setup script.

```sh
node infra/powersync/setup.mjs
docker compose --env-file infra/powersync/.env.local -f infra/powersync/compose.yaml config --quiet
docker compose --env-file infra/powersync/.env.local -f infra/powersync/compose.yaml up -d --wait
node infra/powersync/smoke.mjs
```

`setup.mjs` generates three independent 256-bit passwords and an RSA signing key
using Node's OS-backed cryptography. It refuses to overwrite existing
credentials. `.env.local` and `.runtime/` must remain ignored by Git; never upload
them as CI artifacts, use `docker compose config` without `--quiet` in logs, or
reuse evaluation keys for production. The private key is not mounted into any
container: the service receives only the public verification key.

The only published socket is `127.0.0.1:8188`. PostgreSQL has no host port and
joins only an internal network. PowerSync also joins an API publishing bridge
with outbound masquerading disabled for Docker Desktop compatibility. This is
not an airgap or egress firewall; there are no LAB credentials or configured
cloud sources. Images are pinned to exact multi-architecture digests, not
floating `latest` tags:

- PowerSync Service `1.27.0`.
- PostgreSQL `17.11-alpine`.

The database contains two synthetic cue rows for two fictional operators. The
replication role can read just `demo_cues`, while a separate role/database stores
PowerSync buckets. The stream requires a valid short-lived signed JWT and filters
rows by its `sub` claim. There is no anonymous or global stream and no enabled
admin API token. The smoke script checks liveness, anonymous rejection, and that
each operator's initial snapshot includes only their own row.

This is a **wire-level smoke check**, not an SDK integration test. Upload queues,
offline reconnection, membership revocation, conflicts and crash recovery still
need to be implemented and tested in Lumen before anyone relies on cloud sync.
The owner-only sample must not be mistaken for the future shared-team model.

Validate the scaffold without starting containers:

```sh
node --test infra/powersync/scaffold.test.mjs
```

Stop only this evaluation; its named volume is preserved:

```sh
docker compose --env-file infra/powersync/.env.local -f infra/powersync/compose.yaml down
```

Do not add `--volumes` unless you deliberately want to discard the synthetic
evaluation database. This stack has no access to Lumen's `data/` directory,
recordings, saved stream keys, Main audio or local runtime lock.

## Before using LAB as the source

The existing LAB project is the intended development source, but this scaffold
**does not connect to it**. Do not replace a demo connection URI with LAB's admin
password and call that a production deployment.

1. Review the tenant schema, memberships and role/capability model first. Enable
   RLS on every exposed table, scope grants, and test cross-team access. A
   replication connection reads outside user RLS, so PowerSync's sync queries
   need independent membership-based filtering. A client-provided `team_id` is
   never sufficient authorisation.
2. Create a dedicated replication login with `REPLICATION`, the required RLS
   bypass, `USAGE` only on intended schemas and `SELECT` only on explicitly
   published sync tables. Never grant general insert/update/delete access or
   publish all tables. Keep `auth`, stream keys, device secrets, recordings and
   session tables out of the publication. This step is **not yet performed**.
3. Use a **direct** PostgreSQL connection, TLS certificate verification and the
   LAB CA where necessary. Neither Supavisor transaction nor session poolers
   support this logical replication connection. The free direct endpoint is
   normally IPv6-only: verify IPv6 from inside the VPS's Docker network before
   proceeding. An IPv4 add-on is billable and must not be enabled automatically.
4. Use a separate local VPS database for buckets, not LAB's small free database.
   Configure source and bucket connection pools conservatively and account for
   replication-slot WAL retention during network outages. A long-disconnected
   sync service can consume source disk until a slot is invalidated; monitor it
   and test a controlled full resync rather than silently retaining unlimited WAL.
5. Configure asymmetric Supabase Auth JWKS verification (issuer/audience and key
   rotation), not the evaluation RSA key or a public legacy shared JWT secret.
   Add tests for expired tokens, removed memberships and separate churches.
6. The app's upload API must validate permissions and revisions server-side;
   PowerSync does not supply the business conflict policy. Sync durable edits,
   not live Cut/Fade, Send live, mute or Go Live commands for later replay.
   Hardware Main audio binding stays with the production station.
7. Put the service behind authenticated TLS, restrict admin endpoints, configure
   streaming proxy timeouts/buffering and WebSockets, enforce resource limits,
   and test backups/restores. Do not expose PostgreSQL or the demo API publicly.

Do not use a keep-alive hack to evade hosted free inactivity policies. Local
production must function without cloud availability; cloud sharing can reconnect
and reconcile later. Free Supabase can itself pause after inactivity.

## VPS information still needed

- Existing VPS provider/plan, OS, CPU architecture, vCPU count, RAM and free disk.
- Spare resources while the app and Watch relay are active, plus bandwidth cap.
- Whether Docker has working outbound IPv6 to LAB's direct DB endpoint.
- An approved staging hostname and existing TLS/reverse-proxy arrangement.
- A way to inspect/deploy to that VPS using project-scoped access; share no root
  passwords, database passwords or stream keys in chat.
- Backup destination/retention and whether the existing allowance can cover it.

The evaluation caps Node's old-space heap at 512 MiB and the service container at
768 MiB; PostgreSQL is capped at 512 MiB. Those are conservative **test limits**,
not production sizing or an uptime guarantee. Start with roughly 2 GiB spare RAM
and measure a representative team/workload alongside the Watch relay. No new
server purchase should be inferred from that suggestion.

## References (checked 20 October 2026)

- [PowerSync self-hosting](https://docs.powersync.com/intro/self-hosting)
- [Instance config and PostgreSQL storage](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances)
- [Official PostgreSQL bucket-storage example](https://github.com/powersync-ja/self-host-demo/tree/main/demos/nodejs-postgres-bucket-storage)
- [Service 1.27.0 release](https://github.com/powersync-ja/powersync-service/releases/tag/v1.27.0)
- [Supabase logical replication connection FAQ](https://supabase.com/docs/guides/database/replication/manual-replication-faq)
- [Licensing](https://powersync.com/legal/licensing-terms)
