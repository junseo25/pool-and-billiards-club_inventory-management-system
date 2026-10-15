export function computingId(value: string) {
  const normalized = value.trim().toLowerCase()
  return /^[a-z][a-z0-9]*$/.test(normalized) ? normalized : ''
}

export function computingIdFromEmail(email: string) {
  const match = email.trim().toLowerCase().match(/^([^@]+)@virginia\.edu$/)
  return match ? computingId(match[1]) : ''
}
