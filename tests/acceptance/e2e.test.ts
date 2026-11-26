import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'

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

  it('full trip lifecycle via webhooks only', async () => {
    // 1. Passenger books via USSD (auto-offers to first available driver)
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

    // Wait for fire-and-forget offer to complete
    let booking
    for (let i = 0; i < 100; i++) {
      booking = await prisma.booking.findUnique({ where: { ref } })
      if (booking?.state === 'OFFERED') break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(booking).not.toBeNull()
    expect(booking!.state).toBe('OFFERED')
    expect(booking!.driverId).not.toBeNull()

    const offeredDriver = await prisma.driver.findUnique({ where: { id: booking!.driverId! } })
    expect(offeredDriver).not.toBeNull()
    const offeredDriverPhone = offeredDriver!.phone

    // Confirmation SMS sent to passenger
    const confirmationSms = messenger.sent.find((s) => s.to === '+254700000010')
    expect(confirmationSms).toBeDefined()
    expect(confirmationSms!.message).toContain(ref)

    // Offer SMS sent to the offered driver
    const offerSms1 = messenger.sent.find((s) => s.to === offeredDriverPhone)
    expect(offerSms1).toBeDefined()
    expect(offerSms1!.message).toContain(ref)
    expect(offerSms1!.message).toContain('Reply 1 accept / 2 decline')

    // 2. Offered driver declines via SMS (auto-re-offers to the other driver)
    const smsDecline = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-1', from: offeredDriverPhone, text: `2 ${ref}` },
    })
    expect(smsDecline.statusCode).toBe(200)

    // Wait for auto-re-offer to complete
    let afterDecline
    for (let i = 0; i < 100; i++) {
      afterDecline = await prisma.booking.findUnique({ where: { ref } })
      if (afterDecline!.state === 'OFFERED' && afterDecline!.driverId !== booking!.driverId) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(afterDecline).not.toBeNull()
    expect(afterDecline!.state).toBe('OFFERED')
    expect(afterDecline!.driverId).not.toBeNull()
    expect(afterDecline!.driverId).not.toBe(booking!.driverId)

    const reOfferedDriver = await prisma.driver.findUnique({ where: { id: afterDecline!.driverId! } })
    const acceptingDriverPhone = reOfferedDriver!.phone
    const acceptingDriverName = reOfferedDriver!.name
    const acceptingDriverPlate = reOfferedDriver!.plate

    // Accepting driver should be different from the declining driver
    expect(acceptingDriverPhone).not.toBe(offeredDriverPhone)

    const offerSms2 = messenger.sent.find((s) => s.to === acceptingDriverPhone)
    expect(offerSms2).toBeDefined()
    expect(offerSms2!.message).toContain(ref)

    // 3. Other driver accepts via SMS
    const smsAccept = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-2', from: acceptingDriverPhone, text: `1 ${ref}` },
    })
    expect(smsAccept.statusCode).toBe(200)

    const afterAccept = await prisma.booking.findUnique({ where: { ref } })
    expect(afterAccept!.state).toBe('CONFIRMED')

    // Passenger gets driver confirmed SMS
    const confirmedSms = messenger.sent.find(
      (s) => s.to === '+254700000010' && s.message.includes('confirmed')
    )
    expect(confirmedSms).toBeDefined()
    expect(confirmedSms!.message).toContain(acceptingDriverName)
    expect(confirmedSms!.message).toContain(acceptingDriverPlate)

    const beforeDelay = afterAccept!.pickupAt.getTime()

    // 4. Accepting driver delays by 90 minutes via SMS
    const smsDelay = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-3', from: acceptingDriverPhone, text: `DELAY 90 ${ref}` },
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
      (s) => s.to === acceptingDriverPhone && s.message.includes('delayed 90 min')
    )
    expect(delaySmsToDriver).toBeDefined()

    // 5. Accepting driver arrives via SMS
    const smsArrived = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-4', from: acceptingDriverPhone, text: `ARRIVED ${ref}` },
    })
    expect(smsArrived.statusCode).toBe(200)

    const afterArrived = await prisma.booking.findUnique({ where: { ref } })
    expect(afterArrived!.state).toBe('ARRIVED')

    const arrivedSms = messenger.sent.find(
      (s) => s.to === '+254700000010' && s.message.includes('has arrived')
    )
    expect(arrivedSms).toBeDefined()

    // 6. Accepting driver completes via SMS
    const smsDone = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'e2e-msg-5', from: acceptingDriverPhone, text: `DONE ${ref}` },
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
    expect(passengerSms[1]).toContain(acceptingDriverName) // driver confirmed
    expect(passengerSms[1]).toContain(acceptingDriverPlate)
    expect(passengerSms[2]).toContain('delayed 90 min') // delay notice
    expect(passengerSms[3]).toContain('has arrived') // arrived
    expect(passengerSms[4]).toContain('completed') // completed

    // Assert messages to accepting driver
    const acceptingDriverSms = messenger.sent
      .filter((s) => s.to === acceptingDriverPhone)
      .map((s) => s.message)
    expect(acceptingDriverSms).toHaveLength(2)
    expect(acceptingDriverSms[0]).toContain(ref) // offer
    expect(acceptingDriverSms[0]).toContain('Reply 1 accept / 2 decline')
    expect(acceptingDriverSms[1]).toContain('delayed 90 min') // delay notice
  })
})
