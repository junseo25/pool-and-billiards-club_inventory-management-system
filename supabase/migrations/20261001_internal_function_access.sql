-- Apply after 20261001_database_function_cleanup.sql.
-- Supabase's automatic-RLS event trigger is internal, not a browser RPC.
begin;
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;
