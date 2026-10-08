import { useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowUpDown, Package, Trash2 } from 'lucide-react'
import { equipmentKey, equipmentType, filterHistory, memberKey, type Activity, type HistoryFilters, type SchoolYear } from '../lib/history'
import WorkspaceSummary from './WorkspaceSummary'

type GearOption = { id: string; name: string; serial: string }
type MemberOption = { id: string; name: string; email: string }
export type HistoryScope = { gear?: string; member?: string }

function eventTime(date: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date))
}

function HistoryEvent({ entry }: { entry: Activity }) {
  return <article className="activity-row history-event">
    <span className={`activity-icon ${entry.action.toLowerCase().replace(' ', '-')}`}>{entry.action === 'Returned' ? <ArrowDownToLine size={17} /> : entry.action === 'Removed' ? <Trash2 size={16} /> : entry.action === 'Added' ? <Package size={16} /> : <ArrowUpDown size={17} />}</span>
    <div className="activity-copy"><p><strong>{entry.action}</strong> <span>{entry.gearName}</span></p>
      <small>{entry.memberName}{entry.memberEmail && ` · ${entry.memberEmail}`}</small>
      <small>{entry.serial || 'Serial not recorded'} · {equipmentType(entry.category, entry.cueUse)}</small>
      <small>Handled by {entry.actorName || entry.actorEmail || 'not recorded'}</small>
    </div><div className="history-event-date"><span className="history-year">{entry.schoolYear}</span><time dateTime={entry.date}>{eventTime(entry.date)} ET</time></div>
  </article>
}

export default function HistoryPanel({ entries, gear, members, schoolYears, scope }: {
  entries: Activity[]; gear: GearOption[]; members: MemberOption[]; schoolYears: SchoolYear[]; scope: HistoryScope | null
}) {
  const [mode, setMode] = useState<'equipment' | 'members' | 'handoffs'>(scope?.member ? 'members' : 'equipment')
  const [filters, setFilters] = useState<HistoryFilters>({ schoolYear: '', gear: scope?.gear ?? '', member: scope?.member ?? '', type: '', serial: '' })
  const change = (key: keyof HistoryFilters, value: string) => setFilters((current) => ({ ...current, [key]: value }))
  const filtered = useMemo(() => filterHistory(entries, filters), [entries, filters])
  const years = [...new Set([...schoolYears.map((year) => year.label), ...entries.map((entry) => entry.schoolYear)])].sort().reverse()
  const gearOptions = new Map<string, string>()
  const memberOptions = new Map<string, string>()
  for (const entry of entries) {
    if (!gearOptions.has(equipmentKey(entry))) gearOptions.set(equipmentKey(entry), `${entry.gearName}${entry.serial ? ` · ${entry.serial}` : ''}${!entry.gearId ? ' (name-only record)' : ''}`)
    const key = memberKey(entry)
    if (key && !memberOptions.has(key)) memberOptions.set(key, `${entry.memberName}${entry.memberEmail ? ` · ${entry.memberEmail}` : ''}${!entry.memberId ? ' (name-only record)' : ''}`)
  }
  for (const item of gear) gearOptions.set(item.id, `${item.name}${item.serial ? ` · ${item.serial}` : ''}`)
  for (const member of members) memberOptions.set(member.id, `${member.name}${member.email ? ` · ${member.email}` : ''}`)
  const groups = new Map<string, Activity[]>()
  if (mode !== 'handoffs') for (const entry of filtered) {
    const key = mode === 'equipment' ? equipmentKey(entry) : memberKey(entry) || 'club-inventory'
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return <>
    <WorkspaceSummary label="History summary" items={[
      { label: 'Recorded events', value: entries.length, description: 'equipment and member activity' },
      { label: 'Equipment history', value: new Set(entries.map(equipmentKey)).size, description: 'items with recorded activity' },
      { label: 'School years', value: years.length, description: 'available in history' },
    ]} />
    <section className="ledger-section activity-ledger">
    <div className="section-toolbar"><div className="section-title"><h2>Equipment and member history</h2><span>{entries.length} EVENTS</span></div></div>
    <p className="history-intro">Follow each item or member across school years, including every recorded handoff.</p>
    <div className="history-modes" role="group" aria-label="History view">{(['equipment', 'members', 'handoffs'] as const).map((value) => <button key={value} className={mode === value ? 'selected' : ''} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === 'equipment' ? 'Equipment history' : value === 'members' ? 'Member history' : 'Handoff log'}</button>)}</div>
    <div className="history-filters">
      <label>School year<select value={filters.schoolYear} onChange={(event) => change('schoolYear', event.target.value)}><option value="">All school years</option>{years.map((year) => <option key={year}>{year}</option>)}</select></label>
      <label>Equipment<select value={filters.gear} onChange={(event) => change('gear', event.target.value)}><option value="">All equipment</option>{[...gearOptions].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Member<select value={filters.member} onChange={(event) => change('member', event.target.value)}><option value="">All members</option>{[...memberOptions].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Equipment type<select value={filters.type} onChange={(event) => change('type', event.target.value)}><option value="">All types</option><option value="playing">Cue — playing</option><option value="breaking">Cue — breaking</option><option value="jump">Cue — jump</option><option value="cases">Cases</option><option value="accessories">Accessories</option><option value="shafts">Shafts</option><option value="butts">Butts</option><option value="unknown">Type not recorded</option></select></label>
      <label>Serial number<input placeholder="Search serial number" value={filters.serial} onChange={(event) => change('serial', event.target.value)} /></label>
      <button className="secondary-button" onClick={() => setFilters({ schoolYear: '', gear: '', member: '', type: '', serial: '' })}>Clear filters</button>
    </div>
    <div className="history-count" role="status">{filtered.length} of {entries.length} events · newest first · times in Eastern Time</div>
    {filtered.some((entry) => !entry.gearId) && <p className="history-legacy-note">Older entries contain names only. Serial numbers, equipment types, and handling executives were not recorded.</p>}
    {mode === 'handoffs' ? <div className="activity-list">{filtered.map((entry) => <HistoryEvent key={entry.id} entry={entry} />)}</div>
      : [...groups].map(([key, events]) => <section className="history-group" key={key}><header><h3>{mode === 'equipment' ? gearOptions.get(key) : memberOptions.get(key) || 'Club inventory'}</h3><span>{events.length} event{events.length === 1 ? '' : 's'}</span></header><div className="activity-list">{events.map((entry) => <HistoryEvent key={entry.id} entry={entry} />)}</div></section>)}
    {!filtered.length && <div className="empty-row">{entries.length ? 'No history matches these filters.' : 'No activity has been recorded yet.'}</div>}
    <div className="table-footer"><span>{years.length} SCHOOL YEAR{years.length === 1 ? '' : 'S'}</span><span>History stays available after equipment is removed.</span></div>
    </section>
  </>
}
