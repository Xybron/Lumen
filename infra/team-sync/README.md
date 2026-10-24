# Local LAB + PowerSync

This opt-in stack connects self-hosted PowerSync to **LAB**, not a copy of the
church station. It keeps bucket storage in a separate unpublished local
PostgreSQL database and listens only on `http://127.0.0.1:8189`. It does not mount,
import or modify Lumen's scenes, saved stream keys, Main audio bindings or
recordings. Nothing starts automatically with normal `npm run dev`.

No PowerSync Cloud subscription, Supabase IPv4 add-on or other billable service
is enabled. Existing free-tier quotas still apply to LAB. No DNS, server or
Cloudflare setting is changed by these commands.

## Check connectivity first

```sh
node scripts/team-sync.mjs doctor
```

Hosted Supabase's direct database endpoint needs working IPv6 on both the host
and Docker network. PowerSync logical replication cannot use either Supavisor
pooler. The doctor first checks the host; only if that passes does it create a
temporary IPv6 Docker bridge and disposable container for a credential-free TCP
check. It removes only that owned temporary bridge afterwards. It does not
change the Docker daemon, other containers or firewall.

On this development Mac the host check returned **IPv6 unreachable**. A Docker
default-bridge lookup also returned no IPv6 record. This is an actual local
network prerequisite, not a stream-key or Lumen account error. Do not interpret
successful LAB HTTPS/Auth or draft uploads as a successful PowerSync connection.
Use an IPv6-capable connection/machine, or later the existing Contabo server with
verified outbound IPv6. No paid workaround is selected automatically.

## Private local setup

```sh
node scripts/team-sync.mjs setup
```

This creates ignored `infra/team-sync/.runtime/local.json` with independent
random bucket passwords. It refuses to overwrite existing credentials. Source
credentials stay empty until direct connectivity is available and the dedicated
LAB replication role can be verified.

Once the reviewed team migration is applied, prepare the source separately:

- Use only the dedicated `lumen_sync_replica` login, never `postgres`, an Auth
  service-role key or a user password. Grant only replication, the necessary RLS
  bypass, schema usage, and SELECT on `lumen_teams`, `lumen_memberships`,
  `lumen_profiles`, `lumen_resources`. No writes, owner or schema-creation rights.
  The unexecuted [role template](./replica-role.sql.example) creates a **NOLOGIN**
  role first. Set its strong password interactively with psql's `\password`
  command, inspect its exact grants, then enable LOGIN deliberately. Never put a
  real password into a migration, command argument or SQL history.
- The `powersync` publication must list only these four tables, never `FOR ALL
  TABLES`. Review replica identity requirements and current publication contents
  before making changes. Do not publish Auth/session, invite-token or operation
  receipt tables. No source role, publication or replication slot is created by
  this launcher.
- Put the dedicated database password into `sourcePassword` in local.json. Do
  not paste it into chat or a CLI argument. Put the verified LAB database root
  CA PEM (from the project's connection settings) in `sourceCaPem`. Source TLS is
  always `verify-full`; there is no insecure retry or pooler fallback.
- Set `sourceRoleVerified` to true only after the exact login and SELECT-only
  grants/publication have been verified. This is an operational assertion, not
  a substitute for testing privileges.
- On Mac/Linux keep `.runtime` at mode700 and `local.json` at600. Do not commit,
  share, print resolved Compose config or upload this directory as an artifact.

The launcher fixes the source host to
`db.xfppsgiothkvhndmbixx.supabase.co:5432/postgres`, user `lumen_sync_replica`,
and LAB's public asymmetric JWKS. Arbitrary endpoints, Docker arguments, remote
Docker daemons and inherited Compose/PowerSync overrides are rejected or removed.

## Validate and start deliberately

```sh
node scripts/team-sync.mjs check
node scripts/team-sync.mjs up
node scripts/team-sync.mjs status
```

`check` checks configuration, public JWKS and direct connectivity; it does not
claim to have verified authentication, TLS, initial replication or tenant
isolation. `up` runs only after these checks pass. It starts the owned
`lumen-team-sync` project using pinned multi-architecture images with bounded CPU,
memory, connection pools and log rotation. It does not start or stop the existing
Lumen production backend/engine. The API service has outbound access for LAB;
this is not an air-gapped stack.

Lumen's team workspace connects with each user's own Supabase JWT. Streams are
filtered by **replicated membership rows**, not user-editable metadata, client
team IDs or cached JWT roles. Draft uploads use LAB's revision-checked RPCs, not
unrestricted table writes. A successful health probe is not proof of completed
sync: verify an authenticated client reaches Synced, sees only its team's data,
and loses team data after membership removal.

Never queue or replay Cut/Fade, Send live, Go Live, mute or device changes through
the offline editor. Production scene switching and Main audio remain local.
Offline access is previously authorized cached draft data; removing membership
while a device is offline cannot remotely erase that offline device immediately.

## Stop safely

```sh
node scripts/team-sync.mjs down
```

This stops only `lumen-team-sync` and retains its bucket volume. There is no
volume-deletion command in the launcher. A long-disconnected logical replication
slot can retain LAB WAL; monitor source slot lag/disk, stop the integration when
not testing, and review slot cleanup/resync explicitly rather than leaving an
unbounded abandoned slot. Stopping Docker does not automatically delete source
replication slots.

## Tests

```sh
node --test infra/team-sync/launcher.test.mjs
node scripts/team-sync.mjs rules
```

The second command compiles the exact rules with the pinned service image in a
disposable container with networking disabled. These test local safety and rule
compilation boundaries only. Real LAB PowerSync
replication remains unverified until connectivity and a dedicated login exist.

References: [PowerSync self-hosted configuration](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances),
[membership-filtered stream queries](https://docs.powersync.com/sync/streams/queries).
