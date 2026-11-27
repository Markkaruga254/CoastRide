import { PrismaClient } from '@prisma/client'
import pino from 'pino'
import { MessagingPort } from '../messaging/port.js'
import { normalizePhone } from '../../lib/phone.js'
import { maskPhone } from '../../lib/security.js'
import { parseSms } from './parse.js'
import {
  acceptOffer,
  declineOffer,
  markArrived,
  completeTrip,
  applyDelay,
  cancelBooking,
  offerNextDriver,
  ConflictError,
  IllegalTransitionError,
} from '../bookings/service.js'
import { helpText, actionNotAvailable } from '../messaging/templates.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

export async function handleInboundSms(
  deps: { prisma: PrismaClient; messenger: MessagingPort },
  input: { from: string; text: string; messageId: string },
): Promise<void> {
  const { prisma, messenger } = deps
  const { from, text, messageId } = input

  const phone = normalizePhone(from)
  const command = parseSms(text)

  if (command.kind === 'unknown') {
    const knownDriver = await prisma.driver.findUnique({ where: { phone } })
    if (knownDriver) {
      try {
        await messenger.sendSms({ to: phone, message: helpText() })
      } catch (error) {
        log.warn({ err: error, phone: maskPhone(phone), messageId }, 'failed to send SMS help reply')
      }
    }
    // Never write the inbound message body to logs; it may contain personal data.
    log.info({ phone: maskPhone(phone), messageId }, 'unknown inbound SMS command')
    return
  }

  const booking = await prisma.booking.findUnique({ where: { ref: command.ref } })
  if (!booking) return // Do not reveal whether a booking reference exists.

  const senderDriver = await prisma.driver.findUnique({ where: { phone } })
  const isAssignedDriver = !!senderDriver && booking.driverId === senderDriver.id
  const isPassenger = booking.passengerPhone === phone
  const previousDecline = senderDriver
    ? await prisma.bookingDecline.findUnique({
        where: { bookingId_driverId: { bookingId: booking.id, driverId: senderDriver.id } },
      })
    : null
  // If a decline committed but dispatching the next offer failed, allow the
  // provider's retry to resume dispatch without trying to decline twice.
  const isRetryingDecline =
    command.kind === 'decline' && booking.state === 'REQUESTED' && !!previousDecline

  let authorized = false
  switch (command.kind) {
    case 'accept':
    case 'arrived':
    case 'done':
      authorized = isAssignedDriver
      break
    case 'decline':
      authorized = isAssignedDriver || isRetryingDecline
      break
    case 'delay':
      authorized = isAssignedDriver || isPassenger
      break
    case 'cancel':
      authorized = isPassenger
      break
  }

  if (!authorized) {
    log.warn(
      { command: command.kind, phone: maskPhone(phone), bookingId: booking.id, messageId },
      'unauthorized inbound SMS command ignored',
    )
    return
  }

  try {
    switch (command.kind) {
      case 'accept':
        await acceptOffer({ prisma, messenger }, { bookingId: booking.id, driverPhone: phone })
        break
      case 'decline':
        if (!isRetryingDecline) {
          await declineOffer({ prisma, messenger }, { bookingId: booking.id, driverPhone: phone })
        }
        await offerNextDriver({ prisma, messenger }, { bookingId: booking.id })
        break
      case 'arrived':
        await markArrived({ prisma, messenger }, { bookingId: booking.id, driverPhone: phone })
        break
      case 'done':
        await completeTrip({ prisma, messenger }, { bookingId: booking.id, driverPhone: phone })
        break
      case 'delay':
        await applyDelay({ prisma, messenger }, { bookingId: booking.id, minutes: command.minutes })
        break
      case 'cancel':
        await cancelBooking({ prisma, messenger }, { bookingId: booking.id })
        break
    }
  } catch (error) {
    if (error instanceof ConflictError) {
      // Stale/duplicate commands are terminal business outcomes, not provider failures.
      log.warn({ command: command.kind, bookingId: booking.id, messageId }, 'inbound SMS command conflict')
      if (isAssignedDriver || isPassenger) {
        try {
          await messenger.sendSms({ to: phone, message: actionNotAvailable(booking.ref) })
        } catch (sendError) {
          log.warn({ err: sendError, phone: maskPhone(phone), messageId }, 'failed to send actionNotAvailable SMS')
        }
      }
      return
    }
    if (error instanceof IllegalTransitionError) {
      // Invalid state transitions are terminal business outcomes, not provider failures.
      // Notify the sender if they are the assigned driver or passenger.
      log.warn({ command: command.kind, bookingId: booking.id, messageId }, 'inbound SMS illegal transition')
      if (isAssignedDriver || isPassenger) {
        try {
          await messenger.sendSms({ to: phone, message: actionNotAvailable(booking.ref) })
        } catch (sendError) {
          log.warn({ err: sendError, phone: maskPhone(phone), messageId }, 'failed to send actionNotAvailable SMS')
        }
      }
      return
    }
    log.error({ err: error, command: command.kind, bookingId: booking.id, messageId }, 'inbound SMS processing failed')
    throw error
  }
}
