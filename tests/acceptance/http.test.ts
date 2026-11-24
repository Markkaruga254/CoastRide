import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'
import {
  createBooking,
  offerNextDriver,
  acceptOffer,
  markArrived,
  completeTrip,
} from '../../src/modules/bookings/service.js'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})
const messenger = new FakeMessenger()
let app: FastifyInstance

const DRIVERS = [
  { name: 'Alice Wanjiku', phone: '+254700000001', plate: 'KBA 123A', vehicle: 'Toyota Noah' },
  { name: 'Brian Otieno', phone: '+254700000002', plate: 'KBC 456B', vehicle: 'Toyota Voxy' },
  { name: 'Catherine Njeri', phone: '+254700000003', plate: 'KBD 789C', vehicle: 'Toyota Hiace' },
  { name: 'David Omondi', phone: '+254700000004', plate: 'KBE 012D', vehicle: 'Toyota Wish' },
]

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Message", "TripEvent", "BookingDecline", "Booking", "Driver", "WebhookEvent" RESTART IDENTITY CASCADE`
  )
  for (const d of DRIVERS) {
    await prisma.driver.create({ data: d })
  }
  app = buildApp({ prisma, messenger })
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('temporary REST API', () => {
  it('happy path: create booking, offer via service, accept via HTTP', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/bookings',
      body: {
        passengerPhone: '+254700000010',
        passengerName: 'John Doe',
        pickupPoint: 'MIA',
        arrivalRef: 'BA123',
        pickupAt: '2026-11-24T14:30:00Z',
        destination: 'Westlands',
        partySize: 2,
      },
    })
    expect(createRes.statusCode).toBe(201)
    const booking = createRes.json()
    expect(booking.state).toBe('REQUESTED')
    expect(booking.ref).toMatch(/^CR\d{4}$/)

    // GET the booking
    const getRes = await app.inject({ method: 'GET', url: `/bookings/${booking.ref}` })
    expect(getRes.statusCode).toBe(200)
    const fetched = getRes.json()
    expect(fetched.state).toBe('REQUESTED')

    // Offer driver via service (no HTTP offer endpoint exists)
    const offered = await offerNextDriver({ prisma, messenger }, { bookingId: booking.id })
    expect(offered.booking.state).toBe('OFFERED')

    // 2 SMS: passenger confirmation + driver offer
    expect(messenger.sent).toHaveLength(2)

    const driver = offered.driver!

    // Accept via HTTP
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/bookings/${booking.ref}/driver-response`,
      body: { driverPhone: driver.phone, action: 'accept' },
    })
    expect(acceptRes.statusCode).toBe(200)
    const accepted = acceptRes.json()
    expect(accepted.state).toBe('CONFIRMED')
  })

  it('validation 400: missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/bookings',
      body: { passengerPhone: 'not-a-phone' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('validation 400: invalid phone format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/bookings',
      body: {
        passengerPhone: '+14155550000',
        pickupPoint: 'MIA',
        pickupAt: '2026-11-24T14:30:00Z',
        destination: 'Westlands',
        partySize: 2,
      },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('404: booking not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/bookings/CR9999',
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('409: non-assigned driver cannot accept', async () => {
    const booking = await createBooking({ prisma, messenger }, {
      passengerPhone: '+254700000010',
      pickupPoint: 'MIA',
      pickupAt: '2026-11-24T14:30:00Z',
      destination: 'Westlands',
      partySize: 2,
    })
    const offered = await offerNextDriver({ prisma, messenger }, { bookingId: booking.id })

    const drivers = await prisma.driver.findMany({ orderBy: { id: 'asc' } })
    const notAssigned = drivers.find((d) => d.id !== offered.booking.driverId)!

    const res = await app.inject({
      method: 'POST',
      url: `/bookings/${booking.ref}/driver-response`,
      body: { driverPhone: notAssigned.phone, action: 'accept' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toMatchObject({ code: 'CONFLICT' })
  })

  it('acceptance 6: COMPLETED then cancel returns 409', async () => {
    const booking = await createBooking({ prisma, messenger }, {
      passengerPhone: '+254700000010',
      pickupPoint: 'MIA',
      pickupAt: '2026-11-24T14:30:00Z',
      destination: 'Westlands',
      partySize: 2,
    })
    const drivers = await prisma.driver.findMany({ orderBy: { id: 'asc' } })
    const driver = drivers[0]

    // Advance to COMPLETED via service
    await offerNextDriver({ prisma, messenger }, { bookingId: booking.id })
    await acceptOffer({ prisma, messenger }, { bookingId: booking.id, driverPhone: driver.phone })
    await markArrived({ prisma, messenger }, { bookingId: booking.id, driverPhone: driver.phone })
    await completeTrip({ prisma, messenger }, { bookingId: booking.id, driverPhone: driver.phone })

    const completed = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(completed?.state).toBe('COMPLETED')

    // Cancel via HTTP should return 409
    const res = await app.inject({
      method: 'POST',
      url: `/bookings/${booking.ref}/cancel`,
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: { code: string; message: string; stack?: string } }
    expect(body.error).toMatchObject({ code: 'CONFLICT' })
    // No stack in response
    expect(body.error.stack).toBeUndefined()
  })

  it('delay via HTTP updates pickup_at', async () => {
    const booking = await createBooking({ prisma, messenger }, {
      passengerPhone: '+254700000010',
      pickupPoint: 'MIA',
      pickupAt: '2026-11-24T14:30:00Z',
      destination: 'Westlands',
      partySize: 2,
    })
    const drivers = await prisma.driver.findMany({ orderBy: { id: 'asc' } })
    const driver = drivers[0]

    await offerNextDriver({ prisma, messenger }, { bookingId: booking.id })
    await acceptOffer({ prisma, messenger }, { bookingId: booking.id, driverPhone: driver.phone })

    const before = await prisma.booking.findUnique({ where: { id: booking.id } })

    const res = await app.inject({
      method: 'POST',
      url: `/bookings/${booking.ref}/delay`,
      body: { minutes: 90 },
    })
    expect(res.statusCode).toBe(200)
    const updated = res.json()
    expect(updated.pickupAt).not.toBe(before?.pickupAt)
  })
})
