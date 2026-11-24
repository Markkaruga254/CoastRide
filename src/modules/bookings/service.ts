import { PrismaClient } from '@prisma/client'
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

async function dispatchQueued(
  deps: TripServiceDeps,
  queued: QueuedMessage[],
): Promise<void> {
  for (const m of queued) {
    try {
      const { providerId } = await deps.messenger.sendSms({
        to: m.to,
        message: m.message,
        bookingId: m.bookingId,
      })
      await deps.prisma.message.update({
        where: { id: m.id },
        data: { status: 'sent', providerId },
      })
    } catch {
      await deps.prisma.message.update({
        where: { id: m.id },
        data: { status: 'failed' },
      })
    }
  }
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
    const booking = await tx.booking.findUnique({ where: { id: bookingId } })
    if (!booking) throw new Error(`Booking ${bookingId} not found`)
    if (booking.state !== 'REQUESTED') {
      throw new IllegalTransitionError(booking.state, 'DRIVER_OFFERED')
    }

    const declines = await tx.bookingDecline.findMany({
      where: { bookingId },
      select: { driverId: true },
    })
    const declinedIds = new Set(declines.map((d) => d.driverId))

    const drivers = await tx.driver.findMany({
      where: { active: true, id: { notIn: [...declinedIds] } },
      orderBy: { id: 'asc' },
      take: 1,
    })

    if (drivers.length === 0) {
      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: { state: 'NO_DRIVER', driverId: null },
      })
      await tx.tripEvent.create({
        data: { bookingId, type: 'NO_DRIVER_AVAILABLE', payload: {} },
      })
      return { booking: updated, driver: null, queued: [] as QueuedMessage[] }
    }

    const driver = drivers[0]
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { state: 'OFFERED', driverId: driver.id },
    })
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
      booking: updated,
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
    if (booking.state !== 'OFFERED' || booking.driverId !== driver.id) {
      throw new ConflictError(
        `Booking ${bookingId} is not offered to driver ${driver.id}`,
      )
    }

    applyEvent('OFFERED', 'DRIVER_ACCEPTED')
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, state: 'OFFERED', driverId: driver.id },
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
