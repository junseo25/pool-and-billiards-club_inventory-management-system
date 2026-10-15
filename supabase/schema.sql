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

create table if not exists public.executive_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null default '',
  phone text not null default '',
  year text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.equipment (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (category in ('Case', 'Shaft', 'Butt', 'Accessory')),
  cue_use text not null default 'Not applicable' check (cue_use in ('Playing', 'Break', 'Jump', 'Not applicable')),
  serial text not null default '',
  member_id uuid references public.members (id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint equipment_cue_use_matches_type check (
    (category in ('Shaft', 'Butt') and cue_use in ('Playing', 'Break', 'Jump'))
    or (category in ('Case', 'Accessory') and cue_use = 'Not applicable')
  )
);

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('Checked out', 'Returned', 'Removed')),
  gear_name text not null,
  member_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists equipment_member_id_idx on public.equipment (member_id);
create index if not exists equipment_updated_at_idx on public.equipment (updated_at desc);
create index if not exists activity_log_created_at_idx on public.activity_log (created_at desc);

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

alter table public.executive_access enable row level security;
alter table public.members enable row level security;
alter table public.equipment enable row level security;
alter table public.activity_log enable row level security;

drop policy if exists "Executives can read their own access" on public.executive_access;
create policy "Executives can read their own access"
  on public.executive_access for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Approved executives can manage members" on public.members;
create policy "Approved executives can manage members"
  on public.members for all to authenticated
  using ((select public.is_club_executive()))
  with check ((select public.is_club_executive()));

drop policy if exists "Approved executives can manage equipment" on public.equipment;
create policy "Approved executives can manage equipment"
  on public.equipment for all to authenticated
  using ((select public.is_club_executive()))
  with check ((select public.is_club_executive()));

drop policy if exists "Approved executives can read activity" on public.activity_log;
create policy "Approved executives can read activity"
  on public.activity_log for select to authenticated
  using ((select public.is_club_executive()));

revoke all on public.executive_access, public.members, public.equipment, public.activity_log from anon, authenticated;
grant select on public.executive_access to authenticated;
grant select on public.members, public.equipment, public.activity_log to authenticated;

-- Automatically approve administrator-invited accounts. For an existing
-- project, run migrations/20261001_approve_invited_executives.sql instead.
create or replace function public.approve_invited_executive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.invited_at is null or new.email is null then
    return new;
  end if;
  if TG_OP = 'UPDATE' then
    if old.invited_at is not null then
      return new;
    end if;
  end if;
  insert into public.executive_access (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;

revoke all on function public.approve_invited_executive() from public, anon, authenticated;
drop trigger if exists approve_invited_executive on auth.users;
create trigger approve_invited_executive
after insert or update of invited_at on auth.users
for each row execute function public.approve_invited_executive();

alter table public.members add column if not exists auth_user_id uuid
  unique references auth.users(id) on delete set null;

create or replace function public.ensure_executive_member(account_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  member_id uuid;
  account_name text;
  account auth.users%rowtype;
  candidates uuid[];
begin
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  select * into account from auth.users where id = account_id;
  if account.email is null then return; end if;
  account_name := coalesce(nullif(btrim(account.raw_user_meta_data->>'full_name'), ''),
    nullif(btrim(account.raw_user_meta_data->>'name'), ''), split_part(account.email, '@', 1));
  select id into member_id from public.members
    where auth_user_id = account.id;
  if member_id is not null then return; end if;
  if (select count(*) from public.members where lower(btrim(email)) = lower(btrim(account.email))) > 1 then
    raise exception 'Multiple roster records use this executive email. Merge them before linking the account.';
  end if;
  select id into member_id from public.members
    where lower(btrim(email)) = lower(btrim(account.email));
  if member_id is null and coalesce(account.phone, '') <> '' then
    select array_agg(id) into candidates from public.members
      where btrim(email) = ''
      and lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(regexp_replace(account_name, '\s+', ' ', 'g'))
      and regexp_replace(regexp_replace(phone, '[^0-9]', '', 'g'), '^1(?=[0-9]{10}$)', '')
        = regexp_replace(regexp_replace(account.phone, '[^0-9]', '', 'g'), '^1(?=[0-9]{10}$)', '');
    if cardinality(candidates) > 1 then raise exception 'Multiple members match this executive name and phone.'; end if;
    member_id := candidates[1];
  end if;
  if member_id is null then
    insert into public.members(name, email, phone, auth_user_id)
    values(account_name, account.email, coalesce(account.phone, ''), account.id);
  else
    if exists(select 1 from public.members where id = member_id
      and auth_user_id is not null and auth_user_id <> account.id) then
      raise exception 'This roster member already belongs to another login account.';
    end if;
    update public.members set auth_user_id = account.id, email = account.email where id = member_id;
  end if;
  return;
end;
$$;
revoke all on function public.ensure_executive_member(uuid) from public, anon, authenticated;

create or replace function public.add_executive_to_roster()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.ensure_executive_member(new.user_id);
  return new;
end;
$$;
revoke all on function public.add_executive_to_roster() from public, anon, authenticated;

drop trigger if exists executive_member_profile on public.executive_access;
create trigger executive_member_profile after insert on public.executive_access
for each row execute function public.add_executive_to_roster();

do $$ declare executive record;
begin
  for executive in select user_id from public.executive_access loop
    perform public.ensure_executive_member(executive.user_id);
  end loop;
end $$;

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

alter table public.members add column if not exists profile_completed_at timestamptz;
alter table public.members add column if not exists invitation_sent_at timestamptz;

-- Internal helper: callers must authorize and acquire the shared roster lock.
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

create table if not exists public.school_years (
  id uuid primary key default gen_random_uuid(),
  label text not null unique check (label ~ '^[0-9]{4}/[0-9]{2}$'),
  start_date date not null unique,
  created_at timestamptz not null default now(),
  check (right(label, 2)::integer = (left(label, 4)::integer + 1) % 100)
);
alter table public.school_years enable row level security;
drop policy if exists "Executives can read school years" on public.school_years;
create policy "Executives can read school years" on public.school_years for select to authenticated
using ((select public.is_club_executive()));
revoke all on public.school_years from anon, authenticated;
grant select on public.school_years to authenticated;

alter table public.activity_log add column if not exists gear_id uuid;
alter table public.activity_log add column if not exists member_id uuid;
alter table public.activity_log add column if not exists gear_serial text not null default '';
alter table public.activity_log add column if not exists gear_category text;
alter table public.activity_log add column if not exists gear_cue_use text;
alter table public.activity_log add column if not exists member_email text not null default '';
alter table public.activity_log add column if not exists actor_user_id uuid;
alter table public.activity_log add column if not exists actor_name text not null default '';
alter table public.activity_log add column if not exists actor_email text not null default '';
alter table public.activity_log add column if not exists school_year_id uuid references public.school_years(id);
alter table public.activity_log add column if not exists school_year text;
alter table public.activity_log drop constraint if exists activity_log_action_check;
alter table public.activity_log add constraint activity_log_action_check check (action in ('Added','Checked out','Returned','Removed'));
create index if not exists activity_log_gear_idx on public.activity_log(gear_id, created_at desc);
create index if not exists activity_log_member_idx on public.activity_log(member_id, created_at desc);
create index if not exists activity_log_school_year_idx on public.activity_log(school_year_id, created_at desc);

create or replace function public.school_year_for_date(event_date timestamptz)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.school_years
  where start_date <= (event_date at time zone 'America/New_York')::date
  order by start_date desc limit 1;
$$;
revoke all on function public.school_year_for_date(timestamptz) from public, anon, authenticated;

create or replace function public.assign_activity_school_year()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Share the year lock with additions, handoffs, and year changes.
  perform pg_catalog.pg_advisory_xact_lock(61001, 2);
  new.school_year_id := public.school_year_for_date(new.created_at);
  select label into new.school_year from public.school_years where id = new.school_year_id;
  return new;
end;
$$;
revoke all on function public.assign_activity_school_year() from public, anon, authenticated;
drop trigger if exists assign_activity_school_year on public.activity_log;
create trigger assign_activity_school_year before insert on public.activity_log
for each row execute function public.assign_activity_school_year();

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

create or replace function public.append_equipment_activity(event_action text, item public.equipment, borrower_id uuid)
returns public.activity_log language plpgsql security definer set search_path = '' as $$
declare
  borrower public.members%rowtype;
  executive public.members%rowtype;
  executive_email text;
  result public.activity_log%rowtype;
begin
  select * into borrower from public.members where id = borrower_id;
  select * into executive from public.members where auth_user_id = auth.uid();
  select email into executive_email from auth.users where id = auth.uid();
  perform pg_catalog.pg_advisory_xact_lock(61001, 2);
  insert into public.activity_log(action,gear_name,member_name,gear_id,member_id,
    gear_serial,gear_category,gear_cue_use,member_email,actor_user_id,actor_name,actor_email)
  values(event_action,item.name,coalesce(borrower.name,'Club inventory'),item.id,borrower.id,
    item.serial,item.category,item.cue_use,coalesce(borrower.email,''),auth.uid(),
    coalesce(executive.name,''),coalesce(executive_email,'')) returning * into result;
  return result;
end;
$$;
revoke all on function public.append_equipment_activity(text,public.equipment,uuid) from public, anon, authenticated;

create or replace function public.record_equipment_added()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.append_equipment_activity('Added',new,null);
  return new;
end;
$$;
revoke all on function public.record_equipment_added() from public, anon, authenticated;
drop trigger if exists record_equipment_added on public.equipment;
create trigger record_equipment_added after insert on public.equipment
for each row execute function public.record_equipment_added();

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

-- Keep stable history references when duplicate member records are merged.
-- Initial boundary selected by the club. Later years are created in Settings.
insert into public.school_years(label,start_date)
select '2026/27','2026-08-25'::date where not exists(select 1 from public.school_years);
update public.activity_log a set school_year_id = public.school_year_for_date(a.created_at) where a.school_year_id is distinct from public.school_year_for_date(a.created_at);
update public.activity_log a set school_year = y.label from public.school_years y where y.id = a.school_year_id;

alter table public.members add column if not exists is_emeritus boolean not null default false;
-- The function replacements below preserve emeritus status during merges and
-- reject new loans to emeritus members. Existing loans remain available to return.

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

-- Only RPCs may change loans, delete members/equipment, or append history.
-- Metadata edits remain available to the existing browser application.
revoke insert, update, delete on public.members, public.equipment, public.activity_log from anon, authenticated;
revoke insert (id, name, email, phone, year, created_at, auth_user_id, profile_completed_at, invitation_sent_at, is_emeritus),
  update (id, name, email, phone, year, created_at, auth_user_id, profile_completed_at, invitation_sent_at, is_emeritus)
  on public.members from anon, authenticated;
revoke insert (id, name, category, cue_use, serial, member_id, updated_at, created_at),
  update (id, name, category, cue_use, serial, member_id, updated_at, created_at)
  on public.equipment from anon, authenticated;
grant insert (name, email, phone, year, is_emeritus), update (name, email, phone, year, is_emeritus)
  on public.members to authenticated;
grant insert (name, category, cue_use, serial, member_id, updated_at), update (name, category, cue_use, serial)
  on public.equipment to authenticated;
drop policy if exists "Approved executives can add activity" on public.activity_log;

create or replace function public.require_reserve_equipment()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.member_id is not null then
    raise exception 'Add equipment to reserve first, then check it out to an active member.';
  end if;
  return new;
end;
$$;
revoke all on function public.require_reserve_equipment() from public, anon, authenticated;
drop trigger if exists require_reserve_equipment on public.equipment;
create trigger require_reserve_equipment before insert on public.equipment
for each row execute function public.require_reserve_equipment();

-- Some hosted projects include Supabase's internal automatic-RLS event trigger.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

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

-- Identifier collection, ahead of the optional primary-key cutover.
-- Stage 1: keep UUID primary keys and all existing loan/history references.
alter table public.members add column if not exists uva_id text;
alter table public.equipment add column if not exists serial_identity_checked boolean not null default false;

-- Only unambiguous, valid UVA email usernames can be backfilled automatically.
-- Duplicate or missing identities remain NULL for an executive to resolve.
update public.members m set uva_id = lower(split_part(btrim(m.email), '@', 1))
where nullif(btrim(m.uva_id), '') is null
  and lower(btrim(m.email)) ~ '^[a-z][a-z0-9]*@virginia\.edu$'
  and not exists (select 1 from public.members other where other.id <> m.id and (
    lower(btrim(other.email)) = lower(btrim(m.email))
    or lower(btrim(other.uva_id)) = lower(split_part(btrim(m.email), '@', 1))));

create index if not exists members_uva_id_idx on public.members(uva_id);
create index if not exists equipment_serial_idx on public.equipment(serial);
create unique index if not exists members_uva_id_unique_idx on public.members(uva_id) where uva_id is not null;
-- New/changed serials get a true unique index, even under concurrent writes.
-- Legacy duplicates stay intact until corrected for the final cutover.
create unique index if not exists equipment_verified_serial_unique_idx on public.equipment(serial) where serial_identity_checked;

create or replace function public.validate_member_identifier()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.uva_id := nullif(lower(btrim(new.uva_id)), '');
  if TG_OP = 'INSERT' and new.uva_id is null
    and lower(btrim(new.email)) ~ '^[a-z][a-z0-9]*@virginia\.edu$' then
    new.uva_id := lower(split_part(btrim(new.email), '@', 1));
  end if;
  if TG_OP = 'INSERT' and new.uva_id is null then
    raise exception 'A UVA computing ID is required for every new member.';
  end if;
  if TG_OP = 'UPDATE' and old.uva_id is not null and new.uva_id is null then
    raise exception 'An existing UVA computing ID cannot be cleared.';
  end if;
  if new.uva_id is not null and new.uva_id !~ '^[a-z][a-z0-9]*$' then
    raise exception 'Enter the UVA computing ID, without @virginia.edu.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  if new.uva_id is not null and (TG_OP = 'INSERT' or new.uva_id is distinct from old.uva_id)
    and exists(select 1 from public.members where uva_id = new.uva_id and id <> new.id) then
    raise exception 'This UVA computing ID already belongs to a member.';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_member_identifier() from public, anon, authenticated;
drop trigger if exists validate_member_identifier on public.members;
create trigger validate_member_identifier before insert or update of uva_id on public.members
for each row execute function public.validate_member_identifier();

create or replace function public.validate_equipment_identifier()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.serial := btrim(coalesce(new.serial, ''));
  if TG_OP = 'INSERT' then
    new.serial_identity_checked := true;
  elsif new.serial is distinct from old.serial then
    new.serial_identity_checked := true;
  else
    new.serial_identity_checked := old.serial_identity_checked;
  end if;
  if TG_OP = 'INSERT' and new.serial = '' then
    raise exception 'A manufacturer serial number is required for new equipment.';
  end if;
  if TG_OP = 'UPDATE' and btrim(old.serial) <> '' and new.serial = '' then
    raise exception 'An existing manufacturer serial number cannot be cleared.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  if new.serial <> '' and (TG_OP = 'INSERT' or new.serial is distinct from old.serial)
    and exists(select 1 from public.equipment where btrim(serial) = new.serial and id <> new.id) then
    raise exception 'This manufacturer serial number already belongs to equipment.';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_equipment_identifier() from public, anon, authenticated;
drop trigger if exists validate_equipment_identifier on public.equipment;
create trigger validate_equipment_identifier before insert or update of serial on public.equipment
for each row execute function public.validate_equipment_identifier();

grant insert (uva_id), update (uva_id) on public.members to authenticated;




create or replace function public.ensure_executive_member(account_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  member_id uuid;
  account_name text;
  account auth.users%rowtype;
  candidates uuid[];
begin
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  select * into account from auth.users where id = account_id;
  if account.email is null then return; end if;
  account_name := coalesce(nullif(btrim(account.raw_user_meta_data->>'full_name'), ''),
    nullif(btrim(account.raw_user_meta_data->>'name'), ''), split_part(account.email, '@', 1));
  select id into member_id from public.members
    where auth_user_id = account.id;
  if member_id is not null then return; end if;
  if (select count(*) from public.members where lower(btrim(email)) = lower(btrim(account.email))) > 1 then
    raise exception 'Multiple roster records use this executive email. Merge them before linking the account.';
  end if;
  select id into member_id from public.members
    where lower(btrim(email)) = lower(btrim(account.email));
  if member_id is null and coalesce(account.phone, '') <> '' then
    select array_agg(id) into candidates from public.members
      where btrim(email) = ''
      and lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(regexp_replace(account_name, '\s+', ' ', 'g'))
      and regexp_replace(regexp_replace(phone, '[^0-9]', '', 'g'), '^1(?=[0-9]{10}$)', '')
        = regexp_replace(regexp_replace(account.phone, '[^0-9]', '', 'g'), '^1(?=[0-9]{10}$)', '');
    if cardinality(candidates) > 1 then raise exception 'Multiple members match this executive name and phone.'; end if;
    member_id := candidates[1];
  end if;
  if member_id is null then
    if lower(btrim(account.email)) !~ '^[a-z][a-z0-9]*@virginia\.edu$' then return; end if;
    insert into public.members(name, email, phone, auth_user_id)
    values(account_name, account.email, coalesce(account.phone, ''), account.id);
  else
    if exists(select 1 from public.members where id = member_id
      and auth_user_id is not null and auth_user_id <> account.id) then
      raise exception 'This roster member already belongs to another login account.';
    end if;
    update public.members set auth_user_id = account.id, email = account.email where id = member_id;
  end if;
  return;
end;
$$;

create or replace function club_private.sync_member_roster(roster jsonb)
returns setof public.members language plpgsql security definer set search_path = '' as $$
declare
  entry jsonb;
  member_id uuid;
  candidates uuid[];
  member_name text;
  member_email text;
  member_phone text;
  member_uva_id text;
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
    member_uva_id := nullif(lower(btrim(entry->>'uva_id')), '');
    if member_uva_id is null and member_email ~ '^[a-z][a-z0-9]*@virginia\.edu$' then
      member_uva_id := split_part(member_email, '@', 1);
    end if;
    member_phone := regexp_replace(coalesce(entry->>'phone', ''), '[^0-9]', '', 'g');
    if length(member_phone) = 11 and left(member_phone, 1) = '1' then
      member_phone := substr(member_phone, 2);
    end if;
    if member_name = '' then continue; end if;
    select array_agg(id) into candidates from public.members where member_uva_id is not null and uva_id = member_uva_id;
    if candidates is null then
      select array_agg(id) into candidates from public.members
        where member_email <> '' and lower(btrim(email)) = member_email;
    end if;
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
      insert into public.members(name, email, phone, year, uva_id)
      values(member_name, member_email, btrim(coalesce(entry->>'phone', '')), btrim(coalesce(entry->>'year', '')), member_uva_id);
    else
      if member_uva_id is not null and exists(select 1 from public.members where id = member_id and uva_id is not null and uva_id <> member_uva_id) then
        raise exception 'The roster computing ID conflicts with this member. Correct the ID before importing.';
      end if;
      update public.members set name = member_name, uva_id = coalesce(member_uva_id, uva_id),
        email = coalesce(nullif(member_email, ''), email),
        phone = coalesce(nullif(btrim(entry->>'phone'), ''), phone),
        year = coalesce(nullif(btrim(entry->>'year'), ''), year)
      where id = member_id;
    end if;
  end loop;
  return query select * from public.members order by name;
end;
$$;

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
  if duplicate.uva_id is not null and survivor.uva_id is not null and duplicate.uva_id <> survivor.uva_id then
    raise exception 'Members with different UVA computing IDs cannot be merged.';
  end if;
  update public.equipment set member_id = keep_id where member_id = duplicate_id;
  update public.activity_log set member_id = keep_id where member_id = duplicate_id;
  update public.members set auth_user_id = null where id = duplicate_id;
  delete from public.members where id = duplicate_id;
  update public.members set
    uva_id = coalesce(survivor.uva_id, duplicate.uva_id),
    email = coalesce(nullif(btrim(survivor.email),''),duplicate.email),
    phone = coalesce(nullif(btrim(survivor.phone),''),duplicate.phone),
    year = coalesce(nullif(btrim(survivor.year),''),duplicate.year),
    auth_user_id = coalesce(survivor.auth_user_id,duplicate.auth_user_id),
    profile_completed_at = greatest(survivor.profile_completed_at,duplicate.profile_completed_at),
    invitation_sent_at = greatest(survivor.invitation_sent_at,duplicate.invitation_sent_at),
    is_emeritus = survivor.is_emeritus or duplicate.is_emeritus
  where id = keep_id;
end;
$$;

create or replace function public.sync_member_roster(roster jsonb)
returns setof public.members language sql security invoker set search_path = '' as $$
  select * from club_private.sync_member_roster(roster);
$$;

create or replace function public.merge_members(duplicate_id uuid, keep_id uuid)
returns setof public.members language sql security invoker set search_path = '' as $$
  select * from club_private.merge_members(duplicate_id, keep_id);
$$;


create or replace function club_private.complete_executive_profile(full_name text, phone_number text, computing_id text)
returns public.members language plpgsql security definer set search_path = '' as $$
declare
  account_id uuid := auth.uid();
  own public.members%rowtype;
  candidate public.members%rowtype;
  account_email text;
  identifier text := nullif(lower(btrim(computing_id)), '');
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  perform public.ensure_executive_member(account_id);
  select * into own from public.members where auth_user_id = account_id;
  select lower(btrim(email)) into account_email from auth.users where id = account_id;
  identifier := coalesce(identifier, own.uva_id);
  if identifier is null and account_email ~ '^[a-z][a-z0-9]*@virginia\.edu$' then
    identifier := split_part(account_email, '@', 1);
  end if;
  if identifier is null or identifier !~ '^[a-z][a-z0-9]*$' then
    raise exception 'Enter your UVA computing ID, without @virginia.edu.';
  end if;
  if own.uva_id is not null and own.uva_id <> identifier then
    raise exception 'This computing ID differs from your linked member record. Ask an executive to correct the record.';
  end if;
  select * into candidate from public.members where uva_id = identifier and id is distinct from own.id;
  if candidate.id is not null then
    if candidate.auth_user_id is not null and candidate.auth_user_id <> account_id then
      raise exception 'This computing ID belongs to another linked account.';
    end if;
    if own.id is not null then
      perform public.merge_member_records(own.id, candidate.id);
    else
      update public.members set auth_user_id = account_id where id = candidate.id;
    end if;
  elsif own.id is null then
    insert into public.members(name, email, phone, auth_user_id, uva_id)
    values(full_name, account_email, phone_number, account_id, identifier);
  else
    update public.members set uva_id = identifier where id = own.id;
  end if;
  return club_private.complete_executive_profile(full_name, phone_number);
end;
$$;
revoke all on function club_private.complete_executive_profile(text,text,text) from public, anon;
grant execute on function club_private.complete_executive_profile(text,text,text) to authenticated;

drop function if exists public.complete_executive_profile(text,text);
create or replace function public.complete_executive_profile(full_name text, phone_number text, computing_id text default null)
returns public.members language sql security invoker set search_path = '' as $$
  select club_private.complete_executive_profile(full_name, phone_number, computing_id);
$$;
revoke all on function public.complete_executive_profile(text,text,text) from public, anon;
grant execute on function public.complete_executive_profile(text,text,text) to authenticated;


notify pgrst, 'reload schema';
commit;
