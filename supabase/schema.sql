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
