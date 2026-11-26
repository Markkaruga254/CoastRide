import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'
import { offerNextDriver } from '../../src/modules/bookings/service.js'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})
const messenger = new FakeMessenger()
let app: FastifyInstance

const SECRET = process.env.WEBHOOK_SECRET || 'fc0e113be1bd6451921044b0b61a8934'

const DRIVERS = [
  { name: 'Alice Wanjiku', phone: '+254700000001', plate: 'KBA 123A', vehicle: 'Toyota Noah' },
  { name: 'Brian Otieno', phone: '+254700000002', plate: 'KBC 456B', vehicle: 'Toyota Voxy' },
]

async function seedDrivers() {
  for (const d of DRIVERS) {
    await prisma.driver.upsert({ where: { phone: d.phone }, update: {}, create: d })
  }
}

describe('end-to-end scenario', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Message", "TripEvent", "BookingDecline", "Booking", "Driver", "WebhookEvent" RESTART IDENTITY CASCADE`
    )
    await seedDrivers()
    messenger.sent.length = 0
    app = buildApp({ prisma, messenger })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('full trip lifecycle via USSD booking and SMS keywords', async () => {
    // 1. Passenger books via USSD
    const ussdRes = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/ussd`,
      body: {
        sessionId: 'e2e-session-1',
        phoneNumber: '+254700000010',
        text: '1*KQ100*1430*Westlands*2*1',
      },
    })
    expect(ussdRes.statusCode).toBe(200)
    expect(ussdRes.body).toContain('Booked!')

    const refMatch = ussdRes.body.match(/CR\d{4}/)
    expect(refMatch).toBeTruthy()
    const ref = refMatch![0]

    const booking = await prisma.booking.findUnique({ where: { ref } })
    expect(booking).not.toBeNull()
    expect(booking!.state).toBe('REQUESTED')

    // Confirmation SMS sent to passenger
    const confirmationSms = messenger.sent.find((s) => s.to === '+254700000010')
    expect(confirmationSms).toBeDefined()
    expect(confirmationSms!.message).toContain(ref)

    // 2. Offer to driver 1 (Alice)
    const offered1 = await offerNextDriver({ prisma, messenger }, { bookingId: booking!.id })
    expect(offered1.booking.state).toBe('OFFERED')
    expect(offered1.driver?.phone).toBe(DRIVERS[0].phone)

    const offerSms1 = messenger.sent.find((s) => s.to === DRIVERS[0].phone)
    expect(offerSms1).toBeDefined()
    expect(offerSms1!.message).toContain(ref)

    // 3. Driver 1 declines via SMS
    const smsDecline = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-1', from: DRIVERS[0].phone, text: `2 ${ref}` },
    })
    expect(smsDecline.statusCode).toBe(200)

    const afterDecline = await prisma.booking.findUnique({ where: { ref } })
    expect(afterDecline!.state).toBe('REQUESTED')
    expect(afterDecline!.driverId).toBeNull()

    // 4. Offer to driver 2 (Brian) - skips Alice who declined
    const offered2 = await offerNextDriver({ prisma, messenger }, { bookingId: booking!.id })
    expect(offered2.booking.state).toBe('OFFERED')
    expect(offered2.driver?.phone).toBe(DRIVERS[1].phone)

    const offerSms2 = messenger.sent.find((s) => s.to === DRIVERS[1].phone)
    expect(offerSms2).toBeDefined()
    expect(offerSms2!.message).toContain(ref)

    // 5. Driver 2 accepts via SMS
    const smsAccept = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-2', from: DRIVERS[1].phone, text: `1 ${ref}` },
    })
    expect(smsAccept.statusCode).toBe(200)

    const afterAccept = await prisma.booking.findUnique({ where: { ref } })
    expect(afterAccept!.state).toBe('CONFIRMED')

    // Passenger gets driver confirmed SMS
    const confirmedSms = messenger.sent.find(
      (s) => s.to === '+254700000010' && s.message.includes('confirmed')
    )
    expect(confirmedSms).toBeDefined()
    expect(confirmedSms!.message).toContain(DRIVERS[1].name)
    expect(confirmedSms!.message).toContain(DRIVERS[1].plate)

    const beforeDelay = afterAccept!.pickupAt.getTime()

    // 6. Driver 2 delays by 90 minutes via SMS
    const smsDelay = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-3', from: DRIVERS[1].phone, text: `DELAY 90 ${ref}` },
    })
    expect(smsDelay.statusCode).toBe(200)

    const afterDelay = await prisma.booking.findUnique({ where: { ref } })
    expect(afterDelay!.state).toBe('CONFIRMED')
    expect(afterDelay!.pickupAt.getTime()).toBe(beforeDelay + 90 * 60000)

    // Delay notices sent to passenger and driver
    const delaySmsToPassenger = messenger.sent.find(
      (s) => s.to === '+254700000010' && s.message.includes('delayed 90 min')
    )
    expect(delaySmsToPassenger).toBeDefined()

    const delaySmsToDriver = messenger.sent.find(
      (s) => s.to === DRIVERS[1].phone && s.message.includes('delayed 90 min')
    )
    expect(delaySmsToDriver).toBeDefined()

    // 7. Driver 2 arrives via SMS
    const smsArrived = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-4', from: DRIVERS[1].phone, text: `ARRIVED ${ref}` },
    })
    expect(smsArrived.statusCode).toBe(200)

    const afterArrived = await prisma.booking.findUnique({ where: { ref } })
    expect(afterArrived!.state).toBe('ARRIVED')

    const arrivedSms = messenger.sent.find(
      (s) => s.to === '+254700000010' && s.message.includes('has arrived')
    )
    expect(arrivedSms).toBeDefined()

    // 8. Driver 2 completes via SMS
    const smsDone = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-5', from: DRIVERS[1].phone, text: `DONE ${ref}` },
    })
    expect(smsDone.statusCode).toBe(200)

    const afterDone = await prisma.booking.findUnique({ where: { ref } })
    expect(afterDone!.state).toBe('COMPLETED')

    const completedSms = messenger.sent.find(
      (s) => s.to === '+254700000010' && s.message.includes('completed')
    )
    expect(completedSms).toBeDefined()

    // Assert exact message sequence to passenger
    const passengerSms = messenger.sent
      .filter((s) => s.to === '+254700000010')
      .map((s) => s.message)
    expect(passengerSms).toHaveLength(5)
    expect(passengerSms[0]).toContain(ref) // booking confirmation
    expect(passengerSms[1]).toContain(DRIVERS[1].name) // driver confirmed
    expect(passengerSms[1]).toContain(DRIVERS[1].plate)
    expect(passengerSms[2]).toContain('delayed 90 min') // delay notice
    expect(passengerSms[3]).toContain('has arrived') // arrived
    expect(passengerSms[4]).toContain('completed') // completed

    // Assert messages to driver 2
    const driver2Sms = messenger.sent
      .filter((s) => s.to === DRIVERS[1].phone)
      .map((s) => s.message)
    expect(driver2Sms).toHaveLength(2)
    expect(driver2Sms[0]).toContain(ref) // offer
    expect(driver2Sms[0]).toContain('Reply 1 accept / 2 decline')
    expect(driver2Sms[1]).toContain('delayed 90 min') // delay notice
  })
})
