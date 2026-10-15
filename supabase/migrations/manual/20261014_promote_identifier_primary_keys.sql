-- MANUAL STAGE 2 ONLY. Do not apply until identifier-audit.sql is clear.
-- UUIDs remain unique alternate keys so existing RPCs, loans, and history work.
begin;
lock table public.members, public.equipment in access exclusive mode;

do $$
declare missing_members integer; missing_equipment integer; duplicate_members integer; duplicate_equipment integer;
begin
  select count(*) into missing_members from public.members
    where uva_id is null or uva_id !~ '^[a-z][a-z0-9]*$';
  select count(*) into missing_equipment from public.equipment where btrim(serial) = '' or serial <> btrim(serial);
  select count(*) into duplicate_members from (select uva_id from public.members group by uva_id having count(*) > 1) d;
  select count(*) into duplicate_equipment from (select serial from public.equipment group by serial having count(*) > 1) d;
  if missing_members + missing_equipment + duplicate_members + duplicate_equipment > 0 then
    raise exception 'Key migration blocked: % missing/invalid member IDs, % missing/untrimmed serials, % duplicate member ID groups, % duplicate serial groups. Correct records first.',
      missing_members, missing_equipment, duplicate_members, duplicate_equipment;
  end if;
end;
$$;

-- Rebind dependent foreign keys to the UUID alternate keys without CASCADE.
create temporary table identifier_foreign_keys on commit drop as
select conrelid as relation_id, conname as constraint_name, pg_get_constraintdef(oid) as definition
from pg_constraint where contype = 'f' and confrelid in ('public.members'::regclass, 'public.equipment'::regclass);

do $$
declare item record; primary_name text;
begin
  for item in select * from identifier_foreign_keys loop
    execute format('alter table %s drop constraint %I', item.relation_id::regclass, item.constraint_name);
  end loop;
  if not exists(select 1 from pg_constraint where conrelid = 'public.members'::regclass and conname = 'members_uuid_key') then
    alter table public.members add constraint members_uuid_key unique(id);
  end if;
  if not exists(select 1 from pg_constraint where conrelid = 'public.equipment'::regclass and conname = 'equipment_uuid_key') then
    alter table public.equipment add constraint equipment_uuid_key unique(id);
  end if;
  select conname into primary_name from pg_constraint where contype = 'p' and conrelid = 'public.members'::regclass;
  if primary_name is not null then execute format('alter table public.members drop constraint %I', primary_name); end if;
  select conname into primary_name from pg_constraint where contype = 'p' and conrelid = 'public.equipment'::regclass;
  if primary_name is not null then execute format('alter table public.equipment drop constraint %I', primary_name); end if;
  alter table public.members add constraint members_pkey primary key(uva_id);
  alter table public.equipment add constraint equipment_pkey primary key(serial);
  alter table public.equipment alter column serial drop default;
  for item in select * from identifier_foreign_keys loop
    execute format('alter table %s add constraint %I %s', item.relation_id::regclass, item.constraint_name, item.definition);
  end loop;
end;
$$;
notify pgrst, 'reload schema';
commit;
