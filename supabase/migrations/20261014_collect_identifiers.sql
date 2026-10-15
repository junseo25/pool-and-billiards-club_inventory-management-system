begin;

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
