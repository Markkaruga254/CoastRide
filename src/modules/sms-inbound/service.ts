import { PrismaClient } from '@prisma/client'
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
  ConflictError,
} from '../bookings/service.js'
import { helpText } from '../messaging/templates.js'

const log = (msg: string, args: unknown) => {
  // eslint-disable-next-line no-console
  console.log(msg, args)
}

export async function handleInboundSms(
  deps: { prisma: PrismaClient; messenger: MessagingPort },
  input: { from: string; text: string; messageId: string },
): Promise<void> {
  const { prisma, messenger } = deps
  const { from, text, messageId } = input

  const phone = normalizePhone(from)
  const command = parseSms(text)

  if (command.kind === 'unknown') {
    const driver = await prisma.driver.findUnique({ where: { phone } })
    if (driver) {
      try {
        await messenger.sendSms({ to: phone, message: helpText() })
      } catch {
        // Ignore SMS delivery failures for help messages
      }
    }
    log(`[SMS-INBOUND] unknown text from ${maskPhone(from)}: ${text}`, { messageId })
    return
  }

  const booking = await prisma.booking.findUnique({ where: { ref: command.ref } })
  if (!booking) {
    // Don't leak whether a ref exists
    return
  }

  const driver = booking.driverId ? await prisma.driver.findUnique({ where: { id: booking.driverId } }) : null
  const isAssignedDriver = driver ? driver.phone === phone : false
  const isPassenger = booking.passengerPhone === phone

  let authorized = false
  switch (command.kind) {
    case 'accept':
    case 'decline':
    case 'arrived':
    case 'done':
      authorized = isAssignedDriver
      break
    case 'delay':
      authorized = isAssignedDriver || isPassenger
      break
    case 'cancel':
      authorized = isPassenger
      break
  }

  if (!authorized) {
    log(`[SMS-INBOUND] unauthorized ${command.kind} from ${maskPhone(phone)} for ${command.ref}`, {
      messageId,
      bookingId: booking.id,
    })
    return
  }

  try {
    switch (command.kind) {
      case 'accept':
        await acceptOffer({ prisma, messenger }, { bookingId: booking.id, driverPhone: phone })
        break
      case 'decline':
        await declineOffer({ prisma, messenger }, { bookingId: booking.id, driverPhone: phone })
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
  } catch (e) {
    if (e instanceof ConflictError) {
      log(`[SMS-INBOUND] conflict on ${command.kind} for ${command.ref}`, { messageId, bookingId: booking.id })
    } else {
      log(`[SMS-INBOUND] error on ${command.kind} for ${command.ref}`, { messageId, bookingId: booking.id, err: e })
    }
  }
}
