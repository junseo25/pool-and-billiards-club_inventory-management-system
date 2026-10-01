export function usPhoneDigits(value: string) {
  const digits = value.replace(/\D/g, '')
  return (digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits).slice(0, 10)
}

export function formatUsPhone(value: string) {
  const digits = usPhoneDigits(value)
  if (!digits) return ''
  if (digits.length <= 3) return `(${digits}`
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}
