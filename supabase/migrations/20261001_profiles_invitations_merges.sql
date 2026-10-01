-- Apply after 20261001_executive_roster.sql.
begin;
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
commit;
