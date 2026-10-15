-- Apply after 20261001_internal_function_access.sql.
-- Preserve every RPC signature and all executive guards; do not change club data.
begin;

-- Privileged mutations live outside the exposed API schemas.
create schema if not exists club_private;
revoke all on schema club_private from public, anon, authenticated;
grant usage on schema club_private to authenticated;
alter default privileges in schema club_private revoke execute on functions from public, anon, authenticated;

-- Refuse deployment if this internal schema was added to the Data API.
do $$
begin
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema club_private to service_role';
  end if;
  if 'club_private' = any(array(select btrim(value) from unnest(string_to_array(
    coalesce(current_setting('pgrst.db_schemas', true), 'public'), ',')) as schemas(value))) then
    raise exception 'Remove club_private from the exposed Data API schemas before applying this migration.';
  end if;
end;
$$;

create or replace function public.is_club_executive()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.executive_access
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_club_executive() from public, anon;
grant execute on function public.is_club_executive() to authenticated;

create or replace function club_private.sync_member_roster(roster jsonb)
returns setof public.members language plpgsql security definer set search_path = '' as $$
declare
  entry jsonb;
  member_id uuid;
  candidates uuid[];
  member_name text;
  member_email text;
  member_phone text;
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  if jsonb_typeof(roster) is distinct from 'array' then raise exception 'Roster must be an array'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  for entry in select value from jsonb_array_elements(roster) loop
    if jsonb_typeof(entry) is distinct from 'object' then
      raise exception 'Each roster entry must be an object.';
    end if;
    member_name := btrim(coalesce(entry->>'name', ''));
    member_email := lower(btrim(coalesce(entry->>'email', '')));
    member_phone := regexp_replace(coalesce(entry->>'phone', ''), '[^0-9]', '', 'g');
    if length(member_phone) = 11 and left(member_phone, 1) = '1' then
      member_phone := substr(member_phone, 2);
    end if;
    if member_name = '' then continue; end if;
    select array_agg(id) into candidates from public.members
      where member_email <> '' and lower(btrim(email)) = member_email;
    if candidates is null and member_phone <> '' then
      select array_agg(id) into candidates from public.members
      where lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(regexp_replace(member_name, '\s+', ' ', 'g'))
        and regexp_replace(regexp_replace(phone, '[^0-9]', '', 'g'), '^1(?=[0-9]{10}$)', '') = member_phone;
    end if;
    -- A contactless record can be enriched, but names alone never merge
    -- records with different contact information.
    if candidates is null then
      select array_agg(id) into candidates from public.members
      where lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(regexp_replace(member_name, '\s+', ' ', 'g'))
        and btrim(email) = '' and btrim(phone) = '';
    end if;
    if cardinality(candidates) > 1 then
      raise exception 'Multiple members match %. Resolve duplicate contacts before importing.', member_name;
    end if;
    if candidates is null and member_email = '' and member_phone = '' and exists (
      select 1 from public.members
      where lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(regexp_replace(member_name, '\s+', ' ', 'g'))
    ) then
      raise exception 'Add an email or phone for % to match an existing member.', member_name;
    end if;
    member_id := candidates[1];
    if member_id is null then
      insert into public.members(name, email, phone, year)
      values(member_name, member_email, btrim(coalesce(entry->>'phone', '')), btrim(coalesce(entry->>'year', '')));
    else
      update public.members set name = member_name,
        email = coalesce(nullif(member_email, ''), email),
        phone = coalesce(nullif(btrim(entry->>'phone'), ''), phone),
        year = coalesce(nullif(btrim(entry->>'year'), ''), year)
      where id = member_id;
    end if;
  end loop;
  return query select * from public.members order by name;
end;
$$;
revoke all on function club_private.sync_member_roster(jsonb) from public, anon;
grant execute on function club_private.sync_member_roster(jsonb) to authenticated;

create or replace function club_private.merge_members(duplicate_id uuid, keep_id uuid)
returns setof public.members language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  perform public.merge_member_records(duplicate_id, keep_id);
  return query select * from public.members order by name;
end;
$$;
revoke all on function club_private.merge_members(uuid, uuid) from public, anon;
grant execute on function club_private.merge_members(uuid, uuid) to authenticated;

create or replace function club_private.complete_executive_profile(full_name text, phone_number text)
returns public.members language plpgsql security definer set search_path = '' as $$
declare
  account_id uuid := auth.uid();
  own_id uuid;
  candidates uuid[];
  member_name text := regexp_replace(btrim(coalesce(full_name, '')), '\s+', ' ', 'g');
  digits text := regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g');
  account_email text;
  formatted_phone text;
  result public.members%rowtype;
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  if length(digits) = 11 and left(digits, 1) = '1' then digits := substr(digits, 2); end if;
  if member_name = '' then raise exception 'Enter your full name.'; end if;
  if length(digits) <> 10 then raise exception 'Enter a 10-digit U.S. phone number.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  perform public.ensure_executive_member(account_id);
  select id into own_id from public.members where auth_user_id = account_id;
  select lower(btrim(email)) into account_email from auth.users where id = account_id;
  select array_agg(id) into candidates from public.members
  where id <> own_id and (
    lower(btrim(email)) = account_email
    or (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(member_name)
      and regexp_replace(regexp_replace(phone, '[^0-9]', '', 'g'), '^1(?=[0-9]{10}$)', '') = digits)
  );
  if cardinality(candidates) > 1 then
    raise exception 'Multiple roster entries match your details. Ask another executive to merge them in Members, then try again.';
  end if;
  if cardinality(candidates) = 1 then
    perform public.merge_member_records(own_id, candidates[1]);
    own_id := candidates[1];
  end if;
  formatted_phone := '(' || substr(digits,1,3) || ') ' || substr(digits,4,3) || '-' || substr(digits,7,4);
  update public.members set name = member_name, phone = formatted_phone,
    profile_completed_at = now() where id = own_id returning * into result;
  return result;
end;
$$;
revoke all on function club_private.complete_executive_profile(text, text) from public, anon;
grant execute on function club_private.complete_executive_profile(text, text) to authenticated;

create or replace function club_private.start_school_year(year_label text, year_start date)
returns setof public.school_years language plpgsql security definer set search_path = '' as $$
declare latest public.school_years%rowtype;
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 2);
  if year_start is null then raise exception 'Choose the school year start date.'; end if;
  if year_label is null or year_label !~ '^[0-9]{4}/[0-9]{2}$' then
    raise exception 'Use a school year such as 2026/27.';
  end if;
  if right(year_label,2)::integer <> (left(year_label,4)::integer + 1) % 100 then
    raise exception 'The school year must contain consecutive years, such as 2026/27.';
  end if;
  select * into latest from public.school_years order by start_date desc limit 1;
  if latest.id is not null and year_start <= latest.start_date then
    raise exception 'The new school year must start after %.', latest.start_date;
  end if;
  if latest.id is not null and left(year_label,4)::integer <= left(latest.label,4)::integer then
    raise exception 'Choose a school year later than %.', latest.label;
  end if;
  insert into public.school_years(label,start_date) values(year_label,year_start);
  -- A start date entered retrospectively assigns existing events to the correct
  -- period. Earlier events remain in their previous year, or unassigned.
  update public.activity_log a set school_year_id = public.school_year_for_date(a.created_at) where a.school_year_id is distinct from public.school_year_for_date(a.created_at);
  update public.activity_log a set school_year = y.label from public.school_years y
  where y.id = a.school_year_id and a.school_year is distinct from y.label;
  return query select * from public.school_years order by start_date;
end;
$$;
revoke all on function club_private.start_school_year(text,date) from public, anon;
grant execute on function club_private.start_school_year(text,date) to authenticated;

create or replace function club_private.record_equipment_handoff(equipment_id uuid, operation text, borrower_id uuid default null)
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
    -- Keep membership active through commit even if another executive edits it.
    perform 1 from public.members where id = borrower_id and not is_emeritus for share;
    if not found then
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
revoke all on function club_private.record_equipment_handoff(uuid,text,uuid) from public, anon;
grant execute on function club_private.record_equipment_handoff(uuid,text,uuid) to authenticated;

create or replace function club_private.delete_member(member_id_to_delete uuid)
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
revoke all on function club_private.delete_member(uuid) from public, anon;
grant execute on function club_private.delete_member(uuid) to authenticated;

create or replace function club_private.delete_school_year(year_id_to_delete uuid)
returns setof public.school_years language plpgsql security definer set search_path = '' as $$
declare target public.school_years%rowtype;
declare previous public.school_years%rowtype;
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 2);
  -- Activity assignment takes the same advisory lock. A table lock here
  -- would deadlock with an insert already waiting for the advisory lock.
  select * into target from public.school_years where id = year_id_to_delete for update;
  if not found then raise exception 'This school year no longer exists.'; end if;
  select * into previous from public.school_years where start_date < target.start_date order by start_date desc limit 1;
  if previous.id is null then raise exception 'The first school year cannot be deleted because it has no previous year.'; end if;
  update public.activity_log set school_year_id = previous.id, school_year = previous.label where school_year_id = target.id;
  delete from public.school_years where id = target.id;
  return query select * from public.school_years order by start_date;
end;
$$;
revoke all on function club_private.delete_school_year(uuid) from public, anon;
grant execute on function club_private.delete_school_year(uuid) to authenticated;

-- Preserve the browser RPC names and signatures using caller permissions.
create or replace function public.sync_member_roster(roster jsonb)
returns setof public.members language sql security invoker set search_path = '' as $$
  select * from club_private.sync_member_roster(roster);
$$;
revoke all on function public.sync_member_roster(jsonb) from public, anon;
grant execute on function public.sync_member_roster(jsonb) to authenticated;

create or replace function public.complete_executive_profile(full_name text, phone_number text)
returns public.members language sql security invoker set search_path = '' as $$
  select club_private.complete_executive_profile(full_name, phone_number);
$$;
revoke all on function public.complete_executive_profile(text,text) from public, anon;
grant execute on function public.complete_executive_profile(text,text) to authenticated;

create or replace function public.merge_members(duplicate_id uuid, keep_id uuid)
returns setof public.members language sql security invoker set search_path = '' as $$
  select * from club_private.merge_members(duplicate_id, keep_id);
$$;
revoke all on function public.merge_members(uuid,uuid) from public, anon;
grant execute on function public.merge_members(uuid,uuid) to authenticated;

create or replace function public.record_equipment_handoff(equipment_id uuid, operation text, borrower_id uuid default null)
returns public.activity_log language sql security invoker set search_path = '' as $$
  select club_private.record_equipment_handoff(equipment_id, operation, borrower_id);
$$;
revoke all on function public.record_equipment_handoff(uuid,text,uuid) from public, anon;
grant execute on function public.record_equipment_handoff(uuid,text,uuid) to authenticated;

create or replace function public.delete_member(member_id_to_delete uuid)
returns void language sql security invoker set search_path = '' as $$
  select club_private.delete_member(member_id_to_delete);
$$;
revoke all on function public.delete_member(uuid) from public, anon;
grant execute on function public.delete_member(uuid) to authenticated;

create or replace function public.start_school_year(year_label text, year_start date)
returns setof public.school_years language sql security invoker set search_path = '' as $$
  select * from club_private.start_school_year(year_label, year_start);
$$;
revoke all on function public.start_school_year(text,date) from public, anon;
grant execute on function public.start_school_year(text,date) to authenticated;

create or replace function public.delete_school_year(year_id_to_delete uuid)
returns setof public.school_years language sql security invoker set search_path = '' as $$
  select * from club_private.delete_school_year(year_id_to_delete);
$$;
revoke all on function public.delete_school_year(uuid) from public, anon;
grant execute on function public.delete_school_year(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
