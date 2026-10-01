const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi

function emailsIn(value: string) {
  return [...new Set((value.match(emailPattern) ?? []).map((email) => email.toLowerCase()))]
}

export function findRosterEmail(values: string[], emailColumn: number, memberName: string) {
  const explicitEmails = emailColumn >= 0 ? emailsIn(values[emailColumn] ?? '') : []
  const explicitUva = explicitEmails.filter((email) => email.endsWith('@virginia.edu'))
  const candidates = explicitUva.length ? explicitUva
    : [...new Set(values.flatMap(emailsIn).filter((email) => email.endsWith('@virginia.edu')))]
  if (candidates.length > 1) throw new Error(`Multiple UVA emails found for ${memberName}. Put the correct address in a UVA Email column before importing.`)
  if (candidates.length === 1) return candidates[0]
  if (explicitEmails.length > 1) throw new Error(`Multiple emails found for ${memberName}. Use one email per member.`)
  return explicitEmails[0] ?? ''
}

export function rosterRows(rows: string[][]) {
  if (rows.length < 2) throw new Error('The sheet is empty or has no member rows.')
  const headers = rows[0].map((header) => header.toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim())
  const column = (...names: string[]) => headers.findIndex((header) => names.includes(header))
  const nameColumn = column('name', 'full name', 'member', 'member name')
  const firstNameColumn = column('first name', 'first')
  const lastNameColumn = column('last name', 'last')
  const uvaColumn = column('uva email', 'uva email address', 'university email', 'virginia email')
  const emailColumn = uvaColumn >= 0 ? uvaColumn : column('email', 'email address', 'e mail')
  const phoneColumn = column('phone', 'phone number', 'mobile', 'contact number')
  const yearColumn = column('year', 'class year', 'graduation year', 'grad year')
  if (nameColumn < 0 && firstNameColumn < 0) throw new Error('Add a "Name" or "First name" column to the sheet.')
  const imported = rows.slice(1).flatMap((values) => {
    const name = (nameColumn >= 0 ? values[nameColumn] ?? '' : `${values[firstNameColumn] ?? ''} ${lastNameColumn >= 0 ? values[lastNameColumn] ?? '' : ''}`).trim()
    if (!name) return []
    return [{ name, email: findRosterEmail(values, emailColumn, name),
      phone: phoneColumn >= 0 ? values[phoneColumn] ?? '' : '',
      year: yearColumn >= 0 ? values[yearColumn] ?? '' : '' }]
  })
  if (!imported.length) throw new Error('No members with names were found in the sheet.')
  return imported
}
