import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('member deletion protects loans and own account, preserves history, and revokes linked access', async () => {
  const db = new PGlite()
  const caller = '00000000-0000-0000-0000-000000000001'
  const other = '00000000-0000-0000-0000-000000000002'
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text, phone text, invited_at timestamptz, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user_id',true),'')::uuid $$;`)
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../supabase/migrations/20261001_delete_members.sql', import.meta.url), 'utf8'))
    await db.query("select set_config('test.user_id',$1,false)", [caller])
    await db.query('insert into auth.users(id,email,invited_at) values($1,$2,now()),($3,$4,now())', [caller,'exec@virginia.edu',other,'other@virginia.edu'])
    const own = (await db.query('select id from members where auth_user_id=$1', [caller])).rows[0].id
    await assert.rejects(db.query('select delete_member($1)', [own]), /cannot delete your own/)
    const member = (await db.query("insert into members(name) values('Alex') returning id")).rows[0].id
    const item = (await db.query("insert into equipment(name,category) values('Case','Case') returning id")).rows[0].id
    await db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [item,member])
    await assert.rejects(db.query('select delete_member($1)', [member]), /Return or reassign/)
    assert.equal((await db.query('select count(*)::int as n from members where id=$1', [member])).rows[0].n, 1)
    await db.query("select * from record_equipment_handoff($1,'Returned')", [item])
    await db.query('update members set is_emeritus=true where id=$1', [member])
    await db.query('select delete_member($1)', [member])
    assert.equal((await db.query('select count(*)::int as n from members where id=$1', [member])).rows[0].n, 0)
    assert.equal((await db.query("select member_id from activity_log where gear_id=$1 and action='Checked out'", [item])).rows[0].member_id, member)
    assert.equal((await db.query('select member_id from equipment where id=$1', [item])).rows[0].member_id, null)
    const linked = (await db.query('select id from members where auth_user_id=$1', [other])).rows[0].id
    await db.query('select delete_member($1)', [linked])
    assert.equal((await db.query('select count(*)::int as n from executive_access where user_id=$1', [other])).rows[0].n, 0)
    assert.equal((await db.query('select count(*)::int as n from auth.users where id=$1', [other])).rows[0].n, 1)
    await db.query("select set_config('test.user_id',$1,false)", [other])
    await assert.rejects(db.query('select delete_member($1)', [own]), /Executive access required/)
  } finally { await db.close() }
})
