# Workspace and organisation isolation

Lumen uses one immutable UUID for a team/workspace tenant. An organisation can
have multiple workspaces; a name is a display label, **not** an access boundary.
Do not create another parallel organisation/team hierarchy just to name streams.
For a provisioned station, use the existing Supabase `lumen_teams.id` as its
`LUMEN_WORKSPACE_ID`. A UUID by itself is never a credential.

## What is already tenant-scoped

Cloud team drafts, invitations, memberships and private activity rooms already
use the team UUID. Database RLS and write RPCs check current authenticated
membership; browser account metadata and cursor messages grant no permissions.
Offline SQLite is separated by project/account, with workspace-filtered caches,
outbox and conflicts. Switching accounts invalidates in-flight account work.

The team preferences dialog shows the workspace ID and a copy action. Switching
the team selector changes collaborative preparation only: it does not retarget
Studio, select another Program, change Main audio or repoint Watch.

## A local station has one immutable workspace

Each `LUMEN_DATA_DIR` gets a private auxiliary `workspace.json`. Existing scenes,
content, recordings, saved streaming keys and audio settings stay untouched.
An unconfigured station gets a new local UUID and keeps working offline. A new
server-provisioned station gets the UUID supplied in `LUMEN_WORKSPACE_ID`.

```dotenv
LUMEN_DATA_DIR=/srv/lumen/workspaces/<workspace-uuid>/station
LUMEN_WORKSPACE_ID=<the same existing cloud team UUID>
```

Use a **separate directory/process per workspace**, with separate local ports or
containers, credentials, backups and OS access. The backend verifies identity
under its station lease before opening auth/content/production stores. A wrong
ID, unsafe/corrupt identity file or missing configuration for a provisioned
station fails closed rather than borrowing another workspace's files. Never
delete an identity or lock file to force a different workspace to start.

`GET /api/workspace` exposes only non-secret identity/status. It is not an auth
endpoint and accepts no changes. There is deliberately no browser action that
reassigns a running station. Provisioned stations also reject shared-draft
imports and exports involving a different team. Account/team changes while an
import dialog is open cancel the old import; queued transfers recheck their
original account/workspace before mutation. Standalone local stations retain the explicit
"new local copy" workflow; that never binds them to a cloud team.

### Existing station adoption

This change does not choose a cloud organisation for your existing church
station or move its data automatically. Decide which team owns it before its
first provisioned startup. If a local identity already exists, make a verified
backup and use an explicit, reviewed migration to a separate provisioned data
directory. Do not rename a UUID or reuse another team's saved stream keys.
Changing an environment variable is not an ownership transfer. This phase has
no self-service station-claim/migration wizard.

## Shared Lumen Watch relay

The relay's explicit tenant mode uses a private server-side registry with a
distinct publishing key and, where private outputs exist, a distinct viewer key
for each workspace. See [relay setup](../watch-relay/README.md). The registry is
provisioned by the service administrator **after verifying workspace ownership**;
there is no public unauthenticated tenant-provisioning endpoint.

```text
Public Watch:     /watch/<workspace-uuid>/live
Private Program:  /output/<workspace-uuid>/program#key=<viewer-key>
```

In tenant mode, stream state, media files, replay fences, viewer cookies and
authorization are workspace-scoped. Two churches can both use `live` and
`program` without colliding. Workspace A's publisher/viewer key cannot authorize
workspace B, and tenant routes never fall back to a global token. Legacy
unscoped stream/API/HLS routes are disabled in tenant mode. Private media still
requires authorization on every status, playlist and segment route.

Configure the station's normal HTTPS Watch relay and **the same server-side
`LUMEN_WORKSPACE_ID`**; the adapter builds scoped URLs automatically. Protected
Program verification checks the returned workspace ID and exact scoped URL
before exposing a link. A typo cannot downgrade into an unscoped publisher.
Facebook/YouTube settings and keys stay station-private and are not uploaded to
team drafts or the sync outbox. Public Watch is public by intent; do not put
private material there. Use the separately protected Program link when needed.

The ordinary `npm run dev:watch` launcher remains a standalone, loopback-only
rehearsal with its one-use private IPC credential and existing local Watch URL.
It is not a shared tenant relay. Test tenant mode with disposable registry keys
and stations, not by replacing your church's live configuration.

## Scope and release limits

No LAB schema, account, cloud billing, DNS or production relay configuration is
changed by this implementation. No paid service is required by the new code.
It does not make the legacy local production backend a public multi-tenant
gateway: keep it private. Public Studio deployment still needs a separately
reviewed authenticated station-authority service, station provisioning and
operational hardening. Team collaboration remains the opt-in rehearsal described
in [local team testing](LOCAL-TEAM-TESTING.md); PowerSync source replication still
needs the previously documented direct database connectivity.

Tests cover different workspaces with identical stream names, credential and
cookie cross-access denial, protected media, replay/restart isolation, safe
station startup and stale account/team import guards. Real relay browser tests
use generated media and disposable local keys; they are not a public VPS rollout.
