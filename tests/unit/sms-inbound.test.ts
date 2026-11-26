import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'
import { parseSms } from '../../src/modules/sms-inbound/parse.js'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})
let app: FastifyInstance

const DRIVERS = [
  { name: 'Alice Wanjiku', phone: '+254700000001', plate: 'KBA 123A', vehicle: 'Toyota Noah' },
  { name: 'Brian Otieno', phone: '+254700000002', plate: 'KBC 456B', vehicle: 'Toyota Voxy' },
]

const SECRET = process.env.WEBHOOK_SECRET || 'fc0e113be1bd6451921044b0b61a8934'

async function seedDrivers() {
  for (const d of DRIVERS) {
    await prisma.driver.upsert({ where: { phone: d.phone }, update: {}, create: d })
  }
}

async function createBookingForSms() {
  const { createBooking } = await import('../../src/modules/bookings/service.js')
  return createBooking(
    { prisma, messenger: new FakeMessenger() },
    {
      passengerPhone: '+254700000010',
      pickupPoint: 'MIA',
      arrivalRef: 'KQ100',
      pickupAt: '2026-11-24T14:30:00Z',
      destination: 'Westlands',
      partySize: 2,
    }
  )
}

describe('sms-inbound parse', () => {
  it('parses accept keyword', () => {
    expect(parseSms('1 CR1042')).toEqual({ kind: 'accept', ref: 'CR1042' })
  })

  it('parses decline keyword', () => {
    expect(parseSms('2 CR1042')).toEqual({ kind: 'decline', ref: 'CR1042' })
  })

  it('parses ARRIVED keyword', () => {
    expect(parseSms('ARRIVED CR1042')).toEqual({ kind: 'arrived', ref: 'CR1042' })
  })

  it('parses DONE keyword', () => {
    expect(parseSms('DONE CR1042')).toEqual({ kind: 'done', ref: 'CR1042' })
  })

  it('parses CANCEL keyword', () => {
    expect(parseSms('CANCEL CR1042')).toEqual({ kind: 'cancel', ref: 'CR1042' })
  })

  it('parses DELAY keyword', () => {
    expect(parseSms('DELAY 90 CR1042')).toEqual({ kind: 'delay', ref: 'CR1042', minutes: 90 })
  })

  it('is case-insensitive', () => {
    expect(parseSms('1 cr1042')).toEqual({ kind: 'accept', ref: 'CR1042' })
    expect(parseSms('arrived CR1042')).toEqual({ kind: 'arrived', ref: 'CR1042' })
    expect(parseSms('Delay 30 Cr1042')).toEqual({ kind: 'delay', ref: 'CR1042', minutes: 30 })
  })

  it('is whitespace tolerant', () => {
    expect(parseSms('  1   CR1042  ')).toEqual({ kind: 'accept', ref: 'CR1042' })
    expect(parseSms('1\tCR1042')).toEqual({ kind: 'accept', ref: 'CR1042' })
  })

  it('rejects invalid ref', () => {
    expect(parseSms('1 INVALID')).toEqual({ kind: 'unknown' })
    expect(parseSms('1 CR100')).toEqual({ kind: 'unknown' })
    expect(parseSms('1 CR10423')).toEqual({ kind: 'unknown' })
  })

  it('rejects DELAY with out-of-range minutes', () => {
    expect(parseSms('DELAY 3 CR1042')).toEqual({ kind: 'unknown' })
    expect(parseSms('DELAY 721 CR1042')).toEqual({ kind: 'unknown' })
  })

  it('rejects malformed text', () => {
    expect(parseSms('')).toEqual({ kind: 'unknown' })
    expect(parseSms('1')).toEqual({ kind: 'unknown' })
    expect(parseSms('HELLO CR1042')).toEqual({ kind: 'unknown' })
  })
})

describe('sms route', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Message", "TripEvent", "BookingDecline", "Booking", "Driver", "WebhookEvent" RESTART IDENTITY CASCADE`
    )
    await seedDrivers()
    app = buildApp({ prisma, messenger: new FakeMessenger() })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('returns 404 with wrong secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wrong-secret/sms',
      body: { id: 'msg-1', from: '+254700000001', text: '1 CR1042' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 200 empty body on valid SMS', async () => {
    const booking = await createBookingForSms()
    const { offerNextDriver } = await import('../../src/modules/bookings/service.js')
    const offered = await offerNextDriver({ prisma, messenger: new FakeMessenger() }, { bookingId: booking.id })
    const driver = offered.driver!

    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-1', from: driver.phone, text: `1 ${booking.ref}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('')
  })

  it('dedupes duplicate message id', async () => {
    const booking = await createBookingForSms()
    const { offerNextDriver } = await import('../../src/modules/bookings/service.js')
    const offered = await offerNextDriver({ prisma, messenger: new FakeMessenger() }, { bookingId: booking.id })
    const driver = offered.driver!

    const messenger = new FakeMessenger()
    app = buildApp({ prisma, messenger })

    // First delivery
    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-dup', from: driver.phone, text: `1 ${booking.ref}` },
    })
    expect(messenger.sent.length).toBeGreaterThan(0)

    // Second delivery with same id - should be deduped
    const messenger2 = new FakeMessenger()
    app = buildApp({ prisma, messenger: messenger2 })
    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-dup', from: driver.phone, text: `1 ${booking.ref}` },
    })
    expect(messenger2.sent).toHaveLength(0)
  })

  it('ignores SMS from unassigned driver', async () => {
    const booking = await createBookingForSms()
    const { offerNextDriver } = await import('../../src/modules/bookings/service.js')
    const offered = await offerNextDriver({ prisma, messenger: new FakeMessenger() }, { bookingId: booking.id })
    const assignedDriver = offered.driver!
    const otherDriver = DRIVERS.find((d) => d.phone !== assignedDriver.phone)!

    const messenger = new FakeMessenger()
    app = buildApp({ prisma, messenger })

    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-2', from: otherDriver.phone, text: `1 ${booking.ref}` },
    })
    expect(messenger.sent).toHaveLength(0)
  })

  it('ignores SMS for unknown booking ref', async () => {
    const messenger = new FakeMessenger()
    app = buildApp({ prisma, messenger })

    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-3', from: '+254700000001', text: '1 CR9999' },
    })
    expect(res.statusCode).toBe(200)
    expect(messenger.sent).toHaveLength(0)
  })

  it('ignores malformed text from unknown number', async () => {
    const messenger = new FakeMessenger()
    app = buildApp({ prisma, messenger })

    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-4', from: '+254799999999', text: 'HELLO WORLD' },
    })
    expect(messenger.sent).toHaveLength(0)
  })

  it('sends help SMS to known driver for malformed text', async () => {
    const messenger = new FakeMessenger()
    app = buildApp({ prisma, messenger })

    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-5', from: '+254700000001', text: 'GIBBERISH' },
    })
    const helpSms = messenger.sent.find((s) => s.to === '+254700000001')
    expect(helpSms).toBeDefined()
    expect(helpSms.message).toContain('CoastRide')
  })

  it('retries message after dedupe row is deleted on processing failure', async () => {
    const booking = await createBookingForSms()
    const { offerNextDriver } = await import('../../src/modules/bookings/service.js')
    const offered = await offerNextDriver({ prisma, messenger: new FakeMessenger() }, { bookingId: booking.id })
    const driver = offered.driver!

    // First delivery with invalid phone - normalizePhone throws inside handleInboundSms
    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-retry', from: '+12345', text: `1 ${booking.ref}` },
    })

    // Second delivery with same id but valid phone - dedupe row was deleted, so it processes
    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-retry', from: driver.phone, text: `1 ${booking.ref}` },
    })
    const bAfter = await prisma.booking.findUnique({ where: { ref: booking.ref } })
    expect(bAfter?.state).toBe('CONFIRMED')
  })

  it('accepts phoneNumber as sender field instead of from', async () => {
    const booking = await createBookingForSms()
    const { offerNextDriver } = await import('../../src/modules/bookings/service.js')
    const offered = await offerNextDriver({ prisma, messenger: new FakeMessenger() }, { bookingId: booking.id })
    const driver = offered.driver!

    const messenger = new FakeMessenger()
    app = buildApp({ prisma, messenger })

    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { id: 'msg-pn', phoneNumber: driver.phone, text: `1 ${booking.ref}` },
    })
    expect(messenger.sent.length).toBeGreaterThan(0)
  })

  it('processes message without id (no dedupe)', async () => {
    const booking = await createBookingForSms()
    const { offerNextDriver } = await import('../../src/modules/bookings/service.js')
    const offered = await offerNextDriver({ prisma, messenger: new FakeMessenger() }, { bookingId: booking.id })
    const driver = offered.driver!

    const messenger = new FakeMessenger()
    app = buildApp({ prisma, messenger })

    await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/sms`,
      body: { from: driver.phone, text: `1 ${booking.ref}` },
    })
    expect(messenger.sent.length).toBeGreaterThan(0)
  })
})
