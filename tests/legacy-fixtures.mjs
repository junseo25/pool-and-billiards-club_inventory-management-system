// Test-only seed for a member that existed before computing IDs were required.
// All tested application mutations still run with the identifier trigger enabled.
export async function insertLegacyMember(db, sql) {
  await db.exec('alter table members disable trigger validate_member_identifier')
  try { return await db.query(sql) }
  finally { await db.exec('alter table members enable trigger validate_member_identifier') }
}
