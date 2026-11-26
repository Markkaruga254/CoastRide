import { describe, it, expect } from 'vitest'
import { allowRateLimit } from '../../src/lib/rateLimit.js'

describe('allowRateLimit', () => {
  it('allows up to the configured limit within a window', () => {
    expect(allowRateLimit('unit-limit-a', 2, 1_000, 10_000)).toBe(true)
    expect(allowRateLimit('unit-limit-a', 2, 1_000, 10_001)).toBe(true)
    expect(allowRateLimit('unit-limit-a', 2, 1_000, 10_002)).toBe(false)
  })

  it('resets an expired window', () => {
    expect(allowRateLimit('unit-limit-b', 1, 100, 20_000)).toBe(true)
    expect(allowRateLimit('unit-limit-b', 1, 100, 20_050)).toBe(false)
    expect(allowRateLimit('unit-limit-b', 1, 100, 20_101)).toBe(true)
  })

  it('isolates rate-limit keys', () => {
    expect(allowRateLimit('unit-limit-c1', 1, 100, 30_000)).toBe(true)
    expect(allowRateLimit('unit-limit-c2', 1, 100, 30_000)).toBe(true)
  })
})
