import { insertLegacyMember } from './legacy-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const cleanup = new URL('../supabase/migrations/20261001_database_function_cleanup.sql', import.meta.url)
const executive = '00000000-0000-0000-0000-000000000001'
const outsider = '00000000-0000-0000-0000-000000000099'

async function createDatabase() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create schema auth;
    grant usage on schema auth to anon, authenticated;
    create table auth.users(id uuid primary key, email text, phone text, invited_at timestamptz, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user_id',true),'')::uuid $$;`)
  await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
  await db.query("select set_config('test.user_id',$1,false)", [executive])
  await db.query('insert into auth.users(id,email,invited_at) values($1,$2,now())', [executive, 'exec@virginia.edu'])
  return db
}

test('browser metadata edits work while loans, history, account links and deletions require RPCs', async () => {
  const db = await createDatabase()
  try {
    await db.exec('set role authenticated')
    const member = (await db.query("insert into members(name,email,phone,year,is_emeritus) values('Alex','alex@virginia.edu','4345550123','2027',false) returning id")).rows[0].id
    const item = (await db.query("insert into equipment(name,category,cue_use,serial,member_id,updated_at) values('Case','Case','Not applicable','CA-123',null,now()) returning id")).rows[0].id
    await db.query("update equipment set name='Edited case',serial='CA-124' where id=$1", [item])
    await db.query("update members set phone='(434) 555-0123',is_emeritus=true where id=$1", [member])
    await assert.rejects(db.query('update equipment set member_id=$1 where id=$2', [member,item]), /permission denied/)
    await assert.rejects(db.query("insert into equipment(name,category,member_id) values('Bypass','Case',$1)", [member]), /reserve first/)
    await assert.rejects(db.query('delete from equipment where id=$1', [item]), /permission denied/)
    await assert.rejects(db.query('delete from members where id=$1', [member]), /permission denied/)
    await assert.rejects(db.query('update members set auth_user_id=$1 where id=$2', [executive,member]), /permission denied/)
    await assert.rejects(db.query('insert into members(name,auth_user_id) values($1,$2)', ['Bypass', outsider]), /permission denied/)
    await assert.rejects(db.query("insert into activity_log(action,gear_name,member_name) values('Returned','Fake','Fake')"), /permission denied/)
    for (const call of ["school_year_for_date(now())", "ensure_executive_member(null)", "merge_member_records(null,null)"]) {
      await assert.rejects(db.query(`select public.${call}`), /permission denied/)
    }
    await assert.rejects(db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [item,member]), /active member/)
    await db.query('update members set is_emeritus=false where id=$1', [member])
    await db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [item,member])
    await assert.rejects(db.query('select delete_member($1)', [member]), /Return or reassign/)
    await db.query("select * from record_equipment_handoff($1,'Returned')", [item])
    await db.query('select delete_member($1)', [member])
    await db.query("select * from record_equipment_handoff($1,'Removed')", [item])
    assert.equal((await db.query('select count(*)::int as n from activity_log where gear_id=$1', [item])).rows[0].n, 4)
    await db.query("select set_config('test.user_id',$1,false)", [outsider])
    for (const call of ["sync_member_roster('[]')", "complete_executive_profile('Alex','4345550123')", "merge_members(null,null)", "delete_member(null)", "start_school_year('2027/28','2027-08-25')", "delete_school_year(null)", "record_equipment_handoff(null,'Returned')"]) {
      await assert.rejects(db.query(`select public.${call}`), /Executive access required/)
    }
    assert.equal((await db.query('select * from members')).rows.length, 0, 'RLS hides records from unapproved accounts')
    await db.exec('set role anon')
    await assert.rejects(db.query("select public.sync_member_roster('[]')"), /permission denied/)
  } finally { await db.close() }
})

test('malformed roster imports roll back and normalized names update the same member', async () => {
  const db = await createDatabase()
  try {
    for (const invalid of [null, '{}', 'null', '[null]', '["Alex"]']) {
      await assert.rejects(db.query('select * from sync_member_roster($1::jsonb)', [invalid]), /Roster must be an array|entry must be an object/)
    }
    const member = (await db.query("insert into members(name,email,phone) values('Alex   Smith','old@virginia.edu','+1 434 555 0123') returning id")).rows[0].id
    await db.query('select * from sync_member_roster($1::jsonb)', [JSON.stringify([{name:' Alex Smith ',uva_id:'old',email:'new@virginia.edu',phone:'(434) 555-0123'}])])
    assert.equal((await db.query("select id from members where email='new@virginia.edu'")).rows[0].id, member)
    await assert.rejects(db.query('select * from sync_member_roster($1::jsonb)', [JSON.stringify([{name:'Must roll back',email:'rollback@virginia.edu'},42])]), /entry must be an object/)
    assert.equal((await db.query("select * from members where email='rollback@virginia.edu'")).rows.length, 0)
    await db.query('update members set email=$1 where auth_user_id=$2', ['second@virginia.edu',executive])
    await assert.rejects(db.query('insert into auth.users(id,email,invited_at) values($1,$2,now())', [outsider,'second@virginia.edu']), /another login account/)
    assert.equal((await db.query('select auth_user_id from members where email=$1', ['second@virginia.edu'])).rows[0].auth_user_id, executive)
  } finally { await db.close() }
})

test('ordered upgrades and repeated cleanup match fresh functions without changing club records', async () => {
  const db = await createDatabase()
  try {
    const inventory = (await db.query("insert into equipment(name,category,serial) values ('Case','Case','database-functions.test.mjs-1') returning id")).rows[0].id
    const member = (await insertLegacyMember(db, "insert into members(name) values('Alex') returning id")).rows[0].id
    await db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [inventory,member])
    const snapshot = async () => (await db.query(`select jsonb_build_object(
      'members',(select jsonb_agg(m order by id) from members m),
      'equipment',(select jsonb_agg(e order by id) from equipment e),
      'activity',(select jsonb_agg(a order by id) from activity_log a),
      'years',(select jsonb_agg(y order by id) from school_years y),
      'access',(select jsonb_agg(x order by user_id) from executive_access x)) as records`)).rows[0].records
    const definitions = async () => (await db.query("select n.nspname,proname,pg_get_functiondef(p.oid) as definition,proacl::text as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','club_private') order by n.nspname,proname,pg_get_function_identity_arguments(p.oid)")).rows
    const before = await snapshot()
    const fresh = await definitions()
    for (const name of ['approve_invited_executives','executive_roster','profiles_invitations_merges','school_year_history','emeritus_members','delete_members','delete_school_years','school_year_update_guard']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/20261001_${name}.sql`, import.meta.url), 'utf8'))
    }
    const migration = await readFile(cleanup, 'utf8')
    await db.exec(migration)
    await db.exec(migration)
    await db.exec(await readFile(new URL('../supabase/migrations/20261001_internal_function_access.sql', import.meta.url), 'utf8'))
    const hardening = await readFile(new URL('../supabase/migrations/20261001_security_advisor_hardening.sql', import.meta.url), 'utf8')
    await db.exec(hardening)
    await db.exec(hardening)
    await db.exec(await readFile(new URL('../supabase/migrations/20261014_collect_identifiers.sql', import.meta.url), 'utf8'))
    assert.deepEqual(await definitions(), fresh)
    assert.deepEqual(await snapshot(), before)
    const year = (await db.query("select * from start_school_year('2027/28','2027-08-25')")).rows.at(-1)
    await db.exec("insert into activity_log(action,gear_name,member_name,created_at) values('Returned','Future','Alex','2027-09-01 12:00:00-04')")
    await db.query('select * from delete_school_year($1)', [year.id])
    assert.equal((await db.query("select school_year from activity_log where gear_name='Future'")).rows[0].school_year, '2026/27')
  } finally { await db.close() }
})

test('internal automatic-RLS helper loses browser access while its event trigger keeps working', async () => {
  const db = await createDatabase()
  try {
    await db.exec(`create function public.rls_auto_enable() returns event_trigger
      language plpgsql security definer set search_path='pg_catalog' as $$
      declare command record;
      begin
        for command in select * from pg_event_trigger_ddl_commands() loop
          if command.object_type='table' and command.schema_name='public' then
            execute format('alter table %s enable row level security',command.object_identity);
          end if;
        end loop;
      end;
      $$;
      grant execute on function public.rls_auto_enable() to anon, authenticated;
      create event trigger test_automatic_rls on ddl_command_end when tag in ('CREATE TABLE')
        execute function public.rls_auto_enable();`)
    const sql = await readFile(new URL('../supabase/migrations/20261001_internal_function_access.sql', import.meta.url), 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    const permissions = (await db.query("select has_function_privilege('anon','public.rls_auto_enable()','execute') as anon, has_function_privilege('authenticated','public.rls_auto_enable()','execute') as authenticated")).rows[0]
    assert.deepEqual(permissions, { anon: false, authenticated: false })
    await db.exec('create table public.test_rls_table(id integer)')
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.test_rls_table'::regclass")).rows[0].relrowsecurity, true)
  } finally { await db.close() }
})
