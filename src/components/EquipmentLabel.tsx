import EquipmentIcon from './EquipmentIcon'
import { loanMessage, loanState, type Membership } from '../lib/membership'

export default function EquipmentLabel({ item, member }: {
  item: { name: string; serial: string; category: string; memberId: string | null }; member?: Membership
}) {
  const status = loanState(item.memberId, member)
  return <div className={`item-name equipment-${status}`}>
    <span className={`item-symbol ${item.category.toLowerCase()}`}><EquipmentIcon category={item.category} /></span>
    <span><strong>{item.name}</strong><small>{item.serial || 'No ID tag'}</small>
      <small className="equipment-status">{loanMessage(status)}</small>
    </span>
  </div>
}
