import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const migration = new URL('../supabase/migrations/20261001_security_advisor_hardening.sql', import.meta.url)
const executive = '00000000-0000-0000-0000-000000000001'
const outsider = '00000000-0000-0000-0000-000000000099'
const mutations = ["sync_member_roster('[]')", "complete_executive_profile('Alex','4345550123')", 'merge_members(null,null)', "record_equipment_handoff(null,'Returned')", 'delete_member(null)', "start_school_year('2027/28','2027-08-25')", 'delete_school_year(null)']

async function database() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges grant execute on functions to service_role;
    create schema auth; grant usage on schema auth to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email text,phone text,invited_at timestamptz,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user_id',true),'')::uuid $$;`)
  await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
  await db.query("select set_config('test.user_id',$1,false)", [executive])
  await db.query('insert into auth.users(id,email,invited_at) values($1,$2,now())', [executive,'exec@virginia.edu'])
  return db
}

test('public RPCs need no elevated privileges and private mutations enforce executive access', async () => {
  const db = await database()
  try {
    // Supabase's exposed-function advisor check: no elevated public function
    // may be executable by either browser role.
    const exposed = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef
      and (has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute'))`)).rows
    assert.deepEqual(exposed, [])
    assert.equal((await db.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='club_private' and p.prosecdef")).rows[0].n, 8)
    await db.exec('set role authenticated')
    assert.equal((await db.query('select public.is_club_executive() as executive')).rows[0].executive, true)
    assert.equal((await db.query('select * from public.executive_access')).rows.length, 1)
    await db.query("select * from public.sync_member_roster('[{\"name\":\"Alex\",\"email\":\"alex@virginia.edu\"}]')")
    const member = (await db.query("select id from members where email='alex@virginia.edu'")).rows[0].id
    const item = (await db.query("insert into equipment(name,category,serial) values ('Case','Case','security-advisor.test.mjs-1') returning id")).rows[0].id
    const added = (await db.query('select * from activity_log where gear_id=$1', [item])).rows[0]
    const checkout = (await db.query("select * from public.record_equipment_handoff($1,'Checked out',$2)", [item,member])).rows[0]
    assert.equal(checkout.actor_user_id, executive)
    assert.equal(checkout.actor_email, 'exec@virginia.edu')
    assert.equal(added.actor_user_id, executive, 'triggers preserve the real caller identity')
    assert.equal((await db.query('select count(*)::int as n from activity_log where gear_id=$1', [item])).rows[0].n, 2, 'a wrapper invokes its mutation once')
    await db.query("select * from public.record_equipment_handoff($1,'Returned')", [item])
    const profile = (await db.query("select * from public.complete_executive_profile('Executive','4345550123')")).rows[0]
    assert.equal(profile.auth_user_id, executive)
    assert.ok(profile.profile_completed_at)
    await db.query("select set_config('test.user_id',$1,false)", [outsider])
    assert.equal((await db.query('select public.is_club_executive() as executive')).rows[0].executive, false)
    assert.deepEqual((await db.query('select * from executive_access')).rows, [])
    for (const call of mutations) {
      await assert.rejects(db.query(`select public.${call}`), /Executive access required/)
      await assert.rejects(db.query(`select club_private.${call}`), /Executive access required/)
    }
    await assert.rejects(db.exec('create function club_private.bypass() returns boolean language sql as $$ select true $$'), /permission denied/)
    await db.exec('set role anon')
    for (const call of mutations) {
      await assert.rejects(db.query(`select public.${call}`), /permission denied/)
      await assert.rejects(db.query(`select club_private.${call}`), /permission denied/)
    }
    await db.exec('set role service_role')
    await db.query("select set_config('test.user_id',$1,false)", [executive])
    assert.ok((await db.query("select * from public.sync_member_roster('[]')")).rows.length > 0, 'server-side callers retain RPC access')
  } finally { await db.close() }
})

test('hardening refuses an exposed private schema and rolls the migration back', async () => {
  const db = await database()
  try {
    await db.exec("set pgrst.db_schemas='public, club_private'")
    await assert.rejects(db.exec(await readFile(migration,'utf8')), /Remove club_private/)
    await db.exec('rollback')
    assert.equal((await db.query('select public.is_club_executive() as executive')).rows[0].executive, true)
  } finally { await db.close() }
})
