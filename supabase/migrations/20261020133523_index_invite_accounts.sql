-- Cover both account FKs without exposing invitation hashes to clients.
create index lumen_invites_created_by_idx on lumen_private.invites(created_by);
create index lumen_invites_used_by_idx on lumen_private.invites(used_by);
