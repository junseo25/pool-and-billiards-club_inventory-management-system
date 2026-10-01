import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpDown,
  Boxes,
  Check,
  Clock3,
  LogOut,
  Moon,
  Package,
  Plus,
  RefreshCw,
  Search,
  Save,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import './App.css'
import { authCallbackError, isPasswordSetupLink, isSupabaseConfigured, supabase } from './lib/supabase'
import type { User } from '@supabase/supabase-js'
import PhoneInput from './components/PhoneInput'
import { rosterRows } from './lib/roster'
import { easternDate, mapActivity, schoolYearForDate, type Activity, type SchoolYear } from './lib/history'
import HistoryPanel, { type HistoryScope } from './components/HistoryPanel'
import MemberDirectory from './components/MemberDirectory'
import MemberProfile from './components/MemberProfile'
import EquipmentLabel from './components/EquipmentLabel'
import { isActiveMember } from './lib/membership'

type GearCategory = 'Case' | 'Shaft' | 'Butt' | 'Accessory'
type CueUse = 'Playing' | 'Break' | 'Jump' | 'Not applicable'

type Gear = {
  id: string
  name: string
  category: GearCategory
  cueUse: CueUse
  serial: string
  memberId: string | null
  updatedAt: string
}

type Member = {
  id: string
  name: string
  email: string
  phone: string
  year: string
  auth_user_id?: string | null
  profile_completed_at?: string | null
  invitation_sent_at?: string | null
  is_emeritus?: boolean
}

type View = 'inventory' | 'loans' | 'members' | 'activity' | 'settings'
type Modal = { kind: 'profile-member'; memberId: string } | { kind: 'gear' } | { kind: 'member' } | { kind: 'edit-member'; memberId: string } | { kind: 'merge-member'; memberId: string } | { kind: 'delete-member'; memberId: string } | { kind: 'checkout'; gearId: string } | null
type SortKey = 'name' | 'category' | 'cueUse' | 'member' | 'updatedAt'

function readStore<T,>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key)
    return saved ? (JSON.parse(saved) as T) : fallback
  } catch {
    return fallback
  }
}

function serialPrefix(category: GearCategory) {
  return category.slice(0, 2).toUpperCase()
}

function cueUseSuffix(cueUse: CueUse) {
  if (cueUse === 'Playing') return 'P'
  if (cueUse === 'Break') return 'B'
  if (cueUse === 'Jump') return 'J'
  return ''
}

function addCueUseSuffix(serial: string, cueUse: CueUse) {
  const suffix = cueUseSuffix(cueUse)
  if (!serial || !suffix) return serial
  return `${serial.replace(/-[PBJ]$/i, '')}-${suffix}`
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date))
}

function errorMessage(error: unknown, fallback: string) {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : fallback
}

function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"' && quoted && text[index + 1] === '"') {
      cell += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(cell.trim())
      cell = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell.trim())
      if (row.some((value) => value)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }
  row.push(cell.trim())
  if (row.some((value) => value)) rows.push(row)
  return rows
}

function sheetCsvUrl(rawUrl: string) {
  const url = new URL(rawUrl)
  const sheetId = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/)?.[1]
  if (!sheetId) return rawUrl
  const gid = url.searchParams.get('gid') ?? url.hash.match(/gid=(\d+)/)?.[1] ?? '0'
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`
}

async function fetchActivity() {
  if (!supabase) throw new Error('The secure database is not configured.')
  const entries = new Map<string, Activity>()
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('activity_log').select('*')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 999)
    if (error) throw error
    for (const row of data) entries.set(row.id, mapActivity(row))
    if (data.length < 1000) break
  }
  return [...entries.values()]
}

function App() {
  const [gear, setGear] = useState<Gear[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [activity, setActivity] = useState<Activity[]>([])
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState(authCallbackError)
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(isPasswordSetupLink)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSavingPassword, setIsSavingPassword] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [profilePhone, setProfilePhone] = useState('')
  const [profileError, setProfileError] = useState('')
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [reviewingProfileDuplicates, setReviewingProfileDuplicates] = useState(false)
  const [invitingMemberId, setInvitingMemberId] = useState<string | null>(null)
  const [invitationMessage, setInvitationMessage] = useState('')
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [mergeError, setMergeError] = useState('')
  const [isMerging, setIsMerging] = useState(false)
  const [isDeletingMember, setIsDeletingMember] = useState(false)
  const [deleteMemberError, setDeleteMemberError] = useState('')
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [workspaceAccess, setWorkspaceAccess] = useState<boolean | null>(null)
  const [workspaceLoadedFor, setWorkspaceLoadedFor] = useState<string | null>(null)
  const [workspaceRetry, setWorkspaceRetry] = useState(0)
  const [workspaceError, setWorkspaceError] = useState('')
  const [dataError, setDataError] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readStore('pool-club-theme', 'light'))
  const [clubName, setClubName] = useState(() => readStore('pool-club-name', 'Break Pool Club'))
  const [schoolYears, setSchoolYears] = useState<SchoolYear[]>([])
  const [newYearLabel, setNewYearLabel] = useState('2027/28')
  const [newYearStart, setNewYearStart] = useState(() => easternDate(new Date()))
  const [yearError, setYearError] = useState('')
  const [isSavingYear, setIsSavingYear] = useState(false)
  const [historyScope, setHistoryScope] = useState<HistoryScope | null>(null)
  const [settingsSaved, setSettingsSaved] = useState(true)
  const [newGearCategory, setNewGearCategory] = useState<GearCategory>('Case')
  const [newGearCueUse, setNewGearCueUse] = useState<Exclude<CueUse, 'Not applicable'>>('Playing')
  const [serialDigits, setSerialDigits] = useState('')
  const [view, setView] = useState<View>('inventory')
  const [modal, setModal] = useState<Modal>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'name', direction: 'asc' })
  const [sheetUrl, setSheetUrl] = useState(() => readStore('pool-club-sheet-url', ''))
  const [syncMessage, setSyncMessage] = useState('')
  const [isSyncing, setIsSyncing] = useState(false)
  const currentUserId = authUser?.id ?? null

  useEffect(() => localStorage.setItem('pool-club-sheet-url', JSON.stringify(sheetUrl)), [sheetUrl])

  useEffect(() => {
    if (!supabase) return

    let active = true
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return
      if (event === 'PASSWORD_RECOVERY') setNeedsPasswordSetup(true)
      setAuthUser(session?.user ?? null)
      setAuthReady(true)
    })

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) setAuthError(error.message)
      setAuthUser(data.session?.user ?? null)
      setAuthReady(true)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !currentUserId) return

    let active = true
    const client = supabase
    const userId = currentUserId

    async function loadWorkspace() {
      try {
        const { data: accessRow, error: accessError } = await client
          .from('executive_access')
          .select('user_id')
          .eq('user_id', userId)
          .maybeSingle()
        if (accessError) throw accessError
        if (!accessRow) {
          if (active) {
            setWorkspaceAccess(false)
            setWorkspaceLoadedFor(userId)
          }
          return
        }

        const [equipmentResult, membersResult, activityRows, schoolYearResult] = await Promise.all([
          client.from('equipment').select('*').order('name'),
          client.from('members').select('*').order('name'),
          fetchActivity(),
          client.from('school_years').select('id,label,start_date').order('start_date'),
        ])
        if (equipmentResult.error) throw equipmentResult.error
        if (membersResult.error) throw membersResult.error
        if (schoolYearResult.error) throw schoolYearResult.error
        if (!active) return

        setGear((equipmentResult.data ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          category: row.category as GearCategory,
          cueUse: row.cue_use as CueUse,
          serial: row.serial,
          memberId: row.member_id,
          updatedAt: row.updated_at,
        })))
        setMembers((membersResult.data ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          phone: row.phone,
          year: row.year,
          auth_user_id: row.auth_user_id,
          profile_completed_at: row.profile_completed_at,
          invitation_sent_at: row.invitation_sent_at,
          is_emeritus: row.is_emeritus,
        })))
        const ownMember = membersResult.data?.find((row) => row.auth_user_id === userId)
        setProfileName(ownMember?.name ?? '')
        setProfilePhone(ownMember?.phone ?? '')
        setActivity(activityRows)
        const periods = schoolYearResult.data as SchoolYear[]
        setSchoolYears(periods)
        const lastYear = periods.at(-1)
        if (lastYear) {
          const nextStart = Number(lastYear.label.slice(0,4)) + 1
          setNewYearLabel(`${nextStart}/${String(nextStart+1).slice(-2)}`)
        }
        setDataError('')
        setWorkspaceAccess(true)
        setWorkspaceLoadedFor(userId)
        setWorkspaceError('')
      } catch (error) {
        if (active) {
          const message = error instanceof Error ? error.message : 'Could not load the secure workspace.'
          setWorkspaceError(message)
          setDataError(message)
        }
      }
    }

    void loadWorkspace()
    return () => { active = false }
  }, [currentUserId, workspaceRetry])

  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members])
  const activeMembers = members.filter(isActiveMember)
  const emeritusMembers = members.filter((member) => member.is_emeritus)
  const availableGear = gear.filter((item) => !item.memberId)
  const loanedGear = gear.filter((item) => item.memberId !== null)
  const availableCount = availableGear.length
  const loanedCount = loanedGear.length

  const visibleGear = useMemo(() => {
    const normalizedQuery = query.toLowerCase().trim()
    return gear
      .filter((item) => {
        const memberName = item.memberId ? memberById.get(item.memberId)?.name ?? '' : 'Available'
        return [item.name, item.category, item.cueUse, item.serial, memberName].some((value) => value.toLowerCase().includes(normalizedQuery))
      })
      .sort((left, right) => {
        const leftValue = sort.key === 'member'
          ? (left.memberId ? memberById.get(left.memberId)?.name ?? '' : 'Available')
          : left[sort.key]
        const rightValue = sort.key === 'member'
          ? (right.memberId ? memberById.get(right.memberId)?.name ?? '' : 'Available')
          : right[sort.key]
        const comparison = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true })
        return sort.direction === 'asc' ? comparison : -comparison
      })
  }, [gear, memberById, query, sort])

  const visibleMembers = useMemo(() => members.filter((member) =>
    [member.name, member.email, member.phone, member.year].some((value) => value.toLowerCase().includes(query.toLowerCase().trim())),
  ), [members, query])

  async function recordHandoff(item: Gear, operation: 'Checked out' | 'Returned' | 'Removed', memberId?: string) {
    if (!supabase) return null
    const { data, error } = await supabase.rpc('record_equipment_handoff', {
      equipment_id: item.id, operation, borrower_id: memberId ?? null,
    }).single()
    if (error || !data) {
      setDataError(error?.message ?? 'Could not save the handoff and its history.')
      return null
    }
    const event = mapActivity(data as Record<string, unknown>)
    setActivity((entries) => [event, ...entries.filter((entry) => entry.id !== event.id)])
    setDataError('')
    return event
  }

  async function handleAddGear(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    const category = form.get('category') as GearCategory
    const cueUse = category === 'Butt' || category === 'Shaft' ? form.get('cueUse') as CueUse : 'Not applicable'
    const updatedAt = new Date().toISOString()
    const { data, error } = await supabase.from('equipment').insert({
      name: String(form.get('name')).trim(),
      category,
      serial: serialDigits ? addCueUseSuffix(`${serialPrefix(category)}-${serialDigits}`, cueUse) : '',
      cue_use: cueUse,
      member_id: null,
      updated_at: updatedAt,
    }).select().single()
    if (error || !data) {
      setDataError(error?.message ?? 'Could not save the equipment item.')
      return
    }
    const item: Gear = { id: data.id, name: data.name, category: data.category as GearCategory, cueUse: data.cue_use as CueUse, serial: data.serial, memberId: data.member_id, updatedAt: data.updated_at }
    setGear((items) => [item, ...items])
    setDataError('')
    const { data: historyRow, error: historyError } = await supabase.from('activity_log').select('*').eq('gear_id', item.id).eq('action', 'Added').maybeSingle()
    if (historyError) setDataError(historyError.message)
    if (historyRow) setActivity((entries) => [mapActivity(historyRow), ...entries])
    setModal(null)
  }

  async function handleMemberSubmit(event: FormEvent<HTMLFormElement>, memberId?: string) {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    const memberData = {
      name: String(form.get('name')).trim(),
      email: String(form.get('email')).trim(),
      phone: String(form.get('phone')).trim(),
      year: String(form.get('year')).trim(),
      is_emeritus: form.get('membership') === 'emeritus',
    }
    const { data, error } = memberId
      ? await supabase.from('members').update(memberData).eq('id', memberId).select().single()
      : await supabase.from('members').insert(memberData).select().single()
    if (error || !data) {
      setDataError(error?.message ?? 'Could not save the member record.')
      return
    }
    const updatedMember: Member = data
    setMembers((people) => memberId
      ? people.map((member) => member.id === memberId ? updatedMember : member)
      : [...people, updatedMember])
    setDataError('')
    setModal(null)
  }

  async function handleCheckout(event: FormEvent<HTMLFormElement>, gearId: string) {
    event.preventDefault()
    const memberId = String(new FormData(event.currentTarget).get('member'))
    if (await checkoutGear(gearId, memberId)) setModal(null)
  }

  async function checkoutGear(gearId: string, memberId: string) {
    if (!supabase) return false
    const item = gear.find((entry) => entry.id === gearId)
    if (!item || item.memberId) return false
    const member = memberById.get(memberId)
    if (!member || member.is_emeritus) {
      setDataError('Choose an active member. Emeritus members cannot receive new loans.')
      return false
    }
    const event = await recordHandoff(item, 'Checked out', memberId)
    if (!event) return false
    setGear((items) => items.map((entry) => entry.id === gearId ? { ...entry, memberId, updatedAt: event.date } : entry))
    return true
  }

  async function handleWorkspaceCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (await checkoutGear(String(form.get('gear')), String(form.get('member')))) event.currentTarget.reset()
  }

  async function returnGear(item: Gear) {
    if (!supabase) return
    const event = await recordHandoff(item, 'Returned')
    if (!event) return
    setGear((items) => items.map((entry) => entry.id === item.id ? { ...entry, memberId: null, updatedAt: event.date } : entry))
  }

  async function removeGear(item: Gear) {
    if (!window.confirm(`Remove ${item.name} from the inventory?`)) return
    if (!supabase) return
    const event = await recordHandoff(item, 'Removed')
    if (!event) return
    setGear((items) => items.filter((entry) => entry.id !== item.id))
    setDataError('')
  }

  function toggleSort(key: SortKey) {
    setSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }))
  }

  function saveSettings() {
    localStorage.setItem('pool-club-theme', JSON.stringify(theme))
    localStorage.setItem('pool-club-name', JSON.stringify(clubName))
    setSettingsSaved(true)
  }

  async function handleStartSchoolYear(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    if (!window.confirm(`Save school year ${newYearLabel.trim()} starting ${newYearStart}? The previous school year will end the day before this date. Activity on or after this date will be assigned to the new year.`)) return
    setYearError('')
    setIsSavingYear(true)
    try {
      const { data, error } = await supabase.rpc('start_school_year', { year_label: newYearLabel.trim(), year_start: newYearStart })
      if (error) throw error
      const years = data as SchoolYear[]
      setSchoolYears(years)
      const latest = years.at(-1)
      if (latest) {
        const next = Number(latest.label.slice(0,4)) + 1
        setNewYearLabel(`${next}/${String(next+1).slice(-2)}`)
      }
      setActivity(await fetchActivity())
    } catch (error) { setYearError(errorMessage(error, 'Could not save the school year.')) }
    finally { setIsSavingYear(false) }
  }

  async function handleDeleteSchoolYear(year: SchoolYear, previous: SchoolYear) {
    if (!supabase || isSavingYear) return
    if (!window.confirm(`Delete school year ${year.label}? All its activity will move to ${previous.label}. No history or member/equipment information will be deleted.`)) return
    setYearError('')
    setIsSavingYear(true)
    try {
      const { data, error } = await supabase.rpc('delete_school_year', { year_id_to_delete: year.id })
      if (error) throw error
      const years = data as SchoolYear[]
      setSchoolYears(years)
      const latest = years.at(-1)
      if (latest) {
        const next = Number(latest.label.slice(0,4)) + 1
        setNewYearLabel(`${next}/${String(next+1).slice(-2)}`)
      }
      setActivity(await fetchActivity())
    } catch (error) { setYearError(errorMessage(error, 'Could not delete the school year.')) }
    finally { setIsSavingYear(false) }
  }

  function openHistory(scope: HistoryScope) {
    setHistoryScope(scope)
    setView('activity')
    setQuery('')
  }

  async function importMembers(source: string | string[][]) {
    if (!supabase) throw new Error('The secure database is not configured.')
    const imported = rosterRows(typeof source === 'string' ? parseCsv(source) : source)
    const { data, error } = await supabase.rpc('sync_member_roster', { roster: imported })
    if (error) throw error
    setMembers(data as Member[])
    setSyncMessage(`${imported.length} roster row${imported.length === 1 ? '' : 's'} synced. Matching members updated.`)
  }

  async function syncSheet() {
    setSyncMessage('')
    try {
      const url = sheetCsvUrl(sheetUrl.trim())
      setIsSyncing(true)
      const response = await fetch(url)
      if (!response.ok) {
        if ([400, 401, 403].includes(response.status)) {
          throw new Error(`Google refused the CSV export (HTTP ${response.status}). Set General access to Anyone with the link (Viewer) or publish the sheet to the web, then sync again. Private sheets require Google sign-in integration.`)
        }
        throw new Error(`Google Sheets returned HTTP ${response.status}.`)
      }
      await importMembers(await response.text())
    } catch (error) {
      setSyncMessage(error instanceof TypeError
        ? 'Google redirected this sheet to sign-in or blocked its CSV export. Set General access to Anyone with the link (Viewer), publish to the web, or import a CSV file. Private sheets require Google sign-in integration.'
        : errorMessage(error, 'Could not read the sheet. Check the link and sharing settings.'))
    } finally {
      setIsSyncing(false)
    }
  }

  async function importCsvFile(file?: File) {
    if (!file || isSyncing) return
    setSyncMessage('')
    setIsSyncing(true)
    try {
      if (file.name.toLowerCase().endsWith('.xlsx')) {
        const { default: ExcelJS } = await import('exceljs')
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(await file.arrayBuffer())
        const sheet = workbook.worksheets.find((worksheet) => worksheet.state === 'visible' && worksheet.actualRowCount > 0)
        if (!sheet) throw new Error('This workbook has no visible roster sheet.')
        const rows: string[][] = []
        sheet.eachRow((row) => {
          const values = Array.from({ length: sheet.columnCount }, (_, index) => row.getCell(index + 1).text.trim())
          row.eachCell((cell) => {
            if (cell.value && typeof cell.value === 'object' && 'hyperlink' in cell.value) values.push(cell.value.hyperlink)
          })
          if (values.some(Boolean)) rows.push(values)
        })
        await importMembers(rows)
      } else if (file.name.toLowerCase().endsWith('.csv')) {
        await importMembers(await file.text())
      } else {
        throw new Error('Choose a CSV or .xlsx file. Save older .xls workbooks as .xlsx first.')
      }
    } catch (error) {
      setSyncMessage(errorMessage(error, 'Could not read this roster file.'))
    } finally {
      setIsSyncing(false)
    }
  }

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setAuthError('')
    setWorkspaceError('')
    setIsSigningIn(true)
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword })
      if (error) setAuthError(error.message)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not sign in.')
    } finally {
      setIsSigningIn(false)
    }
  }

  async function handleSetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setAuthError('')
    if (newPassword !== confirmPassword) {
      setAuthError('Passwords do not match.')
      return
    }
    setIsSavingPassword(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) throw error
      setNeedsPasswordSetup(false)
      setNewPassword('')
      setConfirmPassword('')
      const url = new URL(window.location.href)
      url.searchParams.delete('setup')
      url.hash = ''
      window.history.replaceState(null, '', url)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not save your password.')
    } finally {
      setIsSavingPassword(false)
    }
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    setProfileError('')
    setIsSavingProfile(true)
    try {
      const { error } = await supabase.rpc('complete_executive_profile', {
        full_name: String(form.get('fullName')).trim(), phone_number: String(form.get('phone')),
      })
      if (error) throw error
      setWorkspaceLoadedFor(null)
      setReviewingProfileDuplicates(false)
      setWorkspaceRetry((retry) => retry + 1)
    } catch (error) {
      setProfileError(errorMessage(error, 'Could not save your profile.'))
    } finally { setIsSavingProfile(false) }
  }

  async function inviteMember(member: Member) {
    if (!supabase || invitingMemberId) return
    setInvitingMemberId(member.id)
    setInvitationMessage('')
    try {
      const { data, error } = await supabase.functions.invoke('invite-member', { body: { memberId: member.id } })
      if (error) {
        const context = 'context' in error ? error.context : null
        if (context instanceof Response) {
          const body = await context.json().catch(() => null)
          if (body?.error) throw new Error(body.error)
        }
        throw error
      }
      if (data?.error) throw new Error(data.error)
      setInvitationMessage(data?.message ?? `Invitation sent to ${member.email}.`)
      setWorkspaceRetry((retry) => retry + 1)
    } catch (error) {
      setInvitationMessage(errorMessage(error, 'Could not send the invitation.'))
    } finally { setInvitingMemberId(null) }
  }

  async function handleMerge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || modal?.kind !== 'merge-member' || !mergeTargetId) return
    const sourceId = modal.memberId
    setMergeError('')
    setIsMerging(true)
    try {
      const { data, error } = await supabase.rpc('merge_members', { duplicate_id: sourceId, keep_id: mergeTargetId })
      if (error) throw error
      setMembers(data as Member[])
      setGear((items) => items.map((item) => item.memberId === sourceId ? { ...item, memberId: mergeTargetId } : item))
      setActivity((entries) => entries.map((entry) => entry.memberId === sourceId ? { ...entry, memberId: mergeTargetId } : entry))
      setModal(null)
    } catch (error) {
      setMergeError(errorMessage(error, 'Could not merge these members.'))
    } finally { setIsMerging(false) }
  }

  function confirmDeleteMember(memberId: string) {
    setDeleteMemberError('')
    setModal({ kind: 'delete-member', memberId })
  }

  async function handleDeleteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || modal?.kind !== 'delete-member') return
    const memberId = modal.memberId
    setDeleteMemberError('')
    setIsDeletingMember(true)
    try {
      const { error } = await supabase.rpc('delete_member', { member_id_to_delete: memberId })
      if (error) throw error
      setMembers((people) => people.filter((member) => member.id !== memberId))
      setModal(null)
    } catch (error) { setDeleteMemberError(errorMessage(error, 'Could not delete this member.')) }
    finally { setIsDeletingMember(false) }
  }

  async function handleSignOut() {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) setAuthError(error.message)
    setAuthPassword('')
  }

  const schoolYear = schoolYearForDate(new Date(), schoolYears)
  const latestYear = schoolYears.at(-1)
  const nextAllowedStart = latestYear ? new Date(Date.parse(`${latestYear.start_date}T00:00:00Z`) + 86400000).toISOString().slice(0,10) : undefined
  const pageTitle = view === 'inventory' ? 'Equipment inventory' : view === 'loans' ? 'Issue / return' : view === 'members' ? 'Club members' : view === 'settings' ? 'Settings' : 'Equipment & member history'
  const pageDescription = view === 'inventory'
    ? 'Track every piece of club equipment, from the shelf to the table.'
    : view === 'loans'
      ? 'Record equipment handoffs and manage active loans.'
      : view === 'members'
      ? 'Member contact details and current equipment loans.'
      : view === 'settings'
        ? 'Set the appearance and club details for this workspace.'
        : 'Follow equipment and members across school years, with handoff details for every recorded event.'

  if (!isSupabaseConfigured) {
    return <div className={`auth-shell ${theme === 'dark' ? 'dark-auth' : ''}`}><section className="auth-panel"><span className="eyebrow">SECURE WORKSPACE</span><h1>Database setup required</h1><p>Add your Supabase project URL and public anon key to a local <code>.env.local</code> file. Use <code>.env.example</code> as the template, then restart the dev server.</p><p>The database schema and executive-only row-level security policies are in <code>supabase/schema.sql</code>.</p></section></div>
  }

  if (!authReady) {
    return <div className={`auth-shell ${theme === 'dark' ? 'dark-auth' : ''}`}><section className="auth-panel"><span className="eyebrow">SECURE WORKSPACE</span><h1>Checking session</h1><p>Connecting to the club workspace…</p></section></div>
  }

  if (!authUser) {
    return <div className={`auth-shell ${theme === 'dark' ? 'dark-auth' : ''}`}><form className="auth-panel" onSubmit={handleSignIn}>
      <span className="eyebrow">UNIVERSITY OF VIRGINIA · POOL CLUB</span>
      <h1>Executive sign in</h1>
      <p>{needsPasswordSetup ? 'Open a valid invitation email link to set your password. If the link has expired or was already used, ask your administrator for a new invitation or password reset.' : 'Sign in with an approved club executive account.'}</p>
      <label>Email<input type="email" autoComplete="username" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} /></label>
      {authError && <p className="gate-error" role="alert">{authError}</p>}
      <button className="primary-button" type="submit" disabled={isSigningIn}>{isSigningIn ? 'Signing in…' : 'Sign in'}</button>
      <p className="auth-footnote">Accounts are invited and approved by a club administrator.</p>
    </form></div>
  }

  if (needsPasswordSetup) {
    return <div className={`auth-shell ${theme === 'dark' ? 'dark-auth' : ''}`}><form className="auth-panel" onSubmit={handleSetPassword}>
      <span className="eyebrow">CLUB ACCOUNT</span>
      <h1>Set your password</h1>
      <p>Choose a password for {authUser.email} to finish setting up your account.</p>
      <label>New password<input type="password" autoComplete="new-password" minLength={8} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
      <label>Confirm password<input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      {authError && <p className="gate-error" role="alert">{authError}</p>}
      <button className="primary-button" type="submit" disabled={isSavingPassword}>{isSavingPassword ? 'Saving password…' : 'Save password and continue'}</button>
      <button className="secondary-button" type="button" disabled={isSavingPassword} onClick={() => { void handleSignOut() }}>Sign out</button>
    </form></div>
  }

  if (workspaceLoadedFor !== authUser.id && !workspaceError) {
    return <div className={`auth-shell ${theme === 'dark' ? 'dark-auth' : ''}`}><section className="auth-panel"><span className="eyebrow">SECURE WORKSPACE</span><h1>Loading club data</h1><p>Verifying executive access and loading shared records…</p></section></div>
  }

  if (workspaceError || !workspaceAccess) {
    return <div className={`auth-shell ${theme === 'dark' ? 'dark-auth' : ''}`}><section className="auth-panel"><span className="eyebrow">SECURE WORKSPACE</span><h1>{workspaceError ? 'Could not load club data' : 'Access not approved'}</h1><p>{workspaceError || 'Your account is not on the club executive access list. Contact a database administrator.'}</p><div className="gate-actions">{workspaceError && <button className="primary-button" onClick={() => { setWorkspaceError(''); setWorkspaceRetry((retry) => retry + 1) }}>Try again</button>}<button className="secondary-button" onClick={() => { void handleSignOut() }}>Sign out</button></div></section></div>
  }

  const ownMember = members.find((member) => member.auth_user_id === authUser.id)
  if (!ownMember?.profile_completed_at && (!reviewingProfileDuplicates || view !== 'members')) {
    return <div className={`auth-shell ${theme === 'dark' ? 'dark-auth' : ''}`}><form className="auth-panel" onSubmit={handleProfileSubmit}>
      <span className="eyebrow">EXECUTIVE PROFILE</span><h1>Your contact details</h1>
      <p>Add your name and U.S. phone number once so we can connect your account to any existing roster entry.</p>
      <label>Full name<input name="fullName" autoComplete="name" required value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
      <label>Phone<PhoneInput key={`${authUser.id}:${profilePhone}`} defaultValue={profilePhone} required /></label>
      {profileError && <p className="gate-error" role="alert">{profileError}</p>}
      {profileError && <button className="secondary-button" type="button" disabled={isSavingProfile} onClick={() => { setView('members'); setReviewingProfileDuplicates(true) }}>Review duplicate members</button>}
      <button className="primary-button" type="submit" disabled={isSavingProfile}>{isSavingProfile ? 'Saving details…' : 'Save details and continue'}</button>
      <button className="secondary-button" type="button" disabled={isSavingProfile} onClick={() => { void handleSignOut() }}>Sign out</button>
    </form></div>
  }

  return (
    <div className={`app-shell ${theme === 'dark' ? 'dark-theme' : ''}`}>
      <aside className="sidebar">
        <a className="brand" href="#inventory" onClick={() => setView('inventory')}>
          <span className="brand-mark"><ArrowDownUp size={19} strokeWidth={2.2} /></span>
          <span><strong>{clubName}</strong><small>UNIVERSITY OF VIRGINIA</small></span>
        </a>
        <div className="rail-label">Workspace</div>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={view === 'loans' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('loans'); setQuery('') }}>
            <ArrowUpDown size={18} /><span>Issue / Return</span><span className="nav-count">{loanedCount}</span>
          </button>
          <button className={view === 'inventory' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('inventory'); setQuery('') }}>
            <Package size={18} /><span>Equipment</span><span className="nav-count">{gear.length}</span>
          </button>
          <button className={view === 'members' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('members'); setQuery('') }}>
            <Users size={18} /><span>Members</span><span className="nav-count">{activeMembers.length}</span>
          </button>
          <button className={view === 'activity' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('activity'); setQuery(''); setHistoryScope(null) }}>
            <Clock3 size={18} /><span>Activity / History</span>
          </button>
          <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('settings'); setQuery('') }}>
            <SettingsIcon size={18} /><span>Settings</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="side-note-icon"><Boxes size={17} /></div>
          <p>Equipment stays club property. Keep every handoff on record.</p>
          <span className="local-status"><span /> Secure club workspace</span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>{clubName}</span><span className="crumb-slash">/</span><strong>{pageTitle}</strong></div>
          <div className="topbar-right"><span className="year-tag">{schoolYear === 'Unassigned' ? 'Set school year' : schoolYear}</span><span className="avatar">{authUser.email?.[0]?.toUpperCase() ?? 'E'}</span><span className="exec-label">{authUser.email}</span><button className="icon-button sign-out-button" title="Sign out" aria-label="Sign out" onClick={() => { void handleSignOut() }}><LogOut size={16} /></button></div>
        </header>

        <div className="page-content">
          {dataError && <div className="data-error" role="alert">{dataError}</div>}
          <section className="page-heading">
            <div>
              <div className="eyebrow">Club operations <span>·</span> {view === 'inventory' ? 'Equipment desk' : view === 'loans' ? 'Handoffs' : view === 'members' ? 'Roster' : 'Handoff log'}</div>
              <h1>{pageTitle}</h1>
              <p>{pageDescription}</p>
            </div>
            {(view === 'inventory' || view === 'members') && (
              <button className="primary-button" onClick={() => { if (view === 'inventory') { setNewGearCategory('Case'); setNewGearCueUse('Playing'); setSerialDigits('') }; setModal({ kind: view === 'inventory' ? 'gear' : 'member' }) }}>
                <Plus size={17} /> {view === 'inventory' ? 'Add equipment' : 'Add member'}
              </button>
            )}
          </section>

          {view === 'inventory' && (
            <>
              <section className="stats-row" aria-label="Inventory summary">
                <div className="stat-block"><span className="stat-label">Total items</span><strong>{gear.length.toString().padStart(2, '0')}</strong><span className="stat-foot">registered in inventory</span></div>
                <div className="stat-block"><span className="stat-label">On loan</span><strong>{loanedCount.toString().padStart(2, '0')}<i className="stat-dot loaned" /></strong><span className="stat-foot">with club members</span></div>
                <div className="stat-block"><span className="stat-label">Available</span><strong>{availableCount.toString().padStart(2, '0')}<i className="stat-dot available" /></strong><span className="stat-foot">ready to be borrowed</span></div>
              </section>
              <section className="ledger-section">
                <div className="section-toolbar">
                  <div className="section-title"><h2>All equipment</h2><span>{gear.length} items</span></div>
                  <label className="search-field"><Search size={16} /><input aria-label="Search equipment" placeholder="Search equipment" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>/</kbd></label>
                </div>
                <div className="table-wrap">
                  <table className="data-table inventory-table">
                    <thead><tr>
                      <SortHeading label="Item" sortKey="name" sort={sort} onSort={toggleSort} />
                      <SortHeading label="Type" sortKey="category" sort={sort} onSort={toggleSort} />
                      <SortHeading label="Cue use" sortKey="cueUse" sort={sort} onSort={toggleSort} />
                      <SortHeading label="Currently with" sortKey="member" sort={sort} onSort={toggleSort} />
                      <SortHeading label="Last updated" sortKey="updatedAt" sort={sort} onSort={toggleSort} />
                      <th className="action-heading"><span className="sr-only">Actions</span></th>
                    </tr></thead>
                    <tbody>
                      {visibleGear.map((item) => {
                        const assignedMember = item.memberId ? memberById.get(item.memberId) : undefined
                        return <tr key={item.id}>
                          <td><EquipmentLabel item={item} member={item.memberId ? memberById.get(item.memberId) : undefined} /></td>
                          <td><span className="category-label">{item.category}</span></td>
                          <td><span className={`cue-use ${item.cueUse.toLowerCase().replaceAll(' ', '-')}`}>{item.cueUse === 'Not applicable' ? '—' : `${item.cueUse} cue`}</span></td>
                          <td>{assignedMember ? <div className="member-cell"><span className="mini-avatar">{assignedMember.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><span>{assignedMember.name}</span></div> : item.memberId ? <span className="equipment-unverified">Borrower missing — review loan</span> : <span className="reserve-label"><i />In reserve</span>}</td>
                          <td className="date-cell">{formatDate(item.updatedAt)}</td>
                          <td><div className="row-actions">
                            {item.memberId
                              ? <button className="text-action return-action" onClick={() => returnGear(item)}><ArrowDownToLine size={15} /> Return</button>
                              : <button className="text-action issue-action" onClick={() => setModal({ kind: 'checkout', gearId: item.id })} disabled={activeMembers.length === 0}><ArrowUpDown size={15} /> Issue</button>}
                            <button className="text-action" aria-label={`History for ${item.name}`} onClick={() => openHistory({ gear: item.id })}><Clock3 size={15} /> History</button>
                            <button className="icon-button delete-button" title="Remove equipment" aria-label={`Remove ${item.name}`} onClick={() => removeGear(item)}><Trash2 size={15} /></button>
                          </div></td>
                        </tr>
                      })}
                      {visibleGear.length === 0 && <tr><td className="empty-row" colSpan={6}>{gear.length === 0 ? 'No equipment has been added yet.' : `No equipment matches “${query}”.`}</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div className="table-footer"><span>Showing <strong>{visibleGear.length}</strong> of <strong>{gear.length}</strong> items</span><span><ArrowUpDown size={13} /> Select a column heading to sort</span></div>
              </section>
            </>
          )}

          {view === 'loans' && (
            <section className="loan-workspace">
              <div className="loan-overview">
                <div><span className="stat-label">CURRENTLY ON LOAN</span><strong>{loanedCount.toString().padStart(2, '0')}</strong></div>
                <div><span className="stat-label">READY TO ISSUE</span><strong>{availableCount.toString().padStart(2, '0')}</strong></div>
                <div><span className="stat-label">ACTIVE MEMBERS</span><strong>{activeMembers.length.toString().padStart(2, '0')}</strong></div>
              </div>
              <section className="ledger-section issue-panel">
                <div className="section-toolbar"><div className="section-title"><h2>Issue equipment</h2><span>NEW HANDOFF</span></div></div>
                <form className="workspace-issue-form" onSubmit={handleWorkspaceCheckout}>
                  <label>Equipment<select name="gear" required defaultValue="" disabled={!availableGear.length}><option value="" disabled>Select available equipment</option>{availableGear.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.category}{item.cueUse !== 'Not applicable' ? ` · ${item.cueUse} cue` : ''}</option>)}</select></label>
                  <label>Issue to<select name="member" required defaultValue="" disabled={!activeMembers.length}><option value="" disabled>Select a member</option>{activeMembers.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
                  <button className="primary-button" type="submit" disabled={!availableGear.length || !activeMembers.length}><ArrowUpDown size={16} /> Record issue</button>
                </form>
              </section>
              <section className="ledger-section active-loans-panel">
                <div className="section-toolbar"><div className="section-title"><h2>Outstanding loans</h2><span>{loanedCount} ITEMS</span></div></div>
                <div className="table-wrap"><table className="data-table active-loans-table"><thead><tr><th>EQUIPMENT</th><th>CUE USE</th><th>ISSUED TO</th><th>LAST UPDATED</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>
                  {loanedGear.map((item) => {
                    const member = memberById.get(item.memberId ?? '')
                    return <tr key={item.id}><td><EquipmentLabel item={item} member={item.memberId ? memberById.get(item.memberId) : undefined} /></td><td><span className={`cue-use ${item.cueUse.toLowerCase()}`}>{item.cueUse === 'Not applicable' ? '—' : `${item.cueUse} cue`}</span></td><td>{member ? <div className="member-cell"><span className="mini-avatar">{member.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><span>{member.name}</span></div> : <span className="muted">Member not on roster</span>}</td><td className="date-cell">{formatDate(item.updatedAt)}</td><td><button className="text-action return-action" onClick={() => returnGear(item)}><ArrowDownToLine size={15} /> Return</button></td></tr>
                  })}
                  {!loanedGear.length && <tr><td className="empty-row" colSpan={5}>No equipment is currently checked out.</td></tr>}
                </tbody></table></div>
                <div className="table-footer"><span>SHOWING <strong>{loanedCount}</strong> ACTIVE LOANS</span><span>Returns are recorded in activity history.</span></div>
              </section>
            </section>
          )}

          {view === 'members' && (
            <>
              {reviewingProfileDuplicates && !ownMember?.profile_completed_at && <div className="profile-reminder"><span>Merge the matching duplicates, then finish your contact details.</span><button className="secondary-button" onClick={() => { setReviewingProfileDuplicates(false); setProfileError('') }}>Finish profile</button></div>}
              <section className="member-summary"><div><span className="stat-label">ACTIVE ROSTER</span><strong>{activeMembers.length.toString().padStart(2, '0')}</strong><span className="stat-foot">members on file</span></div><div><span className="stat-label">CURRENT LOANS</span><strong>{loanedCount.toString().padStart(2, '0')}</strong><span className="stat-foot">items assigned to members</span></div><div className="roster-import"><div className="import-heading"><div><span className="stat-label">ROSTER SOURCE</span><strong>Google Sheets</strong></div><span className="sync-mark"><RefreshCw size={15} /></span></div><div className="sheet-controls"><input aria-label="Google Sheets URL" type="url" placeholder="Paste a public Sheets link" value={sheetUrl} onChange={(event) => setSheetUrl(event.target.value)} /><button onClick={syncSheet} disabled={!sheetUrl.trim() || isSyncing}>{isSyncing ? <RefreshCw className="spin" size={15} /> : <RefreshCw size={15} />} Sync</button><label className="file-import" title="Import CSV or Excel roster"><ArrowDownToLine size={15} /><input type="file" aria-label="Import CSV or Excel roster" disabled={isSyncing} accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { void importCsvFile(event.target.files?.[0]); event.currentTarget.value = '' }} /></label></div><span className={`sync-message ${syncMessage && !syncMessage.includes('synced') ? 'sync-error' : ''}`}>{syncMessage || 'Share with Anyone with the link (Viewer), or import CSV / Excel (.xlsx).'}</span></div></section>
              <div className="member-invitation-note"><p>Invitations give members executive access to the workspace.</p>{invitationMessage && <p role="status">{invitationMessage}</p>}</div>
              <MemberDirectory title="Active member directory" members={visibleMembers.filter(isActiveMember)} total={activeMembers.length} gear={gear} invitingMemberId={invitingMemberId}
                search={<label className="search-field"><Search size={16} /><input aria-label="Search active and emeritus members" placeholder="Search all members" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>/</kbd></label>}
                onProfile={(member) => setModal({ kind: 'profile-member', memberId: member.id })} onDelete={(member) => confirmDeleteMember(member.id)} onEdit={(member) => setModal({ kind: 'edit-member', memberId: member.id })} onInvite={(member) => { void inviteMember(member) }} onHistory={(member) => openHistory({ member: member.id })} />
              <MemberDirectory title="Emeritus" members={visibleMembers.filter((member) => member.is_emeritus)} total={emeritusMembers.length} gear={gear} invitingMemberId={invitingMemberId}
                onProfile={(member) => setModal({ kind: 'profile-member', memberId: member.id })} onDelete={(member) => confirmDeleteMember(member.id)} onEdit={(member) => setModal({ kind: 'edit-member', memberId: member.id })} onInvite={(member) => { void inviteMember(member) }} onHistory={(member) => openHistory({ member: member.id })} />
            </>
          )}

          {view === 'activity' && <HistoryPanel key={JSON.stringify(historyScope)} entries={activity} gear={gear} members={members} schoolYears={schoolYears} scope={historyScope} />}
          {view === 'settings' && (
            <section className="settings-section">
              <div className="settings-group">
                <div className="settings-copy"><h2>Appearance</h2><p>Choose how the inventory workspace is displayed.</p></div>
                <div className="theme-options" role="group" aria-label="Color theme">
                  <button className={theme === 'light' ? 'theme-option selected' : 'theme-option'} aria-pressed={theme === 'light'} onClick={() => { setTheme('light'); setSettingsSaved(false) }}><Sun size={17} /> Light</button>
                  <button className={theme === 'dark' ? 'theme-option selected' : 'theme-option'} aria-pressed={theme === 'dark'} onClick={() => { setTheme('dark'); setSettingsSaved(false) }}><Moon size={17} /> Dark</button>
                </div>
              </div>
              <div className="settings-group club-details-group">
                <div className="settings-copy"><h2>Club details</h2><p>These details appear in the workspace header and footer.</p></div>
                <div className="settings-fields">
                  <label>Club name<input value={clubName} maxLength={48} onChange={(event) => { setClubName(event.target.value); setSettingsSaved(false) }} placeholder="Break Pool Club" /></label>

                </div>
              </div>
              <div className="settings-actions"><p className="settings-saved" aria-live="polite">{settingsSaved ? 'All changes saved on this device.' : 'You have unsaved changes.'}</p><button className="primary-button" onClick={saveSettings}><Save size={16} /> Save settings</button></div>
              <form className="settings-group school-year-settings" onSubmit={handleStartSchoolYear}>
                <div className="settings-copy"><h2>School years</h2><p>Choose when each school year begins. The previous year ends the day before that start date. These settings apply to everyone.</p><p>Current school year: <strong>{schoolYear}</strong></p></div>
                <div className="settings-fields"><label>New school year<input required pattern="[0-9]{4}/[0-9]{2}" title="Use consecutive years such as 2027/28" placeholder="2027/28" value={newYearLabel} onChange={(event) => setNewYearLabel(event.target.value)} /></label><label>Start date<input required type="date" min={nextAllowedStart} value={newYearStart} onChange={(event) => setNewYearStart(event.target.value)} /></label>
                  {latestYear && <p className="school-year-note">Start after {latestYear.start_date}. Earlier activity stays in its original school year.</p>}
                  {yearError && <p className="gate-error" role="alert">{yearError}</p>}
                  <button type="submit" className="primary-button" disabled={isSavingYear}>{isSavingYear ? 'Saving school year…' : 'Save new school year'}</button>
                  <ul className="school-year-list">{schoolYears.map((year,index) => <li key={year.id}><div className="school-year-actions"><strong>{year.label}</strong><button type="button" className="text-action danger-text" disabled={isSavingYear || index === 0} title={index === 0 ? 'The first school year has no previous year to receive its history' : `Move history to ${schoolYears[index-1].label}`} onClick={() => { void handleDeleteSchoolYear(year, schoolYears[index-1]) }}>Delete</button></div><span>From {year.start_date}{schoolYears[index+1] ? ` · until ${schoolYears[index+1].start_date} (exclusive)` : ' · open until the next school year'}</span>{index === 0 && <span>The first school year cannot be deleted because it has no previous year.</span>}</li>)}</ul>
                </div>
              </form>
            </section>
          )}
          <footer className="page-footer"><span>{clubName} <span>·</span> Equipment desk</span><span>Shared club data <i /></span></footer>
        </div>
      </main>

      {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isMerging && !isDeletingMember) setModal(null) }}>
        <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="modal-heading"><div><span className="eyebrow">EQUIPMENT DESK</span><h2 id="modal-title">{modal.kind === 'profile-member' ? 'Member profile' : modal.kind === 'gear' ? 'Add equipment' : modal.kind === 'member' ? 'Add a member' : modal.kind === 'edit-member' ? 'Edit member' : modal.kind === 'merge-member' ? 'Merge duplicate member' : modal.kind === 'delete-member' ? 'Delete member' : 'Issue equipment'}</h2></div><button className="icon-button close-button" disabled={isMerging || isDeletingMember} onClick={() => setModal(null)} aria-label="Close dialog"><X size={19} /></button></div>
          {modal.kind === 'profile-member' && members.filter((member) => member.id === modal.memberId).map((member) => <MemberProfile key={member.id} member={member} gear={gear} onEdit={() => setModal({ kind: 'edit-member', memberId: member.id })} onHistory={() => { setModal(null); openHistory({ member: member.id }) }} />)}
          {modal.kind === 'gear' && <form className="modal-form" onSubmit={handleAddGear}>
            <label>Equipment name<input name="name" required placeholder="e.g. Predator soft case" autoFocus /></label>
              <div className="form-grid"><label>Equipment type<select name="category" value={newGearCategory} onChange={(event) => setNewGearCategory(event.target.value as GearCategory)}><option>Case</option><option>Shaft</option><option>Butt</option><option>Accessory</option></select></label>{(newGearCategory === 'Butt' || newGearCategory === 'Shaft') && <label>Cue use<select name="cueUse" value={newGearCueUse} onChange={(event) => setNewGearCueUse(event.target.value as Exclude<CueUse, 'Not applicable'>)}><option>Playing</option><option>Break</option><option>Jump</option></select></label>}</div>
            <label>Inventory ID <span className="optional">OPTIONAL</span><span className="serial-entry"><span className="serial-prefix">{serialPrefix(newGearCategory)}-</span><input name="serialDigits" aria-label="Serial number digits" inputMode="numeric" pattern="[0-9]*" maxLength={8} placeholder="Enter numbers" value={serialDigits} onChange={(event) => setSerialDigits(event.target.value.replace(/\D/g, ''))} />{(newGearCategory === 'Butt' || newGearCategory === 'Shaft') && <span className="serial-suffix">-{cueUseSuffix(newGearCueUse)}</span>}</span></label>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" type="submit"><Plus size={16} /> Add item</button></div>
          </form>}
          {(modal.kind === 'member' || modal.kind === 'edit-member') && <form className="modal-form" onSubmit={(event) => handleMemberSubmit(event, modal.kind === 'edit-member' ? modal.memberId : undefined)}>
            <label>Membership<select name="membership" defaultValue={modal.kind === 'edit-member' && members.find((member) => member.id === modal.memberId)?.is_emeritus ? 'emeritus' : 'active'}><option value="active">Active member</option><option value="emeritus">Emeritus</option></select></label>
            <label>Full name<input name="name" required placeholder="Member name" defaultValue={modal.kind === 'edit-member' ? members.find((member) => member.id === modal.memberId)?.name ?? '' : ''} autoFocus /></label><label>UVA Email<input name="email" type="email" placeholder="name@virginia.edu" defaultValue={modal.kind === 'edit-member' ? members.find((member) => member.id === modal.memberId)?.email ?? '' : ''} /></label><div className="form-grid"><label>Phone<PhoneInput key={modal.kind === 'edit-member' ? modal.memberId : 'new-member'} defaultValue={modal.kind === 'edit-member' ? members.find((member) => member.id === modal.memberId)?.phone ?? '' : ''} /></label><label>Class year<input name="year" inputMode="numeric" placeholder="2027" defaultValue={modal.kind === 'edit-member' ? members.find((member) => member.id === modal.memberId)?.year ?? '' : ''} /></label></div>
            <div className="modal-actions">{modal.kind === 'edit-member' && <button type="button" className="secondary-button merge-launch" onClick={() => { setMergeTargetId(''); setMergeError(''); setModal({ kind: 'merge-member', memberId: modal.memberId }) }}>Merge duplicate</button>}<button type="button" className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" type="submit">{modal.kind === 'edit-member' ? 'Save changes' : <><Plus size={16} /> Add member</>}</button></div>
          </form>}
          {modal.kind === 'merge-member' && <form className="modal-form" onSubmit={handleMerge}>
            <p className="modal-intro">Merge <strong>{members.find((member) => member.id === modal.memberId)?.name}</strong> into the record selected below. The selected record stays; this duplicate is removed. Equipment loans and the account link move to the selected member.</p>
            <label>Keep this member<select required value={mergeTargetId} disabled={isMerging} onChange={(event) => setMergeTargetId(event.target.value)}><option value="">Choose the member to keep</option>{members.filter((member) => member.id !== modal.memberId).map((member) => <option key={member.id} value={member.id}>{member.name} — {member.email || member.phone || 'No contact details'}</option>)}</select></label>
            {mergeTargetId && <div className="merge-preview"><strong>{members.find((member) => member.id === mergeTargetId)?.name} will remain</strong><p>Existing contact details on this record are kept. Empty fields are filled from the duplicate. All loans are kept. If either record is emeritus, the merged member stays emeritus.</p></div>}
            {mergeError && <p className="gate-error" role="alert">{mergeError}</p>}
            <div className="modal-actions"><button type="button" className="secondary-button" disabled={isMerging} onClick={() => setModal({ kind: 'edit-member', memberId: modal.memberId })}>Back</button><button className="primary-button" type="submit" disabled={isMerging || !mergeTargetId}>{isMerging ? 'Merging…' : 'Merge members'}</button></div>
          </form>}
          {modal.kind === 'delete-member' && <form className="modal-form" onSubmit={handleDeleteMember}>
            <p className="modal-intro">Delete <strong>{members.find((member) => member.id === modal.memberId)?.name}</strong> from the directory? Their equipment and handoff history will be kept.</p>
            {members.find((member) => member.id === modal.memberId)?.auth_user_id && <p className="modal-intro">This also removes their executive access. Their Supabase sign-in account remains.</p>}
            {gear.some((item) => item.memberId === modal.memberId) && <p className="gate-error" role="alert">Return or reassign all equipment before deleting this member.</p>}
            {members.find((member) => member.id === modal.memberId)?.auth_user_id === authUser.id && <p className="gate-error" role="alert">You cannot delete your own account. Another executive must do this.</p>}
            <p className="modal-intro">A future roster import can add this person again if they are still in the source sheet.</p>
            {deleteMemberError && <p className="gate-error" role="alert">{deleteMemberError}</p>}
            <div className="modal-actions"><button type="button" className="secondary-button" disabled={isDeletingMember} onClick={() => setModal(null)}>Cancel</button><button type="submit" className="primary-button danger-button" disabled={isDeletingMember || gear.some((item) => item.memberId === modal.memberId) || members.find((member) => member.id === modal.memberId)?.auth_user_id === authUser.id}>{isDeletingMember ? 'Deleting…' : 'Delete member'}</button></div>
          </form>}
          {modal.kind === 'checkout' && <form className="modal-form" onSubmit={(event) => handleCheckout(event, modal.gearId)}>
            <p className="modal-intro">Select the member borrowing <strong>{gear.find((item) => item.id === modal.gearId)?.name}</strong>.</p><label>Issue to<select name="member" required defaultValue=""><option value="" disabled>Select a member</option>{activeMembers.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" type="submit"><Check size={16} /> Record checkout</button></div>
          </form>}
        </section>
      </div>}
    </div>
  )
}

function SortHeading({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: { key: SortKey; direction: 'asc' | 'desc' }; onSort: (key: SortKey) => void }) {
  const selected = sort.key === sortKey
  return <th><button className={`sort-heading ${selected ? 'selected' : ''}`} onClick={() => onSort(sortKey)}>{label}{selected ? sort.direction === 'asc' ? <ArrowUpDown size={13} /> : <ArrowUpDown className="sort-desc" size={13} /> : null}</button></th>
}

export default App
