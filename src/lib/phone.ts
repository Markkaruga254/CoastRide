export function normalizePhone(raw: string): string {
  const s = raw.replace(/[^0-9+]/g, '')

  let normalized: string
  if (s.startsWith('+254')) {
    normalized = s
  } else if (s.startsWith('254')) {
    normalized = '+' + s
  } else if (s.startsWith('07') || s.startsWith('01')) {
    normalized = '+254' + s.slice(1)
  } else if (s.startsWith('7') || s.startsWith('1')) {
    normalized = '+254' + s
  } else {
    throw new Error(`Unrecognized phone format: ${raw}`)
  }

  // Kenyan mobile allocations include both 07x and 01x ranges.
  if (!/^\+254[17]\d{8}$/.test(normalized)) {
    throw new Error(`Invalid Kenyan phone number: ${raw}`)
  }

  return normalized
}
