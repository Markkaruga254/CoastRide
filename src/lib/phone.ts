export function normalizePhone(raw: string): string {
  const s = raw.replace(/[^0-9+]/g, '')

  let normalized: string
  if (s.startsWith('+254')) {
    normalized = s
  } else if (s.startsWith('254')) {
    normalized = '+' + s
  } else if (s.startsWith('07')) {
    normalized = '+254' + s.slice(1)
  } else if (s.startsWith('7')) {
    normalized = '+254' + s
  } else {
    throw new Error(`Unrecognized phone format: ${raw}`)
  }

  if (!/^\+2547\d{8}$/.test(normalized)) {
    throw new Error(`Invalid Kenyan phone number: ${raw}`)
  }

  return normalized
}
