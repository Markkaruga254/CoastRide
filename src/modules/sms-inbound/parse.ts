export type SmsCommand =
  | { kind: 'accept'; ref: string }
  | { kind: 'decline'; ref: string }
  | { kind: 'arrived'; ref: string }
  | { kind: 'done'; ref: string }
  | { kind: 'delay'; ref: string; minutes: number }
  | { kind: 'cancel'; ref: string }
  | { kind: 'unknown' }

const REF_PATTERN = /^CR\d{4}$/i
const MIN_DELAY = 5
const MAX_DELAY = 720

export function parseSms(text: string): SmsCommand {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length < 2) return { kind: 'unknown' }

  const keyword = tokens[0].toUpperCase()

  if (keyword === 'DELAY') {
    if (tokens.length < 3) return { kind: 'unknown' }
    const minutes = parseInt(tokens[1], 10)
    const ref = tokens[2].toUpperCase()
    if (isNaN(minutes) || minutes < MIN_DELAY || minutes > MAX_DELAY) return { kind: 'unknown' }
    if (!REF_PATTERN.test(ref)) return { kind: 'unknown' }
    return { kind: 'delay', ref, minutes }
  }

  const ref = tokens[1].toUpperCase()
  if (!REF_PATTERN.test(ref)) return { kind: 'unknown' }

  switch (keyword) {
    case '1':
      return { kind: 'accept', ref }
    case '2':
      return { kind: 'decline', ref }
    case 'ARRIVED':
      return { kind: 'arrived', ref }
    case 'DONE':
      return { kind: 'done', ref }
    case 'CANCEL':
      return { kind: 'cancel', ref }
    default:
      return { kind: 'unknown' }
  }
}
