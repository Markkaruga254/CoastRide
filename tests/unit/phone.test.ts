import { describe, it, expect } from 'vitest'
import { normalizePhone } from '../../src/lib/phone.js'

describe('phone normalization', () => {
  it.each([
    ['+254700000001', '+254700000001'],
    ['254700000001', '+254700000001'],
    ['0700000001', '+254700000001'],
    ['700000001', '+254700000001'],
    ['+254 700 000 001', '+254700000001'],
    ['0700 000 001', '+254700000001'],
    ['0712345678', '+254712345678'],
    ['712345678', '+254712345678'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected)
  })

  it('throws on unrecognized formats', () => {
    expect(() => normalizePhone('0700')).toThrow()
    expect(() => normalizePhone('+14155550000')).toThrow()
    expect(() => normalizePhone('not-a-phone')).toThrow()
  })
})
