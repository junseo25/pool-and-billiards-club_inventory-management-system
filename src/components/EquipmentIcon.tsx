import { Package } from 'lucide-react'

export default function EquipmentIcon({ category }: { category: string }) {
  if (category !== 'Case' && category !== 'Shaft' && category !== 'Butt') return <Package size={16} aria-hidden="true" />
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {category === 'Case' ? <>
      <rect x="7" y="2" width="9" height="20" rx="2.5" />
      <path d="M16 8h2v7h-2M10 2v20M7 6h9M7 18h9" />
      <rect x="11.5" y="11" width="3" height="5" rx=".7" />
    </> : <>
      <path d="m4 20 3 1L20 3l-1-1Z" />
      <path d="m8 15 2.5 1.5M5.5 18l2.5 1.5M17.5 4l1.5 1" />
    </>}
  </svg>
}
