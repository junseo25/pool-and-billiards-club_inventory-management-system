export type Activity = {
  id: string; action: string; gearName: string; memberName: string; date: string
  gearId: string | null; memberId: string | null; serial: string
  category: string | null; cueUse: string | null; schoolYear: string
  memberEmail: string; actorName: string; actorEmail: string
}

export type SchoolYear = { id: string; label: string; start_date: string }
export function easternDate(date: Date | string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date))
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}`
}
export function schoolYearForDate(date: Date | string, years: SchoolYear[]) {
  const day = easternDate(date)
  return [...years].filter((year) => year.start_date <= day).sort((a,b) => b.start_date.localeCompare(a.start_date))[0]?.label ?? 'Unassigned'
}

export function mapActivity(row: Record<string, unknown>): Activity {
  const date = String(row.created_at)
  return {
    id: String(row.id), action: String(row.action), gearName: String(row.gear_name),
    memberName: String(row.member_name), date,
    gearId: typeof row.gear_id === 'string' ? row.gear_id : null,
    memberId: typeof row.member_id === 'string' ? row.member_id : null,
    serial: String(row.gear_serial ?? ''), category: typeof row.gear_category === 'string' ? row.gear_category : null,
    cueUse: typeof row.gear_cue_use === 'string' ? row.gear_cue_use : null,
    schoolYear: String(row.school_year ?? 'Unassigned'),
    memberEmail: String(row.member_email ?? ''), actorName: String(row.actor_name ?? ''), actorEmail: String(row.actor_email ?? ''),
  }
}

export function equipmentKey(entry: Activity) { return entry.gearId ?? `legacy-gear:${entry.gearName}` }
export function memberKey(entry: Activity) {
  return entry.memberId ?? (entry.memberName === 'Club inventory' || entry.memberName === 'Unknown member' ? '' : `legacy-member:${entry.memberName}`)
}

export function equipmentType(category: string | null, cueUse: string | null) {
  if (category === 'Shaft' || category === 'Butt') return `Cue — ${cueUse === 'Break' ? 'breaking' : cueUse?.toLowerCase() ?? 'unknown'} (${category.toLowerCase()})`
  if (category === 'Case') return 'Case'
  if (category === 'Accessory') return 'Accessory'
  return 'Type not recorded'
}

export type HistoryFilters = { schoolYear: string; gear: string; member: string; type: string; serial: string }
export function filterHistory(entries: Activity[], filters: HistoryFilters) {
  return entries.filter((entry) => {
    if (filters.schoolYear && entry.schoolYear !== filters.schoolYear) return false
    if (filters.gear && equipmentKey(entry) !== filters.gear) return false
    if (filters.member && memberKey(entry) !== filters.member) return false
    if (filters.serial && !entry.serial.toLowerCase().includes(filters.serial.trim().toLowerCase())) return false
    switch (filters.type) {
      case 'playing': return ['Shaft', 'Butt'].includes(entry.category ?? '') && entry.cueUse === 'Playing'
      case 'breaking': return ['Shaft', 'Butt'].includes(entry.category ?? '') && entry.cueUse === 'Break'
      case 'jump': return ['Shaft', 'Butt'].includes(entry.category ?? '') && entry.cueUse === 'Jump'
      case 'cases': return entry.category === 'Case'
      case 'accessories': return entry.category === 'Accessory'
      case 'shafts': return entry.category === 'Shaft'
      case 'butts': return entry.category === 'Butt'
      case 'unknown': return !entry.category
      default: return true
    }
  }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
}
