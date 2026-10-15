import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { computingId, computingIdFromEmail } from '../src/lib/identity.ts'
import { rosterRows } from '../src/lib/roster.ts'

const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
const collection = await readFile(new URL('../supabase/migrations/20261014_collect_identifiers.sql', import.meta.url), 'utf8')
const promotion = await readFile(new URL('../supabase/migrations/manual/20261014_promote_identifier_primary_keys.sql', import.meta.url), 'utf8')
const executive = '00000000-0000-0000-0000-000000000001'
async function database(legacy = false) {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, phone text, invited_at timestamptz, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user_id',true),'')::uuid $$;`)
  await db.exec(legacy ? schema.split('-- Identifier collection, ahead of the optional primary-key cutover.')[0] + 'commit;' : schema)
  await db.query("select set_config('test.user_id',$1,false)", [executive])
  await db.query('insert into auth.users(id,email,invited_at) values($1,$2,now())', [executive, 'exec@virginia.edu'])
  return db
}

test('computing IDs normalize and roster imports accept an explicit ID or UVA email username', () => {
  assert.equal(computingId(' AbC1De '), 'abc1de')
  assert.equal(computingId('123456789'), '')
  assert.equal(computingIdFromEmail(' ABC1DE@Virginia.edu '), 'abc1de')
  assert.equal(computingIdFromEmail('abc1de@gmail.com'), '')
  assert.equal(rosterRows([['Name','Computing ID'],['Alex',' AbC1De ']])[0].uva_id, 'abc1de')
  assert.equal(rosterRows([['Name','UVA Email'],['Alex','abc1de@virginia.edu']])[0].uva_id, 'abc1de')
  assert.throws(() => rosterRows([['Name','UVA ID'],['Alex','123456789']]), /computing ID/)
})

test('legacy records survive collection, new identifiers are required and unique, and imports match computing IDs', async () => {
  const db = await database(true)
  try {
    const member = (await db.query("insert into members(name) values('Legacy member') returning id")).rows[0].id
    const equipment = (await db.query("insert into equipment(name,category) values('Legacy case','Case') returning id")).rows[0].id
    await db.query("select record_equipment_handoff($1,'Checked out',$2)", [equipment, member])
    await db.exec(collection)
    await db.exec(collection)
    assert.equal((await db.query('select member_id from equipment where id=$1', [equipment])).rows[0].member_id, member)
    assert.equal((await db.query('select uva_id from members where id=$1', [member])).rows[0].uva_id, null)
    await db.query("update members set phone='4345550123' where id=$1", [member])
    await assert.rejects(db.query("insert into members(name) values('No ID')"), /computing ID is required/)
    await assert.rejects(db.query("insert into equipment(name,category) values('No serial','Case')"), /serial number is required/)
    await db.query("update members set uva_id=' AbC1De ' where id=$1", [member])
    await db.query("update equipment set serial='000123-X' where id=$1", [equipment])
    await assert.rejects(db.query("insert into members(name,uva_id) values('Duplicate','ABC1DE')"), /already belongs/)
    await assert.rejects(db.query("insert into equipment(name,category,serial) values('Duplicate','Case','000123-X')"), /already belongs/)
    await assert.rejects(db.query("update members set uva_id=null where id=$1", [member]), /cannot be cleared/)
    await assert.rejects(db.query("update equipment set serial='' where id=$1", [equipment]), /cannot be cleared/)
    await db.query('select * from sync_member_roster($1::jsonb)', [JSON.stringify([{name:'Updated member',uva_id:'ABC1DE',email:'external@example.com'}])])
    assert.equal((await db.query('select name from members where id=$1', [member])).rows[0].name, 'Updated member')
    await assert.rejects(db.query('select * from sync_member_roster($1::jsonb)', [JSON.stringify([{name:'New row',uva_id:'new1'}, {name:'Missing ID'}])]), /computing ID is required/)
    assert.equal((await db.query("select count(*)::int as n from members where uva_id='new1'")).rows[0].n, 0)
    await db.exec(promotion)
    await db.exec(promotion)
    const keys = (await db.query("select c.relname, a.attname from pg_constraint p join pg_class c on c.oid=p.conrelid join pg_attribute a on a.attrelid=c.oid and a.attnum=any(p.conkey) where p.contype='p' and c.relname in ('members','equipment') order by c.relname")).rows
    assert.deepEqual(keys, [{relname:'equipment',attname:'serial'},{relname:'members',attname:'uva_id'}])
    await db.query("select record_equipment_handoff($1,'Returned')", [equipment])
    assert.equal((await db.query('select count(*)::int as n from activity_log where gear_id=$1 and member_id=$2', [equipment,member])).rows[0].n, 2)
  } finally { await db.close() }
})

test('primary-key promotion rolls back when a legacy identifier is missing or duplicated', async () => {
  const db = await database(true)
  try {
    await db.exec("insert into members(name) values('Legacy'); insert into equipment(name,category,serial) values('A','Case','SAME'),('B','Case','SAME')")
    await db.exec(collection)
    await assert.rejects(db.exec(promotion), /Key migration blocked/)
    await db.exec('rollback')
    const key = (await db.query("select a.attname from pg_constraint p join pg_attribute a on a.attrelid=p.conrelid and a.attnum=any(p.conkey) where p.contype='p' and p.conrelid='members'::regclass")).rows[0].attname
    assert.equal(key, 'id')
    assert.equal((await db.query('select count(*)::int as n from equipment')).rows[0].n, 2)
  } finally { await db.close() }
})

test('non-UVA executive accounts supply a computing ID at first login and cannot take another linked identity', async () => {
  const db = await database()
  try {
    const user = '00000000-0000-0000-0000-000000000002'
    await db.query('insert into auth.users(id,email,invited_at) values($1,$2,now())', [user,'person@example.com'])
    assert.equal((await db.query('select count(*)::int as n from members where auth_user_id=$1', [user])).rows[0].n, 0)
    await db.query("select set_config('test.user_id',$1,false)", [user])
    await assert.rejects(db.query("select * from complete_executive_profile('Person','4345550123','exec')"), /another linked account/)
    const profile = (await db.query("select * from complete_executive_profile('Person','4345550123','abc1de')")).rows[0]
    assert.equal(profile.uva_id, 'abc1de')
    assert.equal(profile.auth_user_id, user)
    assert.ok(profile.profile_completed_at)
  } finally { await db.close() }
})
