-- Apply after 20261001_school_year_history.sql.
begin;
alter table public.members add column if not exists is_emeritus boolean not null default false;
-- The function replacements below preserve emeritus status during merges and
-- reject new loans to emeritus members. Existing loans remain available to return.
create or replace function public.record_equipment_handoff(equipment_id uuid, operation text, borrower_id uuid default null)
returns public.activity_log language plpgsql security definer set search_path = '' as $$
declare item public.equipment%rowtype; event_borrower uuid; result public.activity_log%rowtype;
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  -- Shared with roster merging so loans and history never reference a member
  -- that is being merged away in another transaction.
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  perform pg_catalog.pg_advisory_xact_lock(61001, 2);
  select * into item from public.equipment where id = equipment_id for update;
  if not found then raise exception 'This equipment no longer exists.'; end if;
  if operation = 'Checked out' then
    if item.member_id is not null then raise exception 'This equipment is already checked out.'; end if;
    if borrower_id is null or not exists(select 1 from public.members where id = borrower_id and not is_emeritus) then
      raise exception 'Choose an active member. Emeritus members cannot receive new loans.';
    end if;
    event_borrower := borrower_id;
    update public.equipment set member_id = borrower_id,updated_at = now() where id = equipment_id;
  elsif operation = 'Returned' then
    if item.member_id is null then raise exception 'This equipment has already been returned.'; end if;
    event_borrower := item.member_id;
    update public.equipment set member_id = null,updated_at = now() where id = equipment_id;
  elsif operation = 'Removed' then
    event_borrower := item.member_id;
    delete from public.equipment where id = equipment_id;
  else raise exception 'Unsupported handoff action.';
  end if;
  result := public.append_equipment_activity(operation,item,event_borrower);
  return result;
end;
$$;
revoke all on function public.record_equipment_handoff(uuid,text,uuid) from public, anon;
grant execute on function public.record_equipment_handoff(uuid,text,uuid) to authenticated;

create or replace function public.merge_member_records(duplicate_id uuid, keep_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare duplicate public.members%rowtype; survivor public.members%rowtype;
begin
  if duplicate_id = keep_id then raise exception 'Choose a different member to merge into.'; end if;
  select * into duplicate from public.members where id = duplicate_id for update;
  if not found then raise exception 'The duplicate member no longer exists.'; end if;
  select * into survivor from public.members where id = keep_id for update;
  if not found then raise exception 'The destination member no longer exists.'; end if;
  if duplicate.auth_user_id is not null and survivor.auth_user_id is not null
    and duplicate.auth_user_id <> survivor.auth_user_id then
    raise exception 'These members belong to different login accounts and cannot be merged.';
  end if;
  update public.equipment set member_id = keep_id where member_id = duplicate_id;
  update public.activity_log set member_id = keep_id where member_id = duplicate_id;
  update public.members set auth_user_id = null where id = duplicate_id;
  update public.members set
    email = coalesce(nullif(btrim(survivor.email),''),duplicate.email),
    phone = coalesce(nullif(btrim(survivor.phone),''),duplicate.phone),
    year = coalesce(nullif(btrim(survivor.year),''),duplicate.year),
    auth_user_id = coalesce(survivor.auth_user_id,duplicate.auth_user_id),
    profile_completed_at = greatest(survivor.profile_completed_at,duplicate.profile_completed_at),
    invitation_sent_at = greatest(survivor.invitation_sent_at,duplicate.invitation_sent_at),
    is_emeritus = survivor.is_emeritus or duplicate.is_emeritus
  where id = keep_id;
  delete from public.members where id = duplicate_id;
end;
$$;
revoke all on function public.merge_member_records(uuid,uuid) from public, anon, authenticated;
commit;
