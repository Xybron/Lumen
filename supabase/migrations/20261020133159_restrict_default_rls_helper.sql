-- LAB's platform-created event-trigger helper is not an application RPC.
-- Keep its event-trigger behaviour while removing needless client execution.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='rls_auto_enable' and p.prorettype='event_trigger'::regtype) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
