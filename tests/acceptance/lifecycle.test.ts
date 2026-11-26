import { describe, it, expect } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'
import {
  createBooking,
  offerNextDriver,
  acceptOffer,
  declineOffer,
  applyDelay,
  dispatchPendingMessages,
  expirePendingOffers,
  ConflictError,
} from '../../src/modules/bookings/service.js'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})

const DRIVERS = [
  { name: 'Alice Wanjiku', phone: '+254700000001', plate: 'KBA 123A', vehicle: 'Toyota Noah' },
  { name: 'Brian Otieno', phone: '+254700000002', plate: 'KBC 456B', vehicle: 'Toyota Voxy' },
  { name: 'Catherine Njeri', phone: '+254700000003', plate: 'KBD 789C', vehicle: 'Toyota Hiace' },
  { name: 'David Omondi', phone: '+254700000004', plate: 'KBE 012D', vehicle: 'Toyota Wish' },
]

async function seedDrivers() {
  for (const d of DRIVERS) {
    await prisma.driver.upsert({ where: { phone: d.phone }, update: {}, create: d })
  }
  return prisma.driver.findMany({ orderBy: { id: 'asc' } })
}

const BOOKING_INPUT = {
  passengerPhone: '+254700000010',
  passengerName: 'John Doe',
  pickupPoint: 'MIA',
  arrivalRef: 'BA123',
  pickupAt: '2026-11-24T14:30:00Z',
  destination: 'Westlands',
  partySize: 2,
}

describe('trip lifecycle acceptance (1-5, 7)', () => {
  it('acceptance 1: booking yields REQUESTED then OFFERED to driver 1, 2 SMS', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    expect(booking.state).toBe('REQUESTED')
    expect(messenger.sent).toHaveLength(1)
    expect(messenger.sent[0].to).toBe('+254700000010')

    const offered = await offerNextDriver(deps, { bookingId: booking.id })
    expect(offered.booking.state).toBe('OFFERED')
    expect(offered.driver).not.toBeNull()
    expect(messenger.sent).toHaveLength(2)
    expect(messenger.sent[1].to).toBe(offered.driver!.phone)
  })

  it('acceptance 2: offered driver accepts -> CONFIRMED, passenger gets name plate phone', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    const offered = await offerNextDriver(deps, { bookingId: booking.id })
    const driver = offered.driver!

    const updated = await acceptOffer(deps, {
      bookingId: booking.id,
      driverPhone: driver.phone,
    })
    expect(updated.state).toBe('CONFIRMED')

    const passengerSms = messenger.sent.filter((s) => s.to === BOOKING_INPUT.passengerPhone)
    expect(passengerSms.some((m) => m.message.includes(driver.name))).toBe(true)
    expect(passengerSms.some((m) => m.message.includes(driver.plate))).toBe(true)
    expect(passengerSms.some((m) => m.message.includes(driver.phone))).toBe(true)
  })

  it('acceptance 3: first driver declines -> REQUESTED, next driver offered, first never re-offered', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    const firstOffer = await offerNextDriver(deps, { bookingId: booking.id })
    const firstDriver = firstOffer.driver!

    await declineOffer(deps, { bookingId: booking.id, driverPhone: firstDriver.phone })
    const back = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(back?.state).toBe('REQUESTED')
    expect(back?.driverId).toBeNull()

    const declineCount = await prisma.bookingDecline.count({
      where: { bookingId: booking.id, driverId: firstDriver.id },
    })
    expect(declineCount).toBe(1)

    const secondOffer = await offerNextDriver(deps, { bookingId: booking.id })
    expect(secondOffer.booking.state).toBe('OFFERED')
    expect(secondOffer.driver?.id).not.toBe(firstDriver.id)

    await declineOffer(deps, {
      bookingId: booking.id,
      driverPhone: secondOffer.driver!.phone,
    })
    const thirdOffer = await offerNextDriver(deps, { bookingId: booking.id })
    expect(thirdOffer.driver?.id).not.toBe(firstDriver.id)
    expect(thirdOffer.driver?.id).not.toBe(secondOffer.driver?.id)
  })

  it('acceptance 4: all drivers decline -> NO_DRIVER', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    let offer = await offerNextDriver(deps, { bookingId: booking.id })

    for (let i = 0; i < DRIVERS.length && offer.driver; i++) {
      await declineOffer(deps, {
        bookingId: booking.id,
        driverPhone: offer.driver.phone,
      })
      offer = await offerNextDriver(deps, { bookingId: booking.id })
    }

    const final = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(final?.state).toBe('NO_DRIVER')
    expect(final?.driverId).toBeNull()
  })

  it('acceptance 5: delay 90 min in CONFIRMED keeps state, updates pickup_at, messages both', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    const offered = await offerNextDriver(deps, { bookingId: booking.id })
    await acceptOffer(deps, {
      bookingId: booking.id,
      driverPhone: offered.driver!.phone,
    })

    const before = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(before).not.toBeNull()
    expect(before!.state).toBe('CONFIRMED')

    const result = await applyDelay(deps, { bookingId: booking.id, minutes: 90 })
    expect(result.booking.state).toBe('CONFIRMED')
    expect(result.booking.pickupAt.getTime()).toBe(before!.pickupAt.getTime() + 90 * 60000)

    const toPassenger = messenger.sent.filter((s) => s.to === BOOKING_INPUT.passengerPhone)
    const toDriver = messenger.sent.filter((s) => s.to === offered.driver!.phone)
    expect(toPassenger.length).toBeGreaterThanOrEqual(1)
    expect(toDriver.length).toBeGreaterThanOrEqual(1)
  })

  it('acceptance 7: non-assigned driver cannot accept -> conflict', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    const offered = await offerNextDriver(deps, { bookingId: booking.id })
    const assigned = offered.driver!
    const other = DRIVERS.find((d) => d.phone !== assigned.phone)!

    await expect(
      acceptOffer(deps, { bookingId: booking.id, driverPhone: other.phone }),
    ).rejects.toBeInstanceOf(ConflictError)

    const back = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(back?.state).toBe('OFFERED')
  })


  it('serializes concurrent offers so a driver cannot be assigned to two active trips', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const [bookingA, bookingB] = await Promise.all([
      createBooking(deps, BOOKING_INPUT),
      createBooking(deps, { ...BOOKING_INPUT, passengerPhone: '+254700000011' }),
    ])

    const [offerA, offerB] = await Promise.all([
      offerNextDriver(deps, { bookingId: bookingA.id }),
      offerNextDriver(deps, { bookingId: bookingB.id }),
    ])

    expect(offerA.driver).not.toBeNull()
    expect(offerB.driver).not.toBeNull()
    expect(offerA.driver!.id).not.toBe(offerB.driver!.id)
  })

  it('makes concurrent offer attempts for one booking idempotent', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    const [first, second] = await Promise.all([
      offerNextDriver(deps, { bookingId: booking.id }),
      offerNextDriver(deps, { bookingId: booking.id }),
    ])

    expect(first.driver?.id).toBe(second.driver?.id)
    const persisted = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(persisted?.state).toBe('OFFERED')
    expect(persisted?.driverId).toBe(first.driver?.id)
    const offerMessages = messenger.sent.filter(
      (message) => message.to === first.driver!.phone,
    )
    expect(offerMessages).toHaveLength(1)
  })


  it('expires an unanswered offer and tries the next driver', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    const firstOffer = await offerNextDriver(deps, { bookingId: booking.id })
    const firstDriver = firstOffer.driver!

    const expired = await expirePendingOffers(deps, new Date(Date.now() + 4 * 60_000))
    expect(expired).toBe(1)

    const updated = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(updated?.state).toBe('OFFERED')
    expect(updated?.driverId).not.toBe(firstDriver.id)
    const timeout = await prisma.bookingDecline.findUnique({
      where: { bookingId_driverId: { bookingId: booking.id, driverId: firstDriver.id } },
    })
    expect(timeout?.reason).toBe('timeout')
    const timeoutEvent = await prisma.tripEvent.findFirst({
      where: { bookingId: booking.id, type: 'OFFER_TIMEOUT' },
    })
    expect(timeoutEvent).not.toBeNull()
  })

  it('retries failed outbox messages with backoff metadata', async () => {
    const failingMessenger = {
      sendSms: async () => {
        throw new Error('temporary SMS outage')
      },
    }
    await createBooking({ prisma, messenger: failingMessenger }, BOOKING_INPUT)

    const failed = await prisma.message.findFirst({ orderBy: { createdAt: 'desc' } })
    expect(failed?.status).toBe('failed')
    expect(failed?.attempts).toBe(1)
    expect(failed?.nextAttemptAt).not.toBeNull()

    const retryMessenger = new FakeMessenger()
    const processed = await dispatchPendingMessages(
      { prisma, messenger: retryMessenger },
      { now: new Date(Date.now() + 60 * 60_000) },
    )
    expect(processed).toBe(1)

    const retried = await prisma.message.findUnique({ where: { id: failed!.id } })
    expect(retried?.status).toBe('sent')
    expect(retried?.attempts).toBe(2)
    expect(retried?.nextAttemptAt).toBeNull()
    expect(retryMessenger.sent).toHaveLength(1)
  })

  it('messenger throws: booking still succeeds, message row marked failed', async () => {
    const throwingMessenger = {
      sendSms: async () => {
        throw new Error('SMS provider down')
      },
    }
    const deps = { prisma, messenger: throwingMessenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    expect(booking.state).toBe('REQUESTED')

    const offered = await offerNextDriver(deps, { bookingId: booking.id })
    expect(offered.booking.state).toBe('OFFERED')

    const message = await prisma.message.findFirst({
      where: { bookingId: booking.id },
      orderBy: { createdAt: 'desc' },
    })
    expect(message).not.toBeNull()
    expect(message!.status).toBe('failed')
  })
})
