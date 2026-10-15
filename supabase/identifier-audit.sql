-- Read-only readiness checks. Every query must return zero rows before stage 2.
select id, name, uva_id from public.members
where uva_id is null or uva_id !~ '^[a-z][a-z0-9]*$';
select id, name, serial from public.equipment
where btrim(serial) = '' or serial <> btrim(serial);
select uva_id, count(*) from public.members where uva_id is not null group by uva_id having count(*) > 1;
select serial, count(*) from public.equipment where btrim(serial) <> '' group by serial having count(*) > 1;
