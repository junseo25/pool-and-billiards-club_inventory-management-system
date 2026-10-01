import type { DirectoryMember } from './MemberDirectory'
import { formatUsPhone } from '../lib/phone'

export default function MemberProfile({ member, gear, onHistory, onEdit }: {
  member: DirectoryMember
  gear: { id: string; name: string; serial: string; category: string; cueUse: string; memberId: string | null }[]
  onHistory: () => void
  onEdit: () => void
}) {
  const assigned = gear.filter((item) => item.memberId === member.id)
  return <div className="modal-form member-profile-details">
    <h3>{member.name}</h3>
    <dl className="profile-details">
      <div><dt>Membership</dt><dd>{member.is_emeritus ? 'Emeritus' : 'Active member'}</dd></div>
      <div><dt>UVA Email</dt><dd>{member.email ? <a href={`mailto:${member.email}`}>{member.email}</a> : 'No email'}</dd></div>
      <div><dt>Phone</dt><dd>{member.phone ? <a href={`tel:${member.phone}`}>{formatUsPhone(member.phone)}</a> : 'No phone'}</dd></div>
      <div><dt>Class year</dt><dd>{member.year || 'Not provided'}</dd></div>
    </dl>
    <h3>Equipment on loan <span className="muted">({assigned.length})</span></h3>
    {assigned.length ? <ul className="profile-equipment-list">{assigned.map((item) => <li key={item.id} className={`equipment-${member.is_emeritus ? 'overdue' : 'loaned'}`}>
      <strong>{item.name}</strong><span>{item.serial || 'No serial number'}</span>
      <span>{item.category}{item.cueUse !== 'Not applicable' ? ` · ${item.cueUse}` : ''}</span>
      <small>{member.is_emeritus ? 'Overdue — emeritus member' : 'On loan'}</small>
    </li>)}</ul> : <p className="muted">No equipment assigned.</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onHistory}>View history</button><button type="button" className="primary-button" onClick={onEdit}>Edit member</button></div>
  </div>
}
