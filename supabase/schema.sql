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
