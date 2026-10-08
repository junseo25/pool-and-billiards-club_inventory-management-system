import type { ReactNode } from 'react'
import { Clock3, Mail, Pencil, Phone, Trash2 } from 'lucide-react'
import { formatUsPhone } from '../lib/phone'

export type DirectoryMember = {
  id: string; name: string; email: string; phone: string; year: string
  is_emeritus?: boolean; auth_user_id?: string | null
}
export default function MemberDirectory({ title, members, total, gear, search, note, invitingMemberId, onEdit, onInvite, onHistory, onDelete, onProfile }: {
  title: string; members: DirectoryMember[]; total: number
  gear: { id: string; name: string; serial: string; memberId: string | null }[]
  search?: ReactNode; note?: ReactNode; invitingMemberId: string | null
  onEdit: (member: DirectoryMember) => void; onInvite: (member: DirectoryMember) => void; onHistory: (member: DirectoryMember) => void
  onDelete: (member: DirectoryMember) => void
  onProfile: (member: DirectoryMember) => void
}) {
  return <section className="ledger-section members-ledger">
    <div className="section-toolbar"><div className="section-title"><h2>{title}</h2><span>{total} MEMBERS</span></div>{search}</div>
    <div className="table-wrap"><table className="data-table member-table"><colgroup><col /><col className="member-email-column" /><col className="member-phone-column" /><col className="member-year-column" /><col className="member-loan-column" /><col className="member-action-column" /></colgroup><thead><tr><th>MEMBER</th><th>UVA EMAIL</th><th>PHONE</th><th>CLASS YEAR</th><th>EQUIPMENT ON LOAN</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
      {members.map((member) => {
        const assigned = gear.filter((item) => item.memberId === member.id)
        return <tr key={member.id}>
          <td><div className="member-profile"><span className="profile-avatar">{member.name.split(' ').map((part) => part[0]).join('').slice(0,2)}</span><strong>{member.name}</strong></div></td>
          <td><div className="contact-lines">{member.email ? <a href={`mailto:${member.email}`}><Mail size={14} />{member.email}</a> : <span className="muted">No email</span>}</div></td>
          <td><div className="contact-lines">{member.phone ? <span><Phone size={14} />{formatUsPhone(member.phone)}</span> : <span className="muted">No phone</span>}</div></td>
          <td>{member.year ? <span className="year-value">' {member.year.slice(-2)}</span> : <span className="muted">—</span>}</td>
          <td>{assigned.length ? <button type="button" className={`member-loan-serials member-loan-button equipment-${member.is_emeritus ? 'overdue' : 'loaned'}`} aria-label={`View ${member.name}'s profile and equipment on loan`} onClick={() => onProfile(member)}><strong>Equipment on loan</strong><small>{member.is_emeritus ? 'Overdue — emeritus member' : 'On loan'}</small></button> : <span className="muted">No equipment assigned</span>}</td>
          <td><div className="member-actions"><button className="text-action" aria-label={`History for ${member.name}`} onClick={() => onHistory(member)}><Clock3 size={14} /> History</button><button className="text-action edit-member-action" aria-label={`Edit ${member.name}`} onClick={() => onEdit(member)}><Pencil size={14} /> Edit</button><button className="text-action" aria-label={`Invite ${member.name}`} disabled={!member.email || Boolean(member.auth_user_id) || Boolean(invitingMemberId)} title={member.auth_user_id ? 'This member already has an account' : !member.email ? 'Add an email first' : 'Send an invitation granting executive access'} onClick={() => onInvite(member)}><Mail size={14} />{invitingMemberId === member.id ? 'Sending…' : member.auth_user_id ? 'Account linked' : 'Invite'}</button><button className="text-action danger-text" aria-label={`Delete ${member.name}`} onClick={() => onDelete(member)}><Trash2 size={14} /> Delete</button></div></td>
        </tr>
      })}
      {!members.length && <tr><td className="empty-row" colSpan={6}>{total ? 'No members match your search.' : `No ${title === 'Emeritus' ? 'emeritus' : 'active'} members on file.`}</td></tr>}
    </tbody></table></div>
    {note}
    <div className="table-footer"><span>SHOWING <strong>{members.length}</strong> OF <strong>{total}</strong> MEMBERS</span><span>{title === 'Emeritus' ? 'Outstanding loans are overdue until returned.' : 'Active club roster.'}</span></div>
  </section>
}
