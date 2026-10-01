-- Apply after 20261001_approve_invited_executives.sql.
begin;

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

commit;
