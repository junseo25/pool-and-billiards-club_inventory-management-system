export type Membership = { is_emeritus?: boolean }
export function isActiveMember(member: Membership) { return !member.is_emeritus }
export function loanState(memberId: string | null, member?: Membership) {
  if (!memberId) return 'reserve'
  if (!member) return 'unverified'
  return member.is_emeritus ? 'overdue' : 'loaned'
}
export function loanMessage(state: ReturnType<typeof loanState>) {
  return state === 'overdue' ? 'Overdue — emeritus member'
    : state === 'reserve' ? 'In reserve'
    : state === 'unverified' ? 'Borrower missing — review loan' : 'On loan'
}
