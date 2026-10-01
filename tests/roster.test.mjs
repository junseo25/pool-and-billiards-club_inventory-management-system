import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('invitations link executives; roster imports preserve identity and loans', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key, email text, phone text,
        invited_at timestamptz, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql as
        $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
    `)
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
    // Existing projects must be able to run both migrations too.
    await db.exec(await readFile(new URL('../supabase/migrations/20261001_approve_invited_executives.sql', import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../supabase/migrations/20261001_executive_roster.sql', import.meta.url), 'utf8'))
    await db.exec(`insert into auth.users(id,email,invited_at) values
      ('00000000-0000-0000-0000-000000000001','Exec@virginia.edu',now());`)
    const importRows = (rows) => db.query('select * from public.sync_member_roster($1::jsonb)', [JSON.stringify(rows)])
    const rows = [{ name: 'Alex Smith', email: ' exec@virginia.edu ', phone: '(434) 555-0123', year: '2027' }]
    let result = await importRows([...rows, ...rows])
    assert.equal(result.rows.length, 1)
    const id = result.rows[0].id
    assert.equal(result.rows[0].auth_user_id, '00000000-0000-0000-0000-000000000001')
    await db.query("insert into equipment(name, category, member_id) values('Case', 'Case', $1)", [id])
    result = await importRows([{ name: ' Alex   Smith ', phone: '+1 434 555 0123' }])
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].email, 'exec@virginia.edu')
    assert.equal(result.rows[0].year, '2027')
    assert.equal((await db.query('select member_id from equipment')).rows[0].member_id, id)
    result = await importRows([{ name: 'Alex Smith', email: 'other@virginia.edu', phone: '4345559999' }])
    assert.equal(result.rows.length, 2, 'same-name people with different contacts remain separate')
    await assert.rejects(importRows([{ name: 'Alex Smith' }]), /Add an email or phone/)
    await db.exec(`insert into auth.users(id,email,invited_at) values
      ('00000000-0000-0000-0000-000000000002','other@virginia.edu',now());`)
    assert.equal((await db.query('select * from members')).rows.length, 2, 'invite reuses existing member')
    await db.exec(`insert into auth.users(id,email) values
      ('00000000-0000-0000-0000-000000000003','notinvited@virginia.edu');`)
    assert.equal((await db.query('select * from executive_access')).rows.length, 2)
    await importRows([{ name: 'Phone Member', phone: '(434) 555-8888' }])
    await db.exec(`insert into auth.users(id,email,phone,invited_at,raw_user_meta_data) values
      ('00000000-0000-0000-0000-000000000004','phone@virginia.edu','+14345558888',now(),'{"full_name":"Phone Member"}');`)
    assert.equal((await db.query("select * from members where name='Phone Member'")).rows.length, 1)
    await db.exec("insert into members(name,email) values('Duplicate','exec@virginia.edu')")
    await assert.rejects(importRows([{ name: 'Should roll back', email: 'new@virginia.edu' }, ...rows]), /Multiple members match/)
    assert.equal((await db.query("select * from members where email='new@virginia.edu'")).rows.length, 0)
    await db.exec("delete from executive_access where user_id=auth.uid(); update auth.users set invited_at=now() where id=auth.uid();")
    assert.equal((await db.query('select * from executive_access where user_id=auth.uid()')).rows.length, 0)
    await assert.rejects(importRows(rows), /Executive access required/)
  } finally { await db.close() }
})
