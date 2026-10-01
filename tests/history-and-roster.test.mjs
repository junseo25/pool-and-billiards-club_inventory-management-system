import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { findRosterEmail, rosterRows } from '../src/lib/roster.ts'
import { equipmentKey, filterHistory, mapActivity, memberKey, schoolYearForDate } from '../src/lib/history.ts'

test('roster detects UVA emails in any row field and respects an explicit UVA column', () => {
  assert.equal(findRosterEmail(['Alex', 'Contact: ALEX@VIRGINIA.EDU.'], -1, 'Alex'), 'alex@virginia.edu')
  assert.equal(findRosterEmail(['Alex', 'personal@example.com', 'mailto:alex@virginia.edu'], 1, 'Alex'), 'alex@virginia.edu')
  assert.equal(findRosterEmail(['Alex', 'alex@virginia.edu', 'Contact coordinator: other@virginia.edu'], 1, 'Alex'), 'alex@virginia.edu')
  assert.equal(findRosterEmail(['Alex', 'alex@virginia.edu.attacker.test'], -1, 'Alex'), '')
  assert.equal(findRosterEmail(['Alex', 'alex@sub.virginia.edu'], -1, 'Alex'), '')
  assert.throws(() => findRosterEmail(['Alex', 'alex@virginia.edu or other@virginia.edu'], -1, 'Alex'), /Multiple UVA emails/)
  const rows = rosterRows([['Name','Phone','Notes'], ['Alex Smith','4345550123','Email <alex@virginia.edu>']])
  assert.equal(rows[0].email, 'alex@virginia.edu')
  assert.equal(rows[0].phone, '4345550123')
  assert.equal(rosterRows([['First Name','Last Name','UVA Email'], ['Alex','Smith','alex@virginia.edu']])[0].name, 'Alex Smith')
})

test('history uses designated boundaries and combines item, member, type, year and serial filters', () => {
  const years = [{ id: 'year1', label: '2026/27', start_date: '2026-08-25' }, { id: 'year2', label: '2027/28', start_date: '2027-10-15' }]
  assert.equal(schoolYearForDate('2026-08-25T03:59:59Z', years), 'Unassigned')
  assert.equal(schoolYearForDate('2026-08-25T04:00:00Z', years), '2026/27')
  assert.equal(schoolYearForDate('2027-10-15T03:59:59Z', years), '2026/27')
  assert.equal(schoolYearForDate('2027-10-15T04:00:00Z', years), '2027/28')
  const event = mapActivity({ id: '1', action: 'Checked out', gear_name: 'Cue', member_name: 'Alex', created_at: '2027-11-01T12:00Z', gear_id: 'item1', member_id: 'member1', gear_serial: 'SH-123-P', gear_category: 'Shaft', gear_cue_use: 'Playing', school_year: '2027/28' })
  const second = { ...event, id: '2', gearId: 'item2', serial: 'BU-123-B', cueUse: 'Break' }
  const filters = { schoolYear: '2027/28', gear: 'item1', member: 'member1', type: 'playing', serial: 'sh-123' }
  assert.deepEqual(filterHistory([event, second], filters), [event])
  assert.equal(filterHistory([event], { ...filters, schoolYear: '2026/27' }).length, 0)
  assert.equal(filterHistory([event], { ...filters, type: 'breaking' }).length, 0)
  const legacy = mapActivity({ id: 'old', action: 'Returned', gear_name: 'Cue', member_name: 'Alex', created_at: '2026-08-24T12:00Z' })
  assert.equal(legacy.schoolYear, 'Unassigned')
  assert.notEqual(equipmentKey(legacy), equipmentKey(event), 'name-only rows cannot falsely identify equipment')
  assert.notEqual(memberKey(legacy), memberKey(event))
})

test('school years, atomic handoffs, archived equipment and merged member history', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text, phone text, invited_at timestamptz, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql as $$ select coalesce(nullif(current_setting('app.test_user',true),''),'00000000-0000-0000-0000-000000000001')::uuid $$;`)
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../supabase/migrations/20261001_school_year_history.sql', import.meta.url), 'utf8'))
    await db.exec(`insert into auth.users(id,email,invited_at,raw_user_meta_data) values('00000000-0000-0000-0000-000000000001','exec@virginia.edu',now(),'{"full_name":"Executive"}');`)
    assert.equal((await db.query('select * from school_years')).rows[0].start_date.toISOString().slice(0,10), '2026-08-25')
    const borrower = (await db.query("insert into members(name,email,phone) values('Alex Smith','alex@virginia.edu','4345550123') returning id")).rows[0].id
    await db.query("select * from sync_member_roster($1::jsonb)", [JSON.stringify([{ name: 'Alex Smith', email: 'alex-new@virginia.edu', phone: '(434) 555-0123' }])])
    assert.equal((await db.query("select id from members where email='alex-new@virginia.edu'")).rows[0].id, borrower, 'new UVA email enriches the matching name and phone record')
    const item = (await db.query("insert into equipment(name,category,cue_use,serial) values('Playing shaft','Shaft','Playing','SH-123-P') returning id")).rows[0].id
    assert.equal((await db.query('select * from activity_log where gear_id=$1', [item])).rows[0].action, 'Added')
    const checkout = (await db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [item, borrower])).rows[0]
    assert.equal(checkout.member_id, borrower)
    assert.equal(checkout.gear_serial, 'SH-123-P')
    assert.equal(checkout.actor_email, 'exec@virginia.edu')
    assert.equal(checkout.actor_name, 'Executive')
    await assert.rejects(db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [item, borrower]), /already checked out/)
    assert.equal((await db.query('select * from activity_log where gear_id=$1', [item])).rows.length, 2, 'failed handoff adds no duplicate log')
    const keeper = (await db.query("insert into members(name) values('Alex') returning id")).rows[0].id
    await db.query('select * from merge_members($1,$2)', [borrower, keeper])
    assert.equal((await db.query('select member_id from activity_log where id=$1', [checkout.id])).rows[0].member_id, keeper)
    assert.equal((await db.query('select member_name from activity_log where id=$1', [checkout.id])).rows[0].member_name, 'Alex Smith', 'snapshot name is preserved')
    const returned = (await db.query("select * from record_equipment_handoff($1,'Returned')", [item])).rows[0]
    assert.equal(returned.member_id, keeper)
    await assert.rejects(db.query("select * from record_equipment_handoff($1,'Returned')", [item]), /already been returned/)
    await db.query("select * from record_equipment_handoff($1,'Removed')", [item])
    assert.equal((await db.query('select * from equipment where id=$1', [item])).rows.length, 0)
    assert.equal((await db.query('select * from activity_log where gear_id=$1', [item])).rows.length, 4)
    const failureItem = (await db.query("insert into equipment(name,category) values('Atomic case','Case') returning id")).rows[0].id
    await db.exec("alter table activity_log add constraint test_log_failure check(action <> 'Checked out') not valid")
    await assert.rejects(db.query("select * from record_equipment_handoff($1,'Checked out',$2)", [failureItem, keeper]), /test_log_failure/)
    assert.equal((await db.query('select member_id from equipment where id=$1', [failureItem])).rows[0].member_id, null, 'failed history insert rolls back the loan')
    assert.equal((await db.query('select * from activity_log where gear_id=$1', [failureItem])).rows.length, 1)
    await db.exec('alter table activity_log drop constraint test_log_failure')
    await db.exec("insert into activity_log(action,gear_name,member_name,created_at) values('Returned','Legacy','Alex','2027-09-04 23:59:59-04'),('Returned','Legacy','Alex','2027-09-05 00:00:00-04'),('Returned','Older','Alex','2026-08-24 12:00:00-04')")
    await db.query("select * from start_school_year('2027/28','2027-09-05')")
    const history = (await db.query("select * from activity_log where gear_name='Legacy' order by created_at")).rows
    assert.equal(history[0].school_year, '2026/27')
    assert.equal(history[1].school_year, '2027/28')
    assert.equal((await db.query("select school_year from activity_log where gear_name='Older'")).rows[0].school_year, null)
    await assert.rejects(db.query("select * from start_school_year('2028/29','2027-08-01')"), /start after/)
    await assert.rejects(db.query("select * from start_school_year('2028/29','2027-09-05')"), /start after/)
    await assert.rejects(db.query("select * from start_school_year('2028/30','2028-09-01')"), /consecutive/)
    assert.equal((await db.query('select * from school_years')).rows.length, 2)
    await db.exec(await readFile(new URL('../supabase/migrations/20261001_delete_school_years.sql', import.meta.url), 'utf8'))
    await db.query("select * from start_school_year('2028/29','2028-09-01')")
    await db.exec("insert into activity_log(action,gear_name,member_name,created_at) values('Returned','Later','Alex','2028-10-01 12:00:00-04')")
    const years = (await db.query('select * from school_years order by start_date')).rows
    const beforeDelete = (await db.query('select * from activity_log order by id')).rows
    await assert.rejects(db.query('select * from delete_school_year($1)', [years[0].id]), /first school year/)
    await db.query('select * from delete_school_year($1)', [years[1].id])
    const afterDelete = (await db.query('select * from activity_log order by id')).rows
    assert.equal(afterDelete.length, beforeDelete.length)
    for (let i = 0; i < beforeDelete.length; i++) {
      const expected = beforeDelete[i].school_year_id === years[1].id
        ? { ...beforeDelete[i], school_year_id: years[0].id, school_year: years[0].label }
        : beforeDelete[i]
      assert.deepEqual(afterDelete[i], expected, 'all snapshots remain unchanged except reassigned year')
    }
    await db.exec("insert into activity_log(action,gear_name,member_name,created_at) values('Returned','Gap','Alex','2027-10-01 12:00:00-04')")
    assert.equal((await db.query("select school_year from activity_log where gear_name='Gap'")).rows[0].school_year, '2026/27')
    await db.query('select * from delete_school_year($1)', [years[2].id])
    assert.equal((await db.query("select school_year from activity_log where gear_name='Later'")).rows[0].school_year, '2026/27')
    assert.equal((await db.query('select * from school_years')).rows.length, 1)
    await db.exec("set app.test_user='00000000-0000-0000-0000-000000000099'")
    await assert.rejects(db.query("select * from start_school_year('2028/29','2028-09-01')"), /Executive access required/)
    await assert.rejects(db.query('select * from delete_school_year($1)', [years[0].id]), /Executive access required/)
    await assert.rejects(db.query("select * from record_equipment_handoff($1,'Removed')", [item]), /Executive access required/)
  } finally { await db.close() }
})
