import { PrismaClient } from '@prisma/client'
import pino from 'pino'
import { applyEvent, IllegalTransitionError } from '../trips/stateMachine.js'
import { generateRef } from './ref.js'
import { normalizePhone } from '../../lib/phone.js'
import { MessagingPort } from '../messaging/port.js'
import {
  bookingConfirmation,
  driverConfirmed,
  driverOffer,
  delayNotice,
  cancelled,
  arrived,
  completed,
  noDriverAvailable,
} from '../messaging/templates.js'

export interface TripServiceDeps {
  prisma: PrismaClient
  messenger: MessagingPort
}

export interface QueuedMessage {
  id: string
  to: string
  message: string
  bookingId?: string
}

export class ConflictError extends Error {
  public readonly code = 'CONFLICT'
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: string }).code === 'P2002'
  )
}

const TIME_ZONE = 'Africa/Nairobi'
const log = pino({ level: 'error' })

const MAX_MESSAGE_ATTEMPTS = 5
const MESSAGE_LEASE_MS = 2 * 60_000
const OFFER_TIMEOUT_MS = 3 * 60_000

type StoredMessage = NonNullable<Awaited<ReturnType<PrismaClient['message']['findUnique']>>>

async function deliverMessage(
  deps: TripServiceDeps,
  message: StoredMessage,
  now = new Date(),
): Promise<boolean> {
  const claimed = await deps.prisma.message.updateMany({
    where: {
      id: message.id,
      status: message.status,
      attempts: message.attempts,
    },
    data: {
      status: 'sending',
      lockedAt: now,
      attempts: { increment: 1 },
    },
  })
  if (claimed.count === 0) return false

  const attempt = message.attempts + 1
  try {
    const { providerId } = await deps.messenger.sendSms({
      to: message.phone,
      message: message.body,
      bookingId: message.bookingId ?? undefined,
    })
    await deps.prisma.message.update({
      where: { id: message.id },
      data: {
        status: 'sent',
        providerId,
        lockedAt: null,
        nextAttemptAt: null,
        lastError: null,
      },
    })
  } catch (error) {
    const backoffMs = Math.min(30_000 * 2 ** (attempt - 1), 30 * 60_000)
    const messageText = error instanceof Error ? error.message : 'Unknown SMS provider error'
    log.error({ err: error, messageId: message.id, attempt }, 'sms dispatch failed')
    await deps.prisma.message.update({
      where: { id: message.id },
      data: {
        status: 'failed',
        lockedAt: null,
        nextAttemptAt: attempt < MAX_MESSAGE_ATTEMPTS
          ? new Date(now.getTime() + backoffMs)
          : null,
        lastError: messageText.slice(0, 500),
      },
    })
  }
  return true
}

async function dispatchQueued(
  deps: TripServiceDeps,
  queued: QueuedMessage[],
): Promise<void> {
  for (const item of queued) {
    const message = await deps.prisma.message.findUnique({ where: { id: item.id } })
    if (message) await deliverMessage(deps, message)
  }
}

/** Retry queued/failed messages and reclaim expired delivery leases. */
export async function dispatchPendingMessages(
  deps: TripServiceDeps,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? 50
  const staleLease = new Date(now.getTime() - MESSAGE_LEASE_MS)
  const candidates = await deps.prisma.message.findMany({
    where: {
      attempts: { lt: MAX_MESSAGE_ATTEMPTS },
      OR: [
        { status: 'queued' },
        {
          status: 'failed',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        { status: 'sending', lockedAt: { lte: staleLease } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  })

  let processed = 0
  for (const message of candidates) {
    if (await deliverMessage(deps, message, now)) processed += 1
  }
  return processed
}

/** Expire unanswered offers and automatically try the next eligible driver. */
export async function expirePendingOffers(
  deps: TripServiceDeps,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - OFFER_TIMEOUT_MS)
  const candidates = await deps.prisma.booking.findMany({
    where: { state: 'OFFERED', updatedAt: { lte: cutoff } },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  })

  let expiredCount = 0
  for (const candidate of candidates) {
    const expired = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(846271)) AS advisory_lock`
      const booking = await tx.booking.findUnique({ where: { id: candidate.id } })
      if (!booking || booking.state !== 'OFFERED' || booking.updatedAt > cutoff) return false

      const updated = await tx.booking.updateMany({
        where: {
          id: booking.id,
          state: 'OFFERED',
          driverId: booking.driverId,
          updatedAt: { lte: cutoff },
        },
        data: { state: 'REQUESTED', driverId: null },
      })
      if (updated.count === 0) return false

      if (booking.driverId) {
        await tx.bookingDecline.create({
          data: { bookingId: booking.id, driverId: booking.driverId, reason: 'timeout' },
        })
      }
      await tx.tripEvent.create({
        data: { bookingId: booking.id, type: 'OFFER_TIMEOUT', payload: {} },
      })
      return true
    })

    if (expired) {
      expiredCount += 1
      await offerNextDriver(deps, { bookingId: candidate.id })
    }
  }
  return expiredCount
}

/** Single authenticated cron entry point for dispatch recovery and offer expiry. */
export async function processPendingWork(
  deps: TripServiceDeps,
  now = new Date(),
): Promise<{ expiredOffers: number; retriedBookings: number; dispatchedMessages: number }> {
  const expiredOffers = await expirePendingOffers(deps, now)
  const retryCutoff = new Date(now.getTime() - 15_000)
  const pendingBookings = await deps.prisma.booking.findMany({
    where: { state: 'REQUESTED', createdAt: { lte: retryCutoff } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })

  let retriedBookings = 0
  for (const booking of pendingBookings) {
    try {
      await offerNextDriver(deps, { bookingId: booking.id })
      retriedBookings += 1
    } catch (error) {
      if (error instanceof IllegalTransitionError || error instanceof ConflictError) continue
      throw error
    }
  }

  const dispatchedMessages = await dispatchPendingMessages(deps, { now, limit: 100 })
  return { expiredOffers, retriedBookings, dispatchedMessages }
}

export async function createBooking(
  deps: TripServiceDeps,
  input: {
    passengerPhone: string
    pickupPoint: string
    arrivalRef?: string
    pickupAt: string
    destination: string
    partySize: number
    passengerName?: string
    ussdSessionId?: string
  },
) {
  const { prisma } = deps
  const phone = normalizePhone(input.passengerPhone)
  const pickupAt = new Date(input.pickupAt)

  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = generateRef()
    try {
      const result = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({
          data: {
            ref,
            passengerName: input.passengerName ?? null,
            passengerPhone: phone,
            pickupPoint: input.pickupPoint,
            arrivalRef: input.arrivalRef ?? null,
            pickupAt,
            destination: input.destination,
            partySize: input.partySize,
            state: 'REQUESTED',
            ussdSessionId: input.ussdSessionId ?? null,
          },
        })
        await tx.tripEvent.create({
          data: { bookingId: booking.id, type: 'BOOKING_CREATED', payload: {} },
        })
        const body = bookingConfirmation(ref)
        const message = await tx.message.create({
          data: {
            bookingId: booking.id,
            direction: 'OUTBOUND',
            channel: 'sms',
            phone,
            body,
            status: 'queued',
          },
        })
        return {
          booking,
          queued: [
            { id: message.id, to: phone, message: body, bookingId: booking.id },
          ],
        }
      })
      await dispatchQueued(deps, result.queued)
      return result.booking
    } catch (e) {
      if (isUniqueViolation(e)) {
        if (input.ussdSessionId) {
          const existing = await prisma.booking.findUnique({
            where: { ussdSessionId: input.ussdSessionId },
          })
          if (existing) return existing
        }
        lastError = e
        continue
      }
      throw e
    }
  }
  throw lastError
}

export async function offerNextDriver(
  deps: TripServiceDeps,
  { bookingId }: { bookingId: string },
) {
  const { prisma } = deps

  const result = await prisma.$transaction(async (tx) => {
    // Serialize driver allocation across requests. This is intentionally a
    // single advisory lock for the MVP; it prevents two bookings claiming the
    // same driver between the availability query and booking update.
    await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(846271)) AS advisory_lock`

    const booking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!booking) throw new Error(`Booking ${bookingId} not found`)

    // Make retries/concurrent callers idempotent once an offer is already set.
    if (booking.state === 'OFFERED' && booking.driverId) {
      const assignedDriver = await tx.driver.findUnique({ where: { id: booking.driverId } })
      return { booking, driver: assignedDriver, queued: [] as QueuedMessage[] }
    }
    if (booking.state !== 'REQUESTED') {
      throw new IllegalTransitionError(booking.state, 'DRIVER_OFFERED')
    }

    const declines = await tx.bookingDecline.findMany({
      where: { bookingId },
      select: { driverId: true },
    })
    const declinedIds = declines.map((d) => d.driverId)

    const driver = await tx.driver.findFirst({
      where: {
        active: true,
        id: { notIn: declinedIds },
        Booking: {
          none: { state: { in: ['OFFERED', 'CONFIRMED', 'ARRIVED'] } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })

    if (!driver) {
      const updated = await tx.booking.updateMany({
        where: { id: bookingId, state: 'REQUESTED' },
        data: { state: 'NO_DRIVER', driverId: null },
      })
      if (updated.count === 0) throw new ConflictError('Booking changed while selecting a driver')
      const updatedBooking = await tx.booking.findUnique({ where: { id: bookingId } })
      if (!updatedBooking) throw new Error(`Booking ${bookingId} not found`)
      await tx.tripEvent.create({
        data: { bookingId, type: 'NO_DRIVER_AVAILABLE', payload: {} },
      })
      const body = noDriverAvailable(booking.ref)
      const message = await tx.message.create({
        data: {
          bookingId,
          direction: 'OUTBOUND',
          channel: 'sms',
          phone: booking.passengerPhone,
          body,
          status: 'queued',
        },
      })
      return {
        booking: updatedBooking,
        driver: null,
        queued: [{ id: message.id, to: booking.passengerPhone, message: body, bookingId }],
      }
    }

    const updated = await tx.booking.updateMany({
      where: { id: bookingId, state: 'REQUESTED' },
      data: { state: 'OFFERED', driverId: driver.id },
    })
    if (updated.count === 0) throw new ConflictError('Booking changed while selecting a driver')
    const updatedBooking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!updatedBooking) throw new Error(`Booking ${bookingId} not found`)

    await tx.tripEvent.create({
      data: { bookingId, type: 'DRIVER_OFFERED', payload: {} },
    })
    const body = driverOffer(
      booking.ref,
      driver.name,
      booking.pickupPoint,
      booking.pickupAt.toISOString(),
      TIME_ZONE,
    )
    const message = await tx.message.create({
      data: {
        bookingId,
        direction: 'OUTBOUND',
        channel: 'sms',
        phone: driver.phone,
        body,
        status: 'queued',
      },
    })
    return {
      booking: updatedBooking,
      driver,
      queued: [{ id: message.id, to: driver.phone, message: body, bookingId }],
    }
  })

  await dispatchQueued(deps, result.queued)
  return { booking: result.booking, driver: result.driver }
}

export async function acceptOffer(
  deps: TripServiceDeps,
  { bookingId, driverPhone }: { bookingId: string; driverPhone: string },
) {
  const { prisma } = deps
  const phone = normalizePhone(driverPhone)
  const driver = await prisma.driver.findUnique({ where: { phone } })
  if (!driver) throw new Error(`Driver ${phone} not found`)

  const result = await prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!booking) throw new Error(`Booking ${bookingId} not found`)
    const offerCutoff = new Date(Date.now() - OFFER_TIMEOUT_MS)
    if (
      booking.state !== 'OFFERED' ||
      booking.driverId !== driver.id ||
      booking.updatedAt <= offerCutoff
    ) {
      throw new ConflictError(
        `Booking ${bookingId} is not currently offered to driver ${driver.id}`,
      )
    }

    applyEvent('OFFERED', 'DRIVER_ACCEPTED')
    const updated = await tx.booking.updateMany({
      where: {
        id: bookingId,
        state: 'OFFERED',
        driverId: driver.id,
        updatedAt: { gt: offerCutoff },
      },
      data: { state: 'CONFIRMED' },
    })
    if (updated.count === 0) {
      throw new ConflictError(
        `Booking ${bookingId} was already accepted or declined`,
      )
    }
    const bookingAfter = await tx.booking.findUnique({
      where: { id: bookingId },
    })
    if (!bookingAfter) throw new Error(`Booking ${bookingId} not found`)
    await tx.tripEvent.create({
      data: { bookingId, type: 'DRIVER_ACCEPTED', payload: {} },
    })
    const body = driverConfirmed(
      bookingAfter.ref,
      driver.name,
      driver.plate,
      driver.phone,
    )
    const message = await tx.message.create({
      data: {
        bookingId,
        direction: 'OUTBOUND',
        channel: 'sms',
        phone: bookingAfter.passengerPhone,
        body,
        status: 'queued',
      },
    })
    return {
      booking: bookingAfter,
      queued: [{ id: message.id, to: bookingAfter.passengerPhone, message: body, bookingId }],
    }
  })

  await dispatchQueued(deps, result.queued)
  return result.booking
}

export async function declineOffer(
  deps: TripServiceDeps,
  { bookingId, driverPhone }: { bookingId: string; driverPhone: string },
) {
  const { prisma } = deps
  const phone = normalizePhone(driverPhone)
  const driver = await prisma.driver.findUnique({ where: { phone } })
  if (!driver) throw new Error(`Driver ${phone} not found`)

  const result = await prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!booking) throw new Error(`Booking ${bookingId} not found`)
    if (booking.state !== 'OFFERED' || booking.driverId !== driver.id) {
      throw new ConflictError(
        `Booking ${bookingId} is not offered to driver ${driver.id}`,
      )
    }

    await tx.bookingDecline.create({
      data: { bookingId, driverId: driver.id, reason: 'declined' },
    })
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, state: 'OFFERED', driverId: driver.id },
      data: { state: 'REQUESTED', driverId: null },
    })
    if (updated.count === 0) {
      throw new ConflictError(
        `Booking ${bookingId} was already accepted or declined`,
      )
    }
    const bookingAfter = await tx.booking.findUnique({
      where: { id: bookingId },
    })
    if (!bookingAfter) throw new Error(`Booking ${bookingId} not found`)
    await tx.tripEvent.create({
      data: { bookingId, type: 'DRIVER_DECLINED', payload: {} },
    })
    return { booking: bookingAfter, driver, queued: [] as QueuedMessage[] }
  })

  await dispatchQueued(deps, result.queued)
  return { booking: result.booking, driver: result.driver }
}

export async function markArrived(
  deps: TripServiceDeps,
  { bookingId, driverPhone }: { bookingId: string; driverPhone: string },
) {
  const { prisma } = deps
  const phone = normalizePhone(driverPhone)
  const driver = await prisma.driver.findUnique({ where: { phone } })
  if (!driver) throw new Error(`Driver ${phone} not found`)

  const result = await prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!booking) throw new Error(`Booking ${bookingId} not found`)
    if (booking.driverId !== driver.id) {
      throw new ConflictError(
        `Driver ${driver.id} is not assigned to booking ${bookingId}`,
      )
    }
    const newState = applyEvent(booking.state, 'DRIVER_ARRIVED')
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { state: newState },
    })
    await tx.tripEvent.create({
      data: { bookingId, type: 'DRIVER_ARRIVED', payload: {} },
    })
    const body = arrived(booking.ref, driver.name)
    const message = await tx.message.create({
      data: {
        bookingId,
        direction: 'OUTBOUND',
        channel: 'sms',
        phone: booking.passengerPhone,
        body,
        status: 'queued',
      },
    })
    return {
      booking: updated,
      queued: [{ id: message.id, to: booking.passengerPhone, message: body, bookingId }],
    }
  })

  await dispatchQueued(deps, result.queued)
  return result.booking
}

export async function completeTrip(
  deps: TripServiceDeps,
  { bookingId, driverPhone }: { bookingId: string; driverPhone: string },
) {
  const { prisma } = deps
  const phone = normalizePhone(driverPhone)
  const driver = await prisma.driver.findUnique({ where: { phone } })
  if (!driver) throw new Error(`Driver ${phone} not found`)

  const result = await prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!booking) throw new Error(`Booking ${bookingId} not found`)
    if (booking.driverId !== driver.id) {
      throw new ConflictError(
        `Driver ${driver.id} is not assigned to booking ${bookingId}`,
      )
    }
    const newState = applyEvent(booking.state, 'TRIP_COMPLETED')
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { state: newState },
    })
    await tx.tripEvent.create({
      data: { bookingId, type: 'TRIP_COMPLETED', payload: {} },
    })
    const body = completed(booking.ref)
    const message = await tx.message.create({
      data: {
        bookingId,
        direction: 'OUTBOUND',
        channel: 'sms',
        phone: booking.passengerPhone,
        body,
        status: 'queued',
      },
    })
    return {
      booking: updated,
      queued: [{ id: message.id, to: booking.passengerPhone, message: body, bookingId }],
    }
  })

  await dispatchQueued(deps, result.queued)
  return result.booking
}

export async function cancelBooking(
  deps: TripServiceDeps,
  { bookingId }: { bookingId: string },
) {
  const { prisma } = deps

  const result = await prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!booking) throw new Error(`Booking ${bookingId} not found`)
    const newState = applyEvent(booking.state, 'CANCELLED')
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { state: newState },
    })
    await tx.tripEvent.create({
      data: { bookingId, type: 'CANCELLED', payload: {} },
    })
    const queued: QueuedMessage[] = []
    const body = cancelled(booking.ref)
    const pMessage = await tx.message.create({
      data: {
        bookingId,
        direction: 'OUTBOUND',
        channel: 'sms',
        phone: booking.passengerPhone,
        body,
        status: 'queued',
      },
    })
    queued.push({ id: pMessage.id, to: booking.passengerPhone, message: body, bookingId })
    if (booking.driverId) {
      const driver = await tx.driver.findUnique({ where: { id: booking.driverId } })
      if (!driver) throw new Error('Driver not found')
      const dMessage = await tx.message.create({
        data: {
          bookingId,
          direction: 'OUTBOUND',
          channel: 'sms',
          phone: driver.phone,
          body,
          status: 'queued',
        },
      })
      queued.push({ id: dMessage.id, to: driver.phone, message: body, bookingId })
    }
    return { booking: updated, queued }
  })

  await dispatchQueued(deps, result.queued)
  return result.booking
}

export async function applyDelay(
  deps: TripServiceDeps,
  { bookingId, minutes }: { bookingId: string; minutes: number },
) {
  const { prisma } = deps

  const result = await prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!booking) throw new Error(`Booking ${bookingId} not found`)
    applyEvent(booking.state, 'PICKUP_DELAYED')
    const newPickupAt = new Date(booking.pickupAt.getTime() + minutes * 60000)
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { pickupAt: newPickupAt },
    })
    await tx.tripEvent.create({
      data: { bookingId, type: 'PICKUP_DELAYED', payload: { minutes } },
    })
    const queued: QueuedMessage[] = []
    const pBody = delayNotice(
      booking.ref,
      newPickupAt.toISOString(),
      minutes,
      'passenger',
      TIME_ZONE,
    )
    const pMessage = await tx.message.create({
      data: {
        bookingId,
        direction: 'OUTBOUND',
        channel: 'sms',
        phone: booking.passengerPhone,
        body: pBody,
        status: 'queued',
      },
    })
    queued.push({ id: pMessage.id, to: booking.passengerPhone, message: pBody, bookingId })
    if (booking.driverId) {
      const driver = await tx.driver.findUnique({ where: { id: booking.driverId } })
      if (!driver) throw new Error('Driver not found')
      const dBody = delayNotice(
        booking.ref,
        newPickupAt.toISOString(),
        minutes,
        'driver',
        TIME_ZONE,
      )
      const dMessage = await tx.message.create({
        data: {
          bookingId,
          direction: 'OUTBOUND',
          channel: 'sms',
          phone: driver.phone,
          body: dBody,
          status: 'queued',
        },
      })
      queued.push({ id: dMessage.id, to: driver.phone, message: dBody, bookingId })
    }
    return { booking: updated, queued }
  })

  await dispatchQueued(deps, result.queued)
  return { booking: result.booking, state: result.booking.state }
}

export { IllegalTransitionError }
