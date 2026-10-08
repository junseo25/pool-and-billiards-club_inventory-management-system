export default function WorkspaceSummary({ label, items }: {
  label: string
  items: { label: string; value: number; description: string; dot?: 'loaned' | 'available' }[]
}) {
  return <section className="stats-row" aria-label={label}>
    {items.map((item) => <div className="stat-block" key={item.label}>
      <span className="stat-label">{item.label}</span>
      <strong>{item.value.toString().padStart(2, '0')}{item.dot && <i className={`stat-dot ${item.dot}`} />}</strong>
      <span className="stat-foot">{item.description}</span>
    </div>)}
  </section>
}
