# LAB accounts and local team preparation

This is an **opt-in rehearsal**, not a replacement for Lumen's current local
production authentication or a claim that the multi-tenant product is ready for
public launch. Normal `npm run dev` stays unchanged.

## Start

```sh
npm run dev:team
```

Open **http://127.0.0.1:5373/team**. It starts an isolated backend on loopback
3300 and a Vite UI on 5373. Its station lives in ignored `.team-local/station`.
No existing scenes, media, stream keys, recordings or Main audio settings are
copied or changed. Occupied ports cause a clear failure, never a process kill.
Ctrl+C stops only these owned application processes. Data and browser drafts are
retained. The local development station's default login is separate from LAB;
it must not be exposed publicly or used as a deployed authentication gateway.

1. Create a LAB email/password account and confirm the email, then sign in.
   LAB email confirmation remains enabled. No SMTP/security settings were
   weakened. Supabase's default SMTP is limited; if an address cannot receive
   confirmation, configure an appropriate free SMTP provider or use an allowed
   address before testing. No mail provider was purchased or configured here.
2. Set a display name and create your church's team workspace.
3. Generate a one-use editor/viewer invitation. It expires after 24 hours; share
   privately. Open another browser profile/incognito window for a second real
   account, sign in there, and join with the code.
4. Prepare shared Presentation, Scripture, Lyrics or text/shape Scene drafts.
   Save from either account. Private Realtime activity shows cursors on matching
   operator surfaces and teammates' current areas. Focus mode hides activity and
   stops sharing your cursor without stopping draft sync.
5. Owners can change member roles or remove members in Team preferences.
   Authorization comes from current membership/session rows, never profile
   metadata or the cursor payload. Presence is advisory, not a verified ownership
   claim, lock or production permission.

## What is shared, and what is not

Workspace UUIDs also provide the namespace for provisioned stations and shared
Watch hosting. **Team preferences → Workspace identity** shows the current
team UUID and read-only station binding status. A provisioned station rejects
draft transfers to/from a different selected team; a cloud team switch never
retargets Studio, Watch or Main audio. The backend must be restarted to load a
new identity endpoint/configuration. Binding and hosting setup remain explicit
administrator steps; see [workspace isolation](TENANCY.md).

Shared documents contain text, scripture references, lyric sections, slide
ordering and text/shape design geometry. `Copy selected station drafts` is an
explicit safe projection of the selected scene and focused channel. Media/input
layers, URLs, device IDs, routing, credentials and audio settings are excluded.

`Use on this station` requires local station sign-in and a confirmation. It adds
a **new draft copy**, not an overwrite or live Take. Program/Preview selection,
Main audio, devices and saved keys are not changed. Media/channel sources must
be connected and arranged locally. Normal Studio scene switching and channel
Send live stay manual and are never queued for later replay.

This phase is collaborative **preparation**, not simultaneous CRDT editing of
the existing live Studio document. Two people saving the same draft get explicit
revision-conflict review. `Keep my edit as a copy` creates a new UUID; it never
silently overwrites the other person's work. Different drafts can be edited
independently. Live control across accounts/devices needs a separately reviewed
station authority/transport layer before any public rollout.

## Offline and reconnect

Each LAB account gets a separate persistent PowerSync SQLite database in the
browser (IndexedDB-backed), with a separate local-only revisioned outbox and
conflict copies. Sign in and load a workspace online once. Internet can then be
disconnected while the localhost application remains running; existing drafts
remain editable. Save, reload the local page, reconnect, and check pending edits
drain. An interrupted request reuses its operation UUID and cannot apply twice.
Do not clear browser storage while edits are pending. Browser storage is not an
encrypted backup; use trusted device accounts. Offline access is previously
authorized cached data. No system can remotely erase an already-offline copy
immediately when membership is revoked; reconnect rechecks permissions and
refuses unauthorized uploads.

First sign-in needs internet. If the cached Auth session expires and cannot be
refreshed, you may need to sign in online again to reopen the team workspace;
unsent SQLite drafts are retained, not deleted. This phase does not yet provide a
separate offline account-unlock credential. The normal local production station
remains usable independently of LAB's Auth session.

LAB HTTPS Auth/RPC uploads and private Realtime work independently of the local
PowerSync replication service. A bounded REST snapshot fallback keeps this
rehearsal usable when replication is unavailable. The UI explicitly distinguishes
this from **PowerSync connected**; it is not a successful replication test.

## Real PowerSync replication: current blocker

```sh
npm run team:sync -- doctor
npm run team:sync -- setup
npm run team:sync -- rules
```

On this Mac, LAB's direct IPv6 endpoint returned **EHOSTUNREACH**. Docker's source
connectivity also has not passed. Supabase's poolers cannot carry logical
replication. Therefore no replication login/password or slot has been created,
and no LAB PowerSync service has been started. A local health check or successful
REST upload must not be reported as an end-to-end PowerSync pass.

Use an IPv6-capable network/machine, or the existing Contabo server when ready;
verify outbound IPv6 there first. Then follow
[the dedicated local service setup](../infra/team-sync/README.md) for the
least-privileged replication login, verified TLS CA and initial sync checks.
The launcher fails closed before startup while these prerequisites are absent.
No paid IPv4 add-on, PowerSync Cloud plan, Cloudflare binding or paid feature was
enabled. LAB remains Free; quotas are not a promise of unlimited storage/traffic.
No GitHub-hosted Actions usage was enabled by this integration.

## Verification

```sh
npm run build
npm --prefix backend test
node --test infra/team-sync/launcher.test.mjs
# With dev:team running: isolated HTTP/WebSocket fixtures, NOT real cloud users
npm run test:team:browser
# Explicit disposable Postgres schema/RLS test (requires Docker)
LUMEN_TEST_SCHEMA_DOCKER=1 node --import ./backend/node_modules/tsx/dist/loader.mjs --test backend/test/team-schema.test.ts
```

The schema is applied to LAB and migration files match remote history. Actual SQL
authorization tests run in a disposable, network-isolated Postgres container;
`supabase/tests` must NEVER be applied to LAB. LAB anonymous REST access was
verified denied. Advisors report no security warnings; the two informational
no-policy findings are intentional deny-all private invite/receipt tables.
Fresh unused-index info is expected on an empty project.

Browser fixtures exercise actual local SQLite persistence, offline-cloud reload,
ordered outbox upload and conflict-copy recovery, but **do not prove live LAB
Auth, private Realtime or source replication**.

### Dedicated real-account rehearsal

With explicit permission, two dedicated test users were provisioned through
Supabase's official **Create new user** dashboard flow. Per-user auto confirmation
was used for these test accounts; no emails were sent and global email
confirmation/security settings were not changed. These accounts do not test
signup email delivery. Generated credentials and account IDs are retained only
in ignored `.team-local/test-accounts.json` (mode 600).

With `dev:team` running, the opt-in real test is:

```sh
# Verify the existing dedicated users without printing passwords or tokens
node backend/test/team-real-accounts-setup.mjs --verify
npm run test:team:real
```

The real harness uses two separate browser contexts and actual LAB Auth, RPCs
and private Realtime, without intercepting network requests. Retries reuse its
dedicated cloud test team/draft. Sanitized reports stay in ignored `.team-local/`;
no invitation codes, passwords or JWTs enter the report. Production scene,
production/audio and saved-key files are hashed before/after each run.

On 2026-10-20, real sign-in, owner team creation and an editor invitation/join
passed. The initial cursor test exposed **Client presence rate limit exceeded**:
Presence was being used for frequent pointer updates. The corrected transport
uses private Broadcast for transient activity and a single Presence roster
advertisement per successful subscription. Motion is coalesced to at most four
updates per second, with a trailing final position and five-second activity
keepalive. Focus uses coordinate-free inactive messages, not repeated
track/untrack calls. Room membership policies and free-tier limits are unchanged.

The corrected real-account regression passed: two-way shared drafts, 36 seconds
of sustained movement without any Presence churn or rate-limit errors, six Focus
hide/resume cycles, keyboard-only draft navigation, offline queued editing and
automatic private-room/cursor/draft recovery after reconnect without reload.
Retries reopened the existing private test team and retained invited membership;
they did not create extra users or claim to retest fresh invitation delivery.
Production scenes, Main audio and saved-key file hashes remained unchanged.

The normal build and backend suite passed (431 tests passed, one optional Docker
schema test skipped). The separate fixture browser regression also passed SQLite
persistence, ordered uploads, conflict copies, account isolation and viewer
restrictions. This does not turn the rehearsal into a public-release sign-off or
verify cloud PowerSync source replication.

PowerSync source replication and authenticated checkpoint/revocation testing
still require direct database connectivity. No fake Auth rows are inserted into
LAB, and no global confirmation or session safeguards are bypassed for tests.

### Separate-workspace and Watch isolation rehearsal

With the same dedicated accounts and `dev:team` running:

```sh
npm run test:team:isolation
```

This opt-in harness uses normal real LAB sessions to create/reuse one exclusive
QA workspace per account. It does not alter the earlier shared test team,
memberships or profiles. It checks foreign-row invisibility, rejected draft
writes/UUID retargeting, invitation/role denial and explicit private Realtime
room denial, with successful own-workspace operations as positive controls.
Two isolated browser contexts open the actual UI, verify station bindings and
exercise an offline edit through the durable outbox and HTTPS reconnect path.
Copying drafts to or from a differently provisioned station must fail.

Disposable stations then render different Program pictures and generated Main
audio tones into a disposable tenant-aware local Watch relay. Playback checks
decode both actual pictures and audio frequencies, reject cross-workspace
publishing/viewer keys and cookies (including private playlists/segments), and
verify stopping one stream leaves the other live. Public Watch links remain
intentionally public; private Program links require scoped viewer credentials.

Only QA cloud workspaces/drafts are retained for repeat runs. Local test servers,
streams and temporary station data are cleaned up. Existing `data/` and
`.team-local/station/` scene/content, Main audio, saved stream keys, workspace
identity and saved output-link files are hashed before/after. Sanitized reports
are private mode-600 files at `.team-local/real-workspace-isolation-<runId>.json`;
no stream keys, viewer fragments, credentials or session tokens are recorded.
This local isolation test is not a VPS/public-launch or PowerSync source
replication sign-off. It never starts Facebook or YouTube streaming.

Dependency audit: the new pinned Supabase/PowerSync SDKs have no named advisories
in the current npm audit. The pre-existing frontend dependency tree still reports
33 advisories (including one critical); this integration does not silently apply
broad breaking upgrades. Address that release-hardening work before exposing a
production multi-tenant application publicly.

References: [PowerSync Web SDK](https://docs.powersync.com/client-sdks/reference/javascript-web),
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[private Realtime authorization](https://supabase.com/docs/guides/realtime/authorization),
[Presence rate-limit guidance](https://supabase.com/docs/guides/troubleshooting/realtime-client-presence-rate-limit-reached).
