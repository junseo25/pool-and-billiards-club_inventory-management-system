-- Apply after 20261001_emeritus_members.sql.
begin;
create or replace function public.delete_member(member_id_to_delete uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.members%rowtype;
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  select * into target from public.members where id = member_id_to_delete for update;
  if not found then raise exception 'This member no longer exists.'; end if;
  if target.auth_user_id = auth.uid() then
    raise exception 'You cannot delete your own account. Another executive must do this.';
  end if;
  if exists(select 1 from public.equipment where member_id = target.id) then
    raise exception 'Return or reassign all equipment before deleting this member.';
  end if;
  -- Authentication accounts remain in Supabase, but a deleted member must not
  -- retain executive access or recreate their directory profile on next login.
  if target.auth_user_id is not null then
    delete from public.executive_access where user_id = target.auth_user_id;
  end if;
  delete from public.members where id = target.id;
  -- Activity IDs and name snapshots are intentionally retained for history.
end;
$$;
revoke all on function public.delete_member(uuid) from public, anon;
grant execute on function public.delete_member(uuid) to authenticated;
commit;
