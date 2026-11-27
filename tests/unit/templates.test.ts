import { describe, it, expect } from 'vitest'
import {
  formatTime,
  bookingConfirmation,
  driverOffer,
  driverConfirmed,
  delayNotice,
  cancelled,
  arrived,
  completed,
  helpText,
  actionNotAvailable,
} from '../../src/modules/messaging/templates.js'

const TIME_ZONE = 'Africa/Nairobi'

describe('SMS templates', () => {
  it('formatTime converts UTC to Nairobi', () => {
    expect(formatTime('2026-11-24T14:30:00Z', TIME_ZONE)).toBe('17:30')
  })

  it('bookingConfirmation', () => {
    expect(bookingConfirmation('CR1042')).toBe(
      'CoastRide: booked! Ref CR1042. SMS sent.',
    )
  })

  it('driverOffer', () => {
    expect(
      driverOffer('CR1042', 'Alice Wanjiku', 'MIA', '2026-11-24T14:30:00Z', TIME_ZONE),
    ).toBe(
      'CoastRide trip CR1042: Alice Wanjiku offers pickup at MIA 17:30. Reply 1 accept / 2 decline.',
    )
  })

  it('driverConfirmed', () => {
    expect(
      driverConfirmed('CR1042', 'Alice Wanjiku', 'KBA 123A', '+254700000001'),
    ).toBe(
      'CoastRide CR1042 confirmed. Driver: Alice Wanjiku, plate KBA 123A, phone +254700000001.',
    )
  })

  it('delayNotice passenger', () => {
    expect(
      delayNotice('CR1042', '2026-11-24T16:00:00Z', 90, 'passenger', TIME_ZONE),
    ).toBe('CoastRide CR1042: Your pickup delayed 90 min, new time 19:00.')
  })

  it('delayNotice driver', () => {
    expect(
      delayNotice('CR1042', '2026-11-24T16:00:00Z', 90, 'driver', TIME_ZONE),
    ).toBe('CoastRide CR1042: This trip delayed 90 min, new time 19:00.')
  })

  it('cancelled', () => {
    expect(cancelled('CR1042')).toBe('CoastRide trip CR1042 cancelled.')
  })

  it('arrived', () => {
    expect(arrived('CR1042', 'Alice Wanjiku')).toBe(
      'CoastRide CR1042: Alice Wanjiku has arrived.',
    )
  })

  it('completed', () => {
    expect(completed('CR1042')).toBe('CoastRide trip CR1042 completed. Thank you!')
  })

  it('helpText matches parser syntax', () => {
    expect(helpText()).toBe(
      'CoastRide: 1 <ref> accept, 2 <ref> decline, DELAY <min> <ref>, ARRIVED <ref>, DONE <ref>'
    )
  })

  it('actionNotAvailable', () => {
    expect(actionNotAvailable('CR1042')).toBe("CoastRide CR1042: that action isn't available right now.")
  })

  it('every template is under 160 chars', () => {
    const cases: Array<[string, string]> = [
      ['bookingConfirmation', bookingConfirmation('CR1042')],
      [
        'driverOffer',
        driverOffer('CR1042', 'Alice Wanjiku', 'MIA', '2026-11-24T14:30:00Z', TIME_ZONE),
      ],
      [
        'driverConfirmed',
        driverConfirmed('CR1042', 'Alice Wanjiku', 'KBA 123A', '+254700000001'),
      ],
      [
        'delayNotice passenger',
        delayNotice('CR1042', '2026-11-24T16:00:00Z', 90, 'passenger', TIME_ZONE),
      ],
      ['cancelled', cancelled('CR1042')],
      ['arrived', arrived('CR1042', 'Alice Wanjiku')],
      ['completed', completed('CR1042')],
      ['helpText', helpText()],
      ['actionNotAvailable', actionNotAvailable('CR1042')],
    ]
    for (const [name, text] of cases) {
      expect(text.length, `${name} length`).toBeLessThan(160)
    }
  })
})
