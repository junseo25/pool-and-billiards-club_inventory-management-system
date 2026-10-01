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
security definer
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

drop policy if exists "Approved executives can add activity" on public.activity_log;
create policy "Approved executives can add activity"
  on public.activity_log for insert to authenticated
  with check ((select public.is_club_executive()));

revoke all on public.executive_access, public.members, public.equipment, public.activity_log from anon, authenticated;
grant select on public.executive_access to authenticated;
grant select, insert, update, delete on public.members, public.equipment to authenticated;
grant select, insert on public.activity_log to authenticated;

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
-- Apply after 20261001_approve_invited_executives.sql.


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

create or replace function public.sync_member_roster(roster jsonb)
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
  if jsonb_typeof(roster) <> 'array' then raise exception 'Roster must be an array'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  for entry in select value from jsonb_array_elements(roster) loop
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
        and regexp_replace(regexp_replace(phone, '[^0-9]', '', 'g'), '^1(?=[0-9]{10}$)', '') = member_phone
        and (member_email = '' or btrim(email) = '' or lower(btrim(email)) = member_email);
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
revoke all on function public.sync_member_roster(jsonb) from public, anon;
grant execute on function public.sync_member_roster(jsonb) to authenticated;

-- Apply after 20261001_executive_roster.sql.

alter table public.members add column if not exists profile_completed_at timestamptz;
alter table public.members add column if not exists invitation_sent_at timestamptz;

-- Internal helper: callers must authorize and acquire the shared roster lock.
create or replace function public.merge_member_records(duplicate_id uuid, keep_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  duplicate public.members%rowtype;
  survivor public.members%rowtype;
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
  -- Release the unique login link before moving it to the survivor.
  update public.members set auth_user_id = null where id = duplicate_id;
  update public.members set
    email = coalesce(nullif(btrim(survivor.email), ''), duplicate.email),
    phone = coalesce(nullif(btrim(survivor.phone), ''), duplicate.phone),
    year = coalesce(nullif(btrim(survivor.year), ''), duplicate.year),
    auth_user_id = coalesce(survivor.auth_user_id, duplicate.auth_user_id),
    profile_completed_at = greatest(survivor.profile_completed_at, duplicate.profile_completed_at),
    invitation_sent_at = greatest(survivor.invitation_sent_at, duplicate.invitation_sent_at)
  where id = keep_id;
  delete from public.members where id = duplicate_id;
end;
$$;
revoke all on function public.merge_member_records(uuid, uuid) from public, anon, authenticated;

create or replace function public.merge_members(duplicate_id uuid, keep_id uuid)
returns setof public.members language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  perform public.merge_member_records(duplicate_id, keep_id);
  return query select * from public.members order by name;
end;
$$;
revoke all on function public.merge_members(uuid, uuid) from public, anon;
grant execute on function public.merge_members(uuid, uuid) to authenticated;

create or replace function public.complete_executive_profile(full_name text, phone_number text)
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
revoke all on function public.complete_executive_profile(text, text) from public, anon;
grant execute on function public.complete_executive_profile(text, text) to authenticated;

-- Apply after 20261001_profiles_invitations_merges.sql.


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
  new.school_year_id := public.school_year_for_date(new.created_at);
  select label into new.school_year from public.school_years where id = new.school_year_id;
  return new;
end;
$$;
revoke all on function public.assign_activity_school_year() from public, anon, authenticated;
drop trigger if exists assign_activity_school_year on public.activity_log;
create trigger assign_activity_school_year before insert on public.activity_log
for each row execute function public.assign_activity_school_year();

create or replace function public.start_school_year(year_label text, year_start date)
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
  update public.activity_log a set school_year = y.label from public.school_years y where y.id = a.school_year_id;
  return query select * from public.school_years order by start_date;
end;
$$;
revoke all on function public.start_school_year(text,date) from public, anon;
grant execute on function public.start_school_year(text,date) to authenticated;

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
    if borrower_id is null or not exists(select 1 from public.members where id = borrower_id) then
      raise exception 'Choose a valid member.';
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

-- Keep stable history references when duplicate member records are merged.
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
    invitation_sent_at = greatest(survivor.invitation_sent_at,duplicate.invitation_sent_at)
  where id = keep_id;
  delete from public.members where id = duplicate_id;
end;
$$;
revoke all on function public.merge_member_records(uuid,uuid) from public, anon, authenticated;

create or replace function public.sync_member_roster(roster jsonb)
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
  if jsonb_typeof(roster) <> 'array' then raise exception 'Roster must be an array'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 1);
  for entry in select value from jsonb_array_elements(roster) loop
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
revoke all on function public.sync_member_roster(jsonb) from public, anon;
grant execute on function public.sync_member_roster(jsonb) to authenticated;

-- Initial boundary selected by the club. Later years are created in Settings.
insert into public.school_years(label,start_date)
select '2026/27','2026-08-25'::date where not exists(select 1 from public.school_years);
update public.activity_log a set school_year_id = public.school_year_for_date(a.created_at) where a.school_year_id is distinct from public.school_year_for_date(a.created_at);
update public.activity_log a set school_year = y.label from public.school_years y where y.id = a.school_year_id;

-- Apply after 20261001_school_year_history.sql.

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

-- Apply after 20261001_emeritus_members.sql.

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
begin;
create or replace function public.delete_school_year(year_id_to_delete uuid)
returns setof public.school_years language plpgsql security definer set search_path = '' as $$
declare target public.school_years%rowtype;
declare previous public.school_years%rowtype;
begin
  if not public.is_club_executive() then raise exception 'Executive access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(61001, 2);
  -- Serialize with activity inserts so no event can retain the removed year.
  lock table public.activity_log in share row exclusive mode;
  select * into target from public.school_years where id = year_id_to_delete for update;
  if not found then raise exception 'This school year no longer exists.'; end if;
  select * into previous from public.school_years where start_date < target.start_date order by start_date desc limit 1;
  if previous.id is null then raise exception 'The first school year cannot be deleted because it has no previous year.'; end if;
  update public.activity_log set school_year_id = previous.id, school_year = previous.label where school_year_id = target.id;
  delete from public.school_years where id = target.id;
  return query select * from public.school_years order by start_date;
end;
$$;
revoke all on function public.delete_school_year(uuid) from public, anon;
grant execute on function public.delete_school_year(uuid) to authenticated;
commit;
