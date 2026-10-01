import { useState } from 'react'
import { formatUsPhone } from '../lib/phone'

export default function PhoneInput({ name = 'phone', defaultValue = '', required = false }: {
  name?: string; defaultValue?: string; required?: boolean
}) {
  const [value, setValue] = useState(() => formatUsPhone(defaultValue))
  return <input name={name} type="tel" autoComplete="tel-national" inputMode="tel"
    placeholder="(434) 555-0123" pattern="\([0-9]{3}\) [0-9]{3}-[0-9]{4}"
    title="Enter a 10-digit U.S. phone number" required={required} value={value}
    onChange={(event) => {
      const input = event.currentTarget
      const cursor = input.selectionStart ?? input.value.length
      let digitsBeforeCursor = input.value.slice(0, cursor).replace(/\D/g, '').length
      if (input.value.replace(/\D/g, '').length === 11 && input.value.replace(/\D/g, '').startsWith('1')) digitsBeforeCursor -= 1
      const formatted = formatUsPhone(input.value)
      setValue(formatted)
      input.value = formatted
      let position = 0
      let seen = 0
      while (position < formatted.length && seen < digitsBeforeCursor) {
        if (/\d/.test(formatted[position])) seen += 1
        position += 1
      }
      input.setSelectionRange(position, position)
    }} />
}
