import type { ReactNode } from 'react'
import { Clock3, Mail, Pencil, Phone } from 'lucide-react'
import { formatUsPhone } from '../lib/phone'

export type DirectoryMember = {
  id: string; name: string; email: string; phone: string; year: string
  is_emeritus?: boolean; auth_user_id?: string | null
}
export default function MemberDirectory({ title, members, total, gear, search, invitingMemberId, onEdit, onInvite, onHistory }: {
  title: string; members: DirectoryMember[]; total: number
  gear: { id: string; name: string; serial: string; memberId: string | null }[]
  search?: ReactNode; invitingMemberId: string | null
  onEdit: (member: DirectoryMember) => void; onInvite: (member: DirectoryMember) => void; onHistory: (member: DirectoryMember) => void
}) {
  return <section className="ledger-section members-ledger">
    <div className="section-toolbar"><div className="section-title"><h2>{title}</h2><span>{total} MEMBERS</span></div>{search}</div>
    <div className="table-wrap"><table className="data-table member-table"><thead><tr><th>MEMBER</th><th>UVA EMAIL</th><th>PHONE</th><th>CLASS YEAR</th><th>EQUIPMENT ON LOAN</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
      {members.map((member) => {
        const assigned = gear.filter((item) => item.memberId === member.id)
        return <tr key={member.id}>
          <td><div className="member-profile"><span className="profile-avatar">{member.name.split(' ').map((part) => part[0]).join('').slice(0,2)}</span><strong>{member.name}</strong></div></td>
          <td><div className="contact-lines">{member.email ? <a href={`mailto:${member.email}`}><Mail size={14} />{member.email}</a> : <span className="muted">No email</span>}</div></td>
          <td><div className="contact-lines">{member.phone ? <span><Phone size={14} />{formatUsPhone(member.phone)}</span> : <span className="muted">No phone</span>}</div></td>
          <td>{member.year ? <span className="year-value">' {member.year.slice(-2)}</span> : <span className="muted">—</span>}</td>
          <td>{assigned.length ? <div className="assigned-list">{assigned.map((item) => <span key={item.id} className={`assigned-equipment equipment-${member.is_emeritus ? 'overdue' : 'loaned'}`}><strong>{item.name}</strong>{item.serial && <small>{item.serial}</small>}<small className="equipment-status">{member.is_emeritus ? 'Overdue — emeritus member' : 'On loan'}</small></span>)}</div> : <span className="muted">No equipment assigned</span>}</td>
          <td><div className="member-actions"><button className="text-action" aria-label={`History for ${member.name}`} onClick={() => onHistory(member)}><Clock3 size={14} /> History</button><button className="text-action edit-member-action" aria-label={`Edit ${member.name}`} onClick={() => onEdit(member)}><Pencil size={14} /> Edit</button><button className="text-action" aria-label={`Invite ${member.name}`} disabled={!member.email || Boolean(member.auth_user_id) || Boolean(invitingMemberId)} title={member.auth_user_id ? 'This member already has an account' : !member.email ? 'Add an email first' : 'Send an invitation granting executive access'} onClick={() => onInvite(member)}><Mail size={14} />{invitingMemberId === member.id ? 'Sending…' : member.auth_user_id ? 'Account linked' : 'Invite'}</button></div></td>
        </tr>
      })}
      {!members.length && <tr><td className="empty-row" colSpan={6}>{total ? 'No members match your search.' : `No ${title === 'Emeritus' ? 'emeritus' : 'active'} members on file.`}</td></tr>}
    </tbody></table></div>
    <div className="table-footer"><span>SHOWING <strong>{members.length}</strong> OF <strong>{total}</strong> MEMBERS</span><span>{title === 'Emeritus' ? 'Outstanding loans are overdue until returned.' : 'Active club roster.'}</span></div>
  </section>
}
