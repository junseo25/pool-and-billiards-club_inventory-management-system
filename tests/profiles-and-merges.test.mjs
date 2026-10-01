import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { formatUsPhone, usPhoneDigits } from '../src/lib/phone.ts'

test('U.S. phones format partial typing, full numbers and country codes', () => {
  assert.equal(formatUsPhone(''), '')
  assert.equal(formatUsPhone('434'), '(434')
  assert.equal(formatUsPhone('4345'), '(434) 5')
  assert.equal(formatUsPhone('4345550123'), '(434) 555-0123')
  assert.equal(formatUsPhone('+1 (434) 555-0123'), '(434) 555-0123')
  assert.equal(usPhoneDigits('(434) 555-0123'), '4345550123')
})

test('first-login profile matches an earlier roster; manual merges keep loans and account links', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text, phone text,
        invited_at timestamptz, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql as
        $$ select coalesce(nullif(current_setting('app.test_user', true), ''),
        '00000000-0000-0000-0000-000000000001')::uuid $$;
    `)
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../supabase/migrations/20261001_profiles_invitations_merges.sql', import.meta.url), 'utf8'))
    const original = (await db.query("insert into members(name,email,phone,year) values('Alex Smith','old@virginia.edu','+1 434 555 0123','2027') returning id")).rows[0].id
    await db.exec(`insert into auth.users(id,email,invited_at) values
      ('00000000-0000-0000-0000-000000000001','new@virginia.edu',now());`)
    const placeholder = (await db.query('select id from members where auth_user_id=auth.uid()')).rows[0].id
    await db.query("insert into equipment(name, category, member_id) values ('Old loan', 'Case', $1), ('New loan', 'Case', $2)", [original, placeholder])
    await assert.rejects(db.query("select * from complete_executive_profile('Alex Smith','123')"), /10-digit/)
    const profile = (await db.query("select * from complete_executive_profile(' Alex   Smith ','4345550123')")).rows[0]
    assert.equal(profile.id, original)
    assert.equal(profile.name, 'Alex Smith')
    assert.equal(profile.phone, '(434) 555-0123')
    assert.equal(profile.year, '2027')
    assert.ok(profile.profile_completed_at)
    assert.equal((await db.query('select * from members')).rows.length, 1)
    assert.ok((await db.query('select member_id from equipment')).rows.every((row) => row.member_id === original))
    assert.equal((await db.query("select * from complete_executive_profile('Alex Smith','4345550123')")).rows[0].id, original, 'profile retry is idempotent')
    const keeper = (await db.query("insert into members(name,email,phone) values('Alex S','','') returning id")).rows[0].id
    await db.query('select * from merge_members($1,$2)', [original, keeper])
    const merged = (await db.query('select * from members where id=$1', [keeper])).rows[0]
    assert.equal(merged.email, 'old@virginia.edu')
    assert.equal(merged.year, '2027')
    assert.equal(merged.auth_user_id, '00000000-0000-0000-0000-000000000001')
    assert.ok(merged.profile_completed_at)
    assert.ok((await db.query('select member_id from equipment')).rows.every((row) => row.member_id === keeper))
    await assert.rejects(db.query('select * from merge_members($1,$1)', [keeper]), /different member/)
    await db.exec(`insert into auth.users(id,email,invited_at) values
      ('00000000-0000-0000-0000-000000000002','second@virginia.edu',now());`)
    const second = (await db.query("select id from members where email='second@virginia.edu'")).rows[0].id
    await assert.rejects(db.query('select * from merge_members($1,$2)', [second, keeper]), /different login accounts/)
    assert.equal((await db.query('select * from members')).rows.length, 2)
    await db.exec("set app.test_user='00000000-0000-0000-0000-000000000099'")
    await assert.rejects(db.query('select * from merge_members($1,$2)', [second, keeper]), /Executive access required/)
    await assert.rejects(db.query("select * from complete_executive_profile('Alex Smith','4345550123')"), /Executive access required/)
    await db.exec('set role authenticated')
    await assert.rejects(db.query('select merge_member_records($1,$2)', [second, keeper]), /permission denied/)
  } finally { await db.close() }
})
