import { describe, it, expect, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { execSync } from 'node:child_process'

const prisma = new PrismaClient()

describe('demo:reset script', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Message", "TripEvent", "BookingDecline", "WebhookEvent", "Booking" RESTART IDENTITY CASCADE`,
    )
  })

  it('refuses to run without --yes', () => {
    let output = ''
    try {
      execSync('npm run demo:reset', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e: unknown) {
      const err = e as { stdout: string; stderr: string }
      output = err.stdout + err.stderr
    }

    expect(output).toContain('this operation is destructive')
    expect(output).toContain('Re-run with --yes to confirm')
  })

  it('deletes bookings and messages but keeps drivers', async () => {
    const initialDrivers = await prisma.driver.count()
    const uniquePhone = `+254700${Date.now().toString().slice(-6)}`
    const driver = await prisma.driver.create({
      data: {
        name: 'Test Driver',
        phone: uniquePhone,
        plate: 'KCA 123A',
        vehicle: 'Toyota',
        active: true,
      },
    })

    const booking = await prisma.booking.create({
      data: {
        ref: 'CR1001',
        passengerPhone: '+254711111111',
        pickupPoint: 'MIA',
        pickupAt: new Date(),
        destination: 'Westlands',
        partySize: 2,
        state: 'REQUESTED',
      },
    })

    await prisma.message.create({
      data: {
        bookingId: booking.id,
        direction: 'OUTBOUND',
        channel: 'sms',
        phone: '+254711111111',
        body: 'Test message',
        status: 'queued',
      },
    })

    await prisma.tripEvent.create({
      data: {
        bookingId: booking.id,
        type: 'BOOKING_CREATED',
        payload: {},
      },
    })

    await prisma.bookingDecline.create({
      data: {
        bookingId: booking.id,
        driverId: driver.id,
        reason: 'declined',
      },
    })

    await prisma.webhookEvent.create({
      data: {
        id: 'webhook-1',
      },
    })

    const result = execSync('npm run demo:reset -- --yes', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
      stdio: 'pipe',
    })

    expect(result).toContain('Rows deleted:')
    expect(result).toContain('Message: 1')
    expect(result).toContain('TripEvent: 1')
    expect(result).toContain('BookingDecline: 1')
    expect(result).toContain('WebhookEvent: 1')
    expect(result).toContain('Booking: 1')

    const remainingBookings = await prisma.booking.count()
    const remainingMessages = await prisma.message.count()
    const remainingTripEvents = await prisma.tripEvent.count()
    const remainingBookingDeclines = await prisma.bookingDecline.count()
    const remainingWebhookEvents = await prisma.webhookEvent.count()
    const remainingDrivers = await prisma.driver.count()

    expect(remainingBookings).toBe(0)
    expect(remainingMessages).toBe(0)
    expect(remainingTripEvents).toBe(0)
    expect(remainingBookingDeclines).toBe(0)
    expect(remainingWebhookEvents).toBe(0)
    expect(remainingDrivers).toBe(initialDrivers + 1)
  })

  it('refuses in production without ALLOW_DEMO_RESET', () => {
    let output = ''
    try {
      execSync('npm run demo:reset -- --yes', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'production' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e: unknown) {
      const err = e as { stdout: string; stderr: string }
      output = err.stdout + err.stderr
    }

    expect(output).toContain('demo reset is not allowed in production')
    expect(output).toContain('ALLOW_DEMO_RESET=true to override')
  })
})