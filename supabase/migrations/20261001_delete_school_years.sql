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
