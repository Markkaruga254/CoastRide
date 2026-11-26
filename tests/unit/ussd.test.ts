import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'
import { handleUssd } from '../../src/modules/ussd/handleUssd.js'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})
const messenger = new FakeMessenger()

const now = new Date('2024-01-15T10:00:00.000Z')

const deps = {
  prisma,
  messenger,
  now: () => now,
}

describe('handleUssd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messenger.sent.length = 0
  })

  describe('Main menu', () => {
    it('shows main menu on empty text', async () => {
      const res = await handleUssd(
        { phoneNumber: '+254700000001', text: '', sessionId: 'sess-1' },
        deps,
      )
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Welcome to CoastRide')
      expect(res.text).toContain('1. Airport pickup (MIA)')
      expect(res.text).toContain('2. SGR station pickup')
      expect(res.text).toContain('3. Check my booking')
    })

    it('shows main menu on invalid first input', async () => {
      const res = await handleUssd(
        { phoneNumber: '+254700000001', text: '5', sessionId: 'sess-2' },
        deps,
      )
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Welcome to CoastRide')
    })

    it('ends after second invalid input on main menu', async () => {
      const res = await handleUssd(
        { phoneNumber: '+254700000001', text: '5*5', sessionId: 'sess-3' },
        deps,
      )
      expect(res.type).toBe('END')
      expect(res.text).toContain('Sorry, please dial again')
    })

    it('identical input gives identical output on main menu', async () => {
      const res1 = await handleUssd(
        { phoneNumber: '+254700000001', text: '9', sessionId: 'sess-5' },
        deps,
      )
      const res2 = await handleUssd(
        { phoneNumber: '+254700000001', text: '9', sessionId: 'sess-5' },
        deps,
      )
      expect(res1.type).toBe(res2.type)
      expect(res1.text).toBe(res2.text)
      expect(res1.text).toContain('Welcome to CoastRide')
    })

    it('ends on 9*9 at main menu (two invalid segments)', async () => {
      const res = await handleUssd(
        { phoneNumber: '+254700000001', text: '9*9', sessionId: 'sess-6' },
        deps,
      )
      expect(res.type).toBe('END')
      expect(res.text).toContain('Sorry, please dial again')
    })
  })

  describe('Airport pickup (MIA) flow', () => {
    it('prompts for arrival ref after selecting 1', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1', sessionId: 'sess-10' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('MIA')
      expect(res.text).toContain('Arrival ref')
    })

    it('prompts for arrival time after valid ref', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100', sessionId: 'sess-11' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Arrival time')
    })

    it('rejects invalid arrival ref (too short)', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*AB', sessionId: 'sess-12' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Invalid ref')
    })

    it('rejects invalid arrival ref (too long)', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*ABCDEFGHI', sessionId: 'sess-13' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Invalid ref')
    })

    it('ends after invalid arrival ref entered twice', async () => {
      const res = await handleUssd(
        { phoneNumber: '+254700000001', text: '1*AB*AB', sessionId: 'sess-13b' },
        deps,
      )
      expect(res.type).toBe('END')
      expect(res.text).toContain('Sorry, please dial again')
    })

    it('rejects invalid arrival time format', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*2500', sessionId: 'sess-14' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Invalid time')
    })

    it('accepts valid arrival time and prompts for destination', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430', sessionId: 'sess-15' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Destination')
    })

    it('rejects short destination', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*A', sessionId: 'sess-16' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Invalid destination')
    })

    it('accepts valid destination and prompts for party size', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa', sessionId: 'sess-17' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Party size')
    })

    it('rejects invalid party size', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*7', sessionId: 'sess-18' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Invalid size')
    })

    it('shows confirmation screen after valid party size', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*2', sessionId: 'sess-19' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('1. Confirm')
      expect(res.text).toContain('2. Cancel')
      expect(res.text).toContain('Mombasa')
      expect(res.text).toContain('2')
    })

    it('creates booking on confirm', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*2*1', sessionId: 'sess-20' }, deps)
      expect(res.type).toBe('END')
      expect(res.text).toContain('Booked!')
      expect(res.text).toContain('Ref CR')
      expect(res.text).toContain('SMS')
    })

    it('cancels on confirm=2', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*2*2', sessionId: 'sess-21' }, deps)
      expect(res.type).toBe('END')
      expect(res.text).toContain('cancelled')
    })

    it('handles time rollover to tomorrow', async () => {
      const pastNow = new Date('2024-01-15T15:00:00.000Z')
      const res = await handleUssd(
        { phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*2*1', sessionId: 'sess-22' },
        { ...deps, now: () => pastNow },
      )
      expect(res.type).toBe('END')
      expect(res.text).toContain('Booked!')
    })
  })

  describe('SGR station pickup flow', () => {
    it('prompts for arrival ref after selecting 2', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '2', sessionId: 'sess-30' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('SGR')
    })

    it('completes SGR booking', async () => {
      const res = await handleUssd(
        { phoneNumber: '+254700000001', text: '2*TRN200*1000*Nairobi*3*1', sessionId: 'sess-31' },
        deps,
      )
      expect(res.type).toBe('END')
      expect(res.text).toContain('Booked!')
    })
  })

  describe('Check my booking', () => {
    it('prompts for ref on option 3', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '3', sessionId: 'sess-40' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Check my booking')
      expect(res.text).toContain('Enter booking ref')
    })

    it('rejects invalid ref format', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '3*INVALID', sessionId: 'sess-41' }, deps)
      expect(res.type).toBe('CON')
      expect(res.text).toContain('Invalid ref')
    })

    it('returns not found for unknown ref', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '3*CR9999', sessionId: 'sess-42' }, deps)
      expect(res.type).toBe('END')
      expect(res.text).toContain('not found')
    })

    it('returns booking state and driver info when found', async () => {
      // First create a booking
      await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*2*1', sessionId: 'sess-43' }, deps)

      // Get the booking ref from the last sent message
      const lastMsg = messenger.sent[messenger.sent.length - 1]
      const refMatch = lastMsg.message.match(/CR\d{4}/)
      expect(refMatch).toBeTruthy()
      const ref = refMatch![0]

      // Now check the booking
      const res = await handleUssd({ phoneNumber: '+254700000001', text: `3*${ref}`, sessionId: 'sess-44' }, deps)
      expect(res.type).toBe('END')
      expect(res.text).toContain(ref)
      expect(res.text).toContain('Looking for driver')
    })
  })

  describe('Idempotency', () => {

    it('creates only one booking for concurrent final confirmations in one USSD session', async () => {
      const input = {
        phoneNumber: '+254700000001',
        text: '1*KQ100*1430*Mombasa*2*1',
        sessionId: 'sess-concurrent-confirm',
      }

      const [first, second] = await Promise.all([
        handleUssd(input, deps),
        handleUssd(input, deps),
      ])

      expect(first.type).toBe('END')
      expect(second.text).toBe(first.text)
      const bookings = await prisma.booking.findMany({
        where: { ussdSessionId: input.sessionId },
      })
      expect(bookings).toHaveLength(1)
    })


    it('returns after persisting the booking when SMS delivery is still pending', async () => {
      const slowMessenger = {
        sendSms: async () => new Promise<{ providerId?: string }>(() => undefined),
      }
      const input = {
        phoneNumber: '+254700000001',
        text: '1*KQ100*1430*Mombasa*2*1',
        sessionId: 'sess-async-sms',
      }

      const response = await handleUssd(input, {
        ...deps,
        messenger: slowMessenger,
        awaitNotifications: false,
      })

      expect(response.type).toBe('END')
      expect(response.text).toContain('SMS confirmation will follow')
      const booking = await prisma.booking.findUnique({
        where: { ussdSessionId: input.sessionId },
      })
      expect(booking).not.toBeNull()
    })

    it('returns existing booking on retry with same sessionId', async () => {
      const res1 = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*2*1', sessionId: 'sess-50' }, deps)
      expect(res1.type).toBe('END')
      expect(res1.text).toContain('Booked!')

      const res2 = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*2*1', sessionId: 'sess-50' }, deps)
      expect(res2.type).toBe('END')
      expect(res2.text).toBe(res1.text)
    })
  })

  describe('Input sanitization and edge cases', () => {
    it('handles asterisk in destination', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1*KQ100*1430*Mombasa*Center*2*1', sessionId: 'sess-60' }, deps)
      // 'Center' is an invalid party size, then '2' is valid, then '1' confirms => booking created
      expect(res.type).toBe('END')
      expect(res.text).toContain('Booked!')
    })

    it('handles newlines in input', async () => {
      const res = await handleUssd({ phoneNumber: '+254700000001', text: '1\n*KQ100', sessionId: 'sess-61' }, deps)
      // '1\n' is not '1' (invalid on MAIN), then 'KQ100' is also invalid on MAIN => END
      expect(res.type).toBe('END')
      expect(res.text).toContain('Sorry, please dial again')
    })

    it('handles very long input', async () => {
      const longText = '1*KQ100*1430*' + 'A'.repeat(100) + '*2*1'
      const res = await handleUssd({ phoneNumber: '+254700000001', text: longText, sessionId: 'sess-62' }, deps)
      expect(res.type).toBe('END')
    })

    it('truncates destination to 40 chars', async () => {
      const longDest = 'A'.repeat(50)
      const res = await handleUssd(
        { phoneNumber: '+254700000001', text: `1*KQ100*1430*${longDest}*2*1`, sessionId: 'sess-63' },
        deps,
      )
      expect(res.type).toBe('END')
      expect(res.text).toContain('Booked!')
    })
  })
})