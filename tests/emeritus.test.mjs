import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { isActiveMember, loanMessage, loanState } from '../src/lib/membership.ts'

test('reserve, active loans and emeritus loans have distinct equipment states', () => {
  assert.equal(loanState(null), 'reserve')
  assert.equal(loanState('active', { is_emeritus: false }), 'loaned')
  assert.equal(loanState('emeritus', { is_emeritus: true }), 'overdue')
  assert.equal(loanState('missing'), 'unverified')
  assert.equal(loanMessage('overdue'), 'Overdue — emeritus member')
  assert.equal(loanMessage('reserve'), 'In reserve')
  assert.equal(isActiveMember({ is_emeritus: true }), false)
  assert.equal(isActiveMember({}), true)
})

test('emeritus imports preserve status, existing loans can return, and new loans are blocked', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text, phone text, invited_at timestamptz, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;`)
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../supabase/migrations/20261001_emeritus_members.sql', import.meta.url), 'utf8'))
    await db.exec("insert into auth.users(id,email,invited_at) values('00000000-0000-0000-0000-000000000001','exec@virginia.edu',now())")
    const member = (await db.query("insert into members(name,email,phone) values('Alex','alex@virginia.edu','4345550123') returning id")).rows[0].id
    const item = (await db.query("insert into equipment(name,category) values('Case','Case') returning id")).rows[0].id
    await db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [item,member])
    await db.query('update members set is_emeritus=true where id=$1', [member])
    assert.equal((await db.query('select member_id from equipment where id=$1', [item])).rows[0].member_id, member)
    await db.query('select * from sync_member_roster($1::jsonb)', [JSON.stringify([{ name:'Alex', email:'alex@virginia.edu', phone:'(434) 555-0123' }])])
    assert.equal((await db.query('select is_emeritus from members where id=$1', [member])).rows[0].is_emeritus, true)
    await db.query("select * from record_equipment_handoff($1,'Returned')", [item])
    await assert.rejects(db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [item,member]), /Choose an active member/)
    assert.equal((await db.query('select member_id from equipment where id=$1', [item])).rows[0].member_id, null)
    const target = (await db.query("insert into members(name) values('Alex duplicate') returning id")).rows[0].id
    await db.query('select * from merge_members($1,$2)', [member,target])
    assert.equal((await db.query('select is_emeritus from members where id=$1', [target])).rows[0].is_emeritus, true, 'merge must not silently reactivate an emeritus member')
    assert.equal((await db.query("select member_id from activity_log where action='Checked out' and gear_id=$1", [item])).rows[0].member_id, target)
    await db.query('update members set is_emeritus=false where id=$1', [target])
    await db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [item,target])
    assert.equal((await db.query('select member_id from equipment where id=$1', [item])).rows[0].member_id, target, 'restored active member can borrow again')
  } finally { await db.close() }
})
