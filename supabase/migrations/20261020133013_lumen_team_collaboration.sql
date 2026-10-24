-- Shared EDITING data only. Nothing here controls a production bus, device,
-- output, saved stream credential, audio mix or recording/streaming process.
-- Public wrappers are invoker functions; privileged work lives in an unexposed
-- schema and rechecks the real Auth session and current membership on each call.
create schema lumen_private;
revoke all on schema lumen_private from public, anon, authenticated;
grant usage on schema lumen_private to authenticated;

create table public.lumen_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  updated_at timestamptz not null default now()
);
create table public.lumen_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table public.lumen_memberships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.lumen_teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);
create index lumen_memberships_user_team_idx on public.lumen_memberships(user_id, team_id);
create table public.lumen_resources (
  id uuid primary key,
  team_id uuid not null references public.lumen_teams(id) on delete cascade,
  kind text not null check (kind in ('scene', 'presentation', 'scripture', 'lyrics')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  document jsonb not null check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 524288),
  revision bigint not null default 1 check (revision > 0),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);
create index lumen_resources_team_idx on public.lumen_resources(team_id, updated_at);
create index lumen_resources_updated_by_idx on public.lumen_resources(updated_by);
create index lumen_teams_created_by_idx on public.lumen_teams(created_by);

create table lumen_private.invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.lumen_teams(id) on delete cascade,
  token_hash text not null unique,
  role text not null check (role in ('editor', 'viewer')),
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null,
  used_by uuid references auth.users(id),
  used_at timestamptz
);
create index lumen_invites_team_idx on lumen_private.invites(team_id);
create table lumen_private.operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  resource_id uuid not null references public.lumen_resources(id) on delete cascade,
  request_hash text not null,
  status text not null check (status in ('saved', 'conflict')),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index lumen_operations_resource_idx on lumen_private.operations(resource_id);
alter table public.lumen_profiles enable row level security;
alter table public.lumen_teams enable row level security;
alter table public.lumen_memberships enable row level security;
alter table public.lumen_resources enable row level security;
alter table lumen_private.invites enable row level security;
alter table lumen_private.operations enable row level security;
revoke all on public.lumen_profiles, public.lumen_teams, public.lumen_memberships, public.lumen_resources from public, anon, authenticated;
grant select on public.lumen_profiles, public.lumen_teams, public.lumen_memberships, public.lumen_resources to authenticated;
revoke all on lumen_private.invites, lumen_private.operations from public, anon, authenticated;

create function lumen_private.has_session() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null
    and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false'
    and coalesce((select auth.jwt())->>'exp', '') ~ '^[0-9]{1,12}$'
    and case when coalesce((select auth.jwt())->>'exp', '') ~ '^[0-9]{1,12}$'
      then ((select auth.jwt())->>'exp')::bigint > extract(epoch from now()) else false end
    and exists (
      select 1 from auth.sessions s join auth.users u on u.id = s.user_id
      where s.user_id = (select auth.uid())
        and s.id::text = ((select auth.jwt())->>'session_id')
        and (s.not_after is null or s.not_after > now())
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until < now())
        and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
    );
$$;
create function lumen_private.require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not lumen_private.has_session() then
    raise exception 'A current, confirmed account session is required' using errcode = '42501';
  end if;
  return (select auth.uid());
end;
$$;
create function lumen_private.is_member(p_team_id uuid, p_roles text[] default array['owner','editor','viewer']) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and lumen_private.has_session() and exists (
    select 1 from public.lumen_memberships m
    where m.team_id = p_team_id and m.user_id = (select auth.uid()) and m.role = any(p_roles)
  );
$$;
create function lumen_private.is_peer(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and lumen_private.has_session() and (
    p_user_id = (select auth.uid()) or exists (
      select 1 from public.lumen_memberships mine join public.lumen_memberships peer on peer.team_id = mine.team_id
      where mine.user_id = (select auth.uid()) and peer.user_id = p_user_id
    )
  );
$$;
create policy lumen_profiles_read on public.lumen_profiles for select to authenticated
  using (lumen_private.is_peer(id));
create policy lumen_teams_read on public.lumen_teams for select to authenticated
  using (lumen_private.is_member(id));
create policy lumen_memberships_read on public.lumen_memberships for select to authenticated
  using (lumen_private.is_member(team_id));
create policy lumen_resources_read on public.lumen_resources for select to authenticated
  using (lumen_private.is_member(team_id));

-- Reject operational/secret field names at any depth, including imported files.
-- Payload text is still user content; the UI must not offer a raw station export.
create function lumen_private.safe_document(p_value jsonb, p_depth integer default 0) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare entry record; item jsonb; normalized text;
begin
  if p_depth > 32 then return false; end if;
  if jsonb_typeof(p_value) = 'object' then
    for entry in select * from jsonb_each(p_value) loop
      normalized := regexp_replace(lower(entry.key), '[^a-z0-9]', '', 'g');
      if normalized in (
        'streamkey','streamkeys','password','secret','secrets','accesstoken','refreshtoken','authorization','cookie',
        'mainaudio','mainaudiosourceid','mainaudiosettings','masteraudio','masteraudiosourceid',
        'program','programsceneid','programsourceid','previewsceneid','previewsourceid','engine','runtime',
        'broadcast','broadcastsettings','recording','recordings','devices','deviceid','capturedeviceid',
        'livestate','channelrevision','autopublish','autoarmed','session','sessions','credentials',
        'src','url','sourceid','sources','audio','audioconfig','audiomix','output','outputs'
      ) or not lumen_private.safe_document(entry.value, p_depth + 1) then return false; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for item in select * from jsonb_array_elements(p_value) loop
      if not lumen_private.safe_document(item, p_depth + 1) then return false; end if;
    end loop;
  end if;
  return true;
end;
$$;
create function lumen_private.set_profile(p_display_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := lumen_private.require_user(); v_profile public.lumen_profiles;
begin
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 60 then
    raise exception 'Use a display name from 1 to 60 characters' using errcode = '22023';
  end if;
  insert into public.lumen_profiles(id, display_name) values(v_user, btrim(p_display_name))
    on conflict(id) do update set display_name = excluded.display_name, updated_at = now() returning * into v_profile;
  return to_jsonb(v_profile);
end;
$$;
create function lumen_private.create_team(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := lumen_private.require_user(); v_team public.lumen_teams;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Use a team name from 1 to 80 characters' using errcode = '22023';
  end if;
  -- Serialize account bootstrap to keep the free-tier test workspace bounded.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  if (select count(*) from public.lumen_teams where created_by = v_user) >= 5 then
    raise exception 'This account already owns five test teams' using errcode = '54000';
  end if;
  insert into public.lumen_profiles(id, display_name) values(v_user, 'Team member') on conflict(id) do nothing;
  insert into public.lumen_teams(name, created_by) values(btrim(p_name), v_user) returning * into v_team;
  insert into public.lumen_memberships(team_id, user_id, role) values(v_team.id, v_user, 'owner');
  return to_jsonb(v_team);
end;
$$;
create function lumen_private.create_invite(p_team_id uuid, p_role text default 'editor') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := lumen_private.require_user(); v_token text; v_expires timestamptz := now() + interval '24 hours';
begin
  perform 1 from public.lumen_teams where id = p_team_id for update;
  if not lumen_private.is_member(p_team_id, array['owner']) then raise exception 'Only a current team owner can invite members' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('editor', 'viewer') then raise exception 'Choose editor or viewer' using errcode = '22023'; end if;
  if (select count(*) from lumen_private.invites where team_id = p_team_id and used_at is null and expires_at > now()) >= 20 then
    raise exception 'This team already has twenty unused invitations' using errcode = '54000';
  end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into lumen_private.invites(team_id, token_hash, role, created_by, expires_at)
    values(p_team_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_role, v_user, v_expires);
  return jsonb_build_object('token', v_token, 'expires_at', v_expires, 'role', p_role);
end;
$$;
create function lumen_private.join_team(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := lumen_private.require_user(); v_invite lumen_private.invites; v_team public.lumen_teams;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Invitation is invalid or expired' using errcode = '22023'; end if;
  select * into v_invite from lumen_private.invites
    where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found or v_invite.expires_at <= now() or v_invite.used_at is not null then
    raise exception 'Invitation is invalid or expired' using errcode = '22023';
  end if;
  perform 1 from public.lumen_teams where id = v_invite.team_id for update;
  if not exists(select 1 from public.lumen_memberships where team_id = v_invite.team_id and user_id = v_invite.created_by and role = 'owner') then
    raise exception 'Invitation is invalid or expired' using errcode = '22023';
  end if;
  if (select count(*) from public.lumen_memberships where team_id = v_invite.team_id) >= 50 then
    raise exception 'This test team has reached fifty members' using errcode = '54000';
  end if;
  insert into public.lumen_profiles(id, display_name) values(v_user, 'Team member') on conflict(id) do nothing;
  -- An invite never downgrades an existing editor/owner or silently elevates a member.
  insert into public.lumen_memberships(team_id, user_id, role) values(v_invite.team_id, v_user, v_invite.role)
    on conflict(team_id, user_id) do nothing;
  update lumen_private.invites set used_by = v_user, used_at = now() where id = v_invite.id;
  select * into v_team from public.lumen_teams where id = v_invite.team_id;
  return to_jsonb(v_team);
end;
$$;
create function lumen_private.set_member_role(p_team_id uuid, p_user_id uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := lumen_private.require_user(); v_current text;
begin
  perform 1 from public.lumen_teams where id = p_team_id for update;
  if not lumen_private.is_member(p_team_id, array['owner']) then raise exception 'Only a current team owner can manage members' using errcode = '42501'; end if;
  if p_role is not null and p_role not in ('owner', 'editor', 'viewer') then raise exception 'Invalid team role' using errcode = '22023'; end if;
  select role into v_current from public.lumen_memberships where team_id = p_team_id and user_id = p_user_id for update;
  if not found then raise exception 'Team member was not found' using errcode = '22023'; end if;
  if v_current = 'owner' and p_role is distinct from 'owner'
    and (select count(*) from public.lumen_memberships where team_id = p_team_id and role = 'owner') <= 1 then
    raise exception 'A team must keep at least one owner' using errcode = '22023';
  end if;
  if p_role is null then
    delete from public.lumen_memberships where team_id = p_team_id and user_id = p_user_id;
  else
    update public.lumen_memberships set role = p_role where team_id = p_team_id and user_id = p_user_id;
  end if;
  return jsonb_build_object('user_id', p_user_id, 'role', p_role);
end;
$$;
create function lumen_private.save_resource(
  p_id uuid, p_team_id uuid, p_kind text, p_name text, p_document jsonb,
  p_base_revision bigint, p_operation_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := lumen_private.require_user(); v_resource public.lumen_resources;
  v_operation lumen_private.operations; v_hash text; v_status text;
begin
  -- All membership mutations take the same team lock, so a revoked editor
  -- cannot pass a stale authorization check while waiting for a draft lock.
  perform 1 from public.lumen_teams where id = p_team_id for update;
  if not lumen_private.is_member(p_team_id, array['owner', 'editor']) then
    raise exception 'Only a current team editor can save drafts' using errcode = '42501';
  end if;
  if p_id is null or p_operation_id is null or p_base_revision is null or p_base_revision < 0
    or p_kind is null or p_kind not in ('scene', 'presentation', 'scripture', 'lyrics')
    or p_name is null or char_length(btrim(p_name)) not between 1 and 120
    or p_document is null or jsonb_typeof(p_document) <> 'object'
    or p_document->'schemaVersion' is distinct from '1'::jsonb
    or octet_length(p_document::text) > 524288 or not lumen_private.safe_document(p_document) then
    raise exception 'Invalid editing draft. Live controls, credentials and audio/device settings are not syncable.' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(jsonb_build_array(p_id, p_team_id, p_kind, btrim(p_name), p_document, p_base_revision)::text, 'UTF8')), 'hex');
  -- Per-account operation lock prevents a duplicate request from being applied twice.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || p_operation_id::text, 0));
  select * into v_operation from lumen_private.operations where user_id = v_user and id = p_operation_id;
  if found then
    if v_operation.request_hash <> v_hash then raise exception 'Operation ID was reused for different content' using errcode = '22023'; end if;
    select * into v_resource from public.lumen_resources where id = v_operation.resource_id and team_id = p_team_id;
    return jsonb_build_object('status', v_operation.status, 'resource', to_jsonb(v_resource), 'replayed', true);
  end if;
  -- The row lock also covers create races and prevents a whole-document lost update.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 1));
  select * into v_resource from public.lumen_resources where id = p_id for update;
  if found then
    if v_resource.team_id <> p_team_id or v_resource.kind <> p_kind then
      raise exception 'Resource does not belong to this team and kind' using errcode = '42501';
    end if;
    if v_resource.revision <> p_base_revision then
      v_status := 'conflict';
    else
      update public.lumen_resources set name = btrim(p_name), document = p_document,
        revision = revision + 1, updated_by = v_user, updated_at = now() where id = p_id returning * into v_resource;
      v_status := 'saved';
    end if;
  else
    if p_base_revision <> 0 then raise exception 'Resource no longer exists; retain your offline copy' using errcode = '22023'; end if;
    if (select count(*) from public.lumen_resources where team_id = p_team_id) >= 1000 then
      raise exception 'This test team has reached one thousand shared drafts' using errcode = '54000';
    end if;
    insert into public.lumen_resources(id, team_id, kind, name, document, updated_by)
      values(p_id, p_team_id, p_kind, btrim(p_name), p_document, v_user) returning * into v_resource;
    v_status := 'saved';
  end if;
  insert into lumen_private.operations(user_id, id, resource_id, request_hash, status)
    values(v_user, p_operation_id, p_id, v_hash, v_status);
  -- Keep small idempotency receipts, not duplicate document snapshots.
  delete from lumen_private.operations where user_id = v_user and created_at < now() - interval '90 days';
  return jsonb_build_object('status', v_status, 'resource', to_jsonb(v_resource), 'replayed', false);
end;
$$;

create function public.lumen_set_profile(p_display_name text) returns jsonb language sql security invoker set search_path = ''
  as $$ select lumen_private.set_profile(p_display_name); $$;
create function public.lumen_create_team(p_name text) returns jsonb language sql security invoker set search_path = ''
  as $$ select lumen_private.create_team(p_name); $$;
create function public.lumen_create_invite(p_team_id uuid, p_role text default 'editor') returns jsonb language sql security invoker set search_path = ''
  as $$ select lumen_private.create_invite(p_team_id, p_role); $$;
create function public.lumen_join_team(p_token text) returns jsonb language sql security invoker set search_path = ''
  as $$ select lumen_private.join_team(p_token); $$;
create function public.lumen_set_member_role(p_team_id uuid, p_user_id uuid, p_role text) returns jsonb language sql security invoker set search_path = ''
  as $$ select lumen_private.set_member_role(p_team_id, p_user_id, p_role); $$;
create function public.lumen_save_resource(p_id uuid, p_team_id uuid, p_kind text, p_name text, p_document jsonb, p_base_revision bigint, p_operation_id uuid)
  returns jsonb language sql security invoker set search_path = ''
  as $$ select lumen_private.save_resource(p_id, p_team_id, p_kind, p_name, p_document, p_base_revision, p_operation_id); $$;

revoke all on all functions in schema lumen_private from public, anon, authenticated;
grant execute on function lumen_private.has_session(), lumen_private.require_user(), lumen_private.is_member(uuid,text[]),
  lumen_private.is_peer(uuid), lumen_private.set_profile(text), lumen_private.create_team(text),
  lumen_private.create_invite(uuid,text), lumen_private.join_team(text), lumen_private.set_member_role(uuid,uuid,text),
  lumen_private.save_resource(uuid,uuid,text,text,jsonb,bigint,uuid) to authenticated;
revoke all on function public.lumen_set_profile(text), public.lumen_create_team(text), public.lumen_create_invite(uuid,text),
  public.lumen_join_team(text), public.lumen_set_member_role(uuid,uuid,text), public.lumen_save_resource(uuid,uuid,text,text,jsonb,bigint,uuid) from public, anon, authenticated;
grant execute on function public.lumen_set_profile(text), public.lumen_create_team(text), public.lumen_create_invite(uuid,text),
  public.lumen_join_team(text), public.lumen_set_member_role(uuid,uuid,text), public.lumen_save_resource(uuid,uuid,text,text,jsonb,bigint,uuid) to authenticated;

-- Only membership-checked private rooms. Existing unrelated policies are left intact.
-- Clients send transient cursors, not sensitive documents or live commands here.
create policy lumen_team_presence_receive on realtime.messages for select to authenticated
  using (
    extension in ('broadcast', 'presence') and
    realtime.topic() ~ '^lumen-team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and
    lumen_private.is_member(case when realtime.topic() ~ '^lumen-team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then split_part(realtime.topic(), ':', 2)::uuid else null end)
  );
create policy lumen_team_presence_send on realtime.messages for insert to authenticated
  with check (
    extension in ('broadcast', 'presence') and
    realtime.topic() ~ '^lumen-team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and
    lumen_private.is_member(case when realtime.topic() ~ '^lumen-team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then split_part(realtime.topic(), ':', 2)::uuid else null end)
  );

-- Low-volume draft notifications; existing publication tables are untouched.
do $$
declare v_table text;
begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['lumen_profiles','lumen_teams','lumen_memberships','lumen_resources'] loop
      if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

comment on table public.lumen_resources is 'Shared editing drafts only; offline saves require revision checks. Never a production control plane.';
comment on schema lumen_private is 'Non-exposed team authorization, one-use invitation hashes and idempotency receipts.';

alter table public.lumen_teams replica identity full;
alter table public.lumen_memberships replica identity full;
alter table public.lumen_profiles replica identity full;
alter table public.lumen_resources replica identity full;
do $$
begin
  if not exists(select 1 from pg_publication where pubname = 'powersync') then
    create publication powersync for table public.lumen_teams, public.lumen_memberships, public.lumen_profiles, public.lumen_resources;
  elsif exists(select 1 from pg_publication_tables where pubname = 'powersync' and (schemaname <> 'public' or tablename not in ('lumen_teams','lumen_memberships','lumen_profiles','lumen_resources'))) then
    raise exception 'Existing powersync publication includes unrelated tables; review it before enabling Lumen sync';
  end if;
end;
$$;
