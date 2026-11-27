import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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
    const noDriverNotice = await prisma.message.findFirst({
      where: { bookingId: booking.id, phone: BOOKING_INPUT.passengerPhone },
      orderBy: { createdAt: 'desc' },
    })
    expect(noDriverNotice?.body).toContain('no driver is available')
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



  it('rejects a driver accepting an offer after its three-minute deadline', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }
    await seedDrivers()

    const booking = await createBooking(deps, BOOKING_INPUT)
    const offer = await offerNextDriver(deps, { bookingId: booking.id })
    await prisma.booking.update({
      where: { id: booking.id },
      data: { updatedAt: new Date(Date.now() - 4 * 60_000) },
    })

    await expect(
      acceptOffer(deps, { bookingId: booking.id, driverPhone: offer.driver!.phone }),
    ).rejects.toBeInstanceOf(ConflictError)
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

describe('configurable offer timeout', () => {
  let shortTimeoutAcceptOffer: typeof acceptOffer
  let shortTimeoutExpirePendingOffers: typeof expirePendingOffers
  let shortTimeoutOfferNextDriver: typeof offerNextDriver
  let shortTimeoutCreateBooking: typeof createBooking

  beforeAll(async () => {
    // Set short timeout before importing the module
    process.env.OFFER_TIMEOUT_SECONDS = '10'
    // Clear env cache to force re-parse with new env
    const { resetEnvForTesting } = await import('../../src/config/env.js')
    resetEnvForTesting()
    // Re-import the service module to pick up new env
    const mod = await import('../../src/modules/bookings/service.js')
    shortTimeoutAcceptOffer = mod.acceptOffer
    shortTimeoutExpirePendingOffers = mod.expirePendingOffers
    shortTimeoutOfferNextDriver = mod.offerNextDriver
    shortTimeoutCreateBooking = mod.createBooking
  })

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Message", "TripEvent", "BookingDecline", "Booking", "Driver", "WebhookEvent" RESTART IDENTITY CASCADE`
    )
    // Re-seed drivers
    for (const d of DRIVERS) {
      await prisma.driver.upsert({ where: { phone: d.phone }, update: {}, create: d })
    }
  })

  afterAll(async () => {
    // Restore default for other tests
    process.env.OFFER_TIMEOUT_SECONDS = '180'
    const { resetEnvForTesting } = await import('../../src/config/env.js')
    resetEnvForTesting()
  })

  it('rejects acceptOffer after short timeout', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }

    // Seed drivers right before createBooking (like trip lifecycle tests do)
    for (const d of DRIVERS) {
      await prisma.driver.upsert({ where: { phone: d.phone }, update: {}, create: d })
    }
    const driverCountBeforeCreate = await prisma.driver.count()
    console.log('[DEBUG] Driver count before createBooking:', driverCountBeforeCreate)
    
    // Use original createBooking to avoid any re-import issues
    const { createBooking: originalCreateBooking } = await import('../../src/modules/bookings/service.js')
    const booking = await originalCreateBooking(deps, BOOKING_INPUT)
    
    // Debug: check drivers after createBooking
    const driverCountAfterCreate = await prisma.driver.count()
    const activeDriversAfterCreate = await prisma.driver.findMany({ where: { active: true } })
    console.log('[DEBUG] Driver count after createBooking:', driverCountAfterCreate, 'Active:', activeDriversAfterCreate.map(d => d.id))
    
    // Debug: check what drivers are available for offerNextDriver
    const bookingCount = await prisma.booking.count()
    console.log('[DEBUG] Booking count:', bookingCount)
    const allBookings = await prisma.booking.findMany()
    console.log('[DEBUG] All bookings:', allBookings.map(b => ({ id: b.id, state: b.state, driverId: b.driverId })))
    
    // Check drivers with their bookings
    const driversWithBookings = await prisma.driver.findMany({
      include: { Booking: true },
    })
    console.log('[DEBUG] Drivers with bookings:', driversWithBookings.map(d => ({ id: d.id, bookings: d.Booking.length })))
    
    // Test various queries
    const allActiveDrivers = await prisma.driver.findMany({ where: { active: true } })
    console.log('[DEBUG] All active drivers:', allActiveDrivers.map(d => d.id))
    
    const driversWithSomeBooking = await prisma.driver.findMany({
      where: {
        active: true,
        Booking: {
          some: { state: { in: ['OFFERED', 'CONFIRMED', 'ARRIVED'] } },
        },
      },
    })
    console.log('[DEBUG] Drivers WITH some booking in excluded states:', driversWithSomeBooking.map(d => d.id))
    
    const driversWithNoneBooking = await prisma.driver.findMany({
      where: {
        active: true,
        Booking: {
          none: { state: { in: ['OFFERED', 'CONFIRMED', 'ARRIVED'] } },
        },
      },
    })
    console.log('[DEBUG] Drivers WITH NONE booking in excluded states:', driversWithNoneBooking.map(d => d.id))
    
    const availableDrivers = await prisma.driver.findMany({
      where: {
        active: true,
        Booking: {
          none: { state: { in: ['OFFERED', 'CONFIRMED', 'ARRIVED'] } },
        },
      },
    })
    console.log('[DEBUG] Available drivers for offer:', availableDrivers.map(d => d.id))
    
    const offer = await shortTimeoutOfferNextDriver(deps, { bookingId: booking.id })
    console.log('[DEBUG] Offer result:', { bookingId: offer.booking.id, state: offer.booking.state, driver: offer.driver?.id })
    // Manually set updatedAt to 15 seconds ago (past the 10s timeout)
    await prisma.booking.update({
      where: { id: booking.id },
      data: { updatedAt: new Date(Date.now() - 15_000) },
    })

    await expect(
      shortTimeoutAcceptOffer(deps, { bookingId: booking.id, driverPhone: offer.driver!.phone }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('expires offer with expirePendingOffers after short timeout', async () => {
    const messenger = new FakeMessenger()
    const deps = { prisma, messenger }

    const booking = await shortTimeoutCreateBooking(deps, BOOKING_INPUT)
    const firstOffer = await shortTimeoutOfferNextDriver(deps, { bookingId: booking.id })
    const firstDriver = firstOffer.driver!

    // Call expirePendingOffers with a time 15 seconds in the future (past the 10s timeout)
    const expired = await shortTimeoutExpirePendingOffers(deps, new Date(Date.now() + 15_000))
    expect(expired).toBe(1)

    const updated = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(updated?.state).toBe('OFFERED')
    expect(updated?.driverId).not.toBe(firstDriver.id)
    const timeout = await prisma.bookingDecline.findUnique({
      where: { bookingId_driverId: { bookingId: booking.id, driverId: firstDriver.id } },
    })
    expect(timeout?.reason).toBe('timeout')
  })
})
