-- Run once in the Supabase SQL Editor for an existing project.
-- Supabase Auth writes invited_at for administrator-issued invitations.
begin;

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

  -- Only the initial invitation grants access. Later auth updates must not
  -- restore access that an administrator has deliberately revoked.
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

-- Include accounts invited before this migration, including accepted invites.
insert into public.executive_access (user_id, email)
select id, email from auth.users
where invited_at is not null and email is not null
on conflict (user_id) do nothing;

commit;
