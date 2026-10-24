# LAB team collaboration schema

The migration adds a separate, opt-in editing workspace. It does **not** import
station files, local identities, stream keys, device bindings, Main audio, live
channel state or Studio Program/Preview selections.

## Tables and authorization

- `lumen_teams`: team names and their creating account.
- `lumen_memberships`: current owner/editor/viewer membership.
- `lumen_profiles`: display names, visible only to the account and team peers.
- `lumen_resources`: revisioned scene, presentation, Scripture and Lyrics drafts.

All four public tables have RLS and authenticated SELECT-only grants. Writes go
through six public **security-invoker** RPC wrappers. Their private implementations
require an unexpired, nonanonymous, confirmed Supabase Auth account with a current
`auth.sessions` row and check live team membership. Roles are database records,
never user-editable JWT metadata. Viewer accounts cannot save drafts; no team role
grants local production control.

Private tables contain SHA-256 invitation hashes and small idempotency receipts.
Invitation tokens are shown once, expire after 24 hours and can be redeemed once.
Owners can change roles or remove a member; the last owner cannot be removed.

## RPC contract

| RPC | Arguments | Result |
| --- | --- | --- |
| `lumen_set_profile` | `p_display_name` | Profile row |
| `lumen_create_team` | `p_name` | Team row |
| `lumen_create_invite` | `p_team_id`, `p_role` (`editor` or `viewer`) | `{token, expires_at, role}` |
| `lumen_join_team` | `p_token` | Team row |
| `lumen_set_member_role` | `p_team_id`, `p_user_id`, `p_role` (`null` removes) | `{user_id, role}` |
| `lumen_save_resource` | `p_id`, `p_team_id`, `p_kind`, `p_name`, `p_document`, `p_base_revision`, `p_operation_id` | `{status, resource, replayed}` |

Draft IDs and operation IDs are client-generated UUIDs. Base revision `0` creates
a draft. A save with the current revision increments it; an outdated revision
returns `status: "conflict"` and the latest remote draft without overwriting it.
Keep the local draft for review. A repeated operation ID is idempotent; reusing it
for different input is rejected. Resolving a conflict requires a new operation ID.

Documents must be objects with numeric `schemaVersion: 1`, at most 512 KiB and at
most 32 nested levels. Operational and credential keys, URLs, media sources and
audio/device settings are rejected recursively. This is a second boundary, not a
replacement for the UI's explicit safe-draft conversion: arbitrary text can still
contain anything a user types, so never paste credentials into shared content.

## Realtime and PowerSync

The migration adds only these four tables to `supabase_realtime` and creates a
`powersync` publication containing exactly those tables. It creates no replication
role, source slot, paid database option or cloud deployment. All four tables use
`REPLICA IDENTITY FULL` for membership/change filtering.

Private Realtime room topics are `lumen-team:<team UUID>`; SELECT/INSERT policies
check current membership and current Auth session. Cursor payloads are advisory
user-generated activity, never authorization or production commands. A UI must
expire stale cursors and clean up subscriptions. Membership changes are still
checked by the database for every save even while a room connection is open.

PowerSync stream rules must independently enforce membership: the replication
reader bypasses RLS by design. Never use a catch-all sync stream or publish Auth,
private invitations, operation receipts, station credentials or audio settings.

## Applying and verifying

The migration filename was generated with `supabase migration new` (CLI 2.90.0).
Apply the migration to **LAB only**, review advisors, and verify table grants, RLS,
RPC rejection for anonymous requests and actual account login. Do not reset LAB or
change Auth email-confirmation settings as part of this migration.

Default Supabase email delivery has restrictions. A user must confirm their email
before these RPCs can run. Configure an appropriate email sender later if needed;
the implementation does not bypass confirmation or fabricate production accounts.

Run static checks with the normal backend test suite. To additionally execute the
SQL assertions against a disposable PostgreSQL 17.11 container:

```sh
LUMEN_TEST_SCHEMA_DOCKER=1 node --import ./backend/node_modules/tsx/dist/loader.mjs --test backend/test/team-schema.test.ts
```

Docker tests use a fresh, unpublished, network-isolated tmpfs container and remove
only that owned test container. The files in `supabase/tests/` contain tiny fake
Auth/Realtime schemas solely for exercising SQL privileges, tenant isolation,
roles, invitation redemption, compare-and-swap, idempotency and revocation.
**Never run these fixture or assertion files on LAB or any real Supabase project.**
