import { PrismaClient } from '@prisma/client'
import { MessagingPort } from '../messaging/port.js'
import { normalizePhone } from '../../lib/phone.js'
import {
  acceptOffer,
  declineOffer,
  markArrived,
  completeTrip,
  offerNextDriver,
  ConflictError,
  IllegalTransitionError,
} from '../bookings/service.js'

export interface DriverUssdInput {
  phoneNumber: string
  text: string
}

export interface DriverUssdDeps {
  prisma: PrismaClient
  messenger: MessagingPort
}

const ACTIVE_STATES = ['OFFERED', 'CONFIRMED', 'ARRIVED'] as const

function formatPickupTime(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value)
}

function buildTripScreen(
  booking: {
    ref: string
    pickupPoint: string
    pickupAt: Date
    destination: string
    partySize: number
    state: string
  },
): string {
  const summary = `${booking.ref} ${booking.pickupPoint} ${formatPickupTime(booking.pickupAt)}`
    + ` -> ${booking.destination} (${booking.partySize} pax)`

  if (booking.state === 'OFFERED') {
    return `CON Trip offer\n${summary}\n1. Accept\n2. Decline`
  }
  if (booking.state === 'CONFIRMED') {
    return `CON Active trip\n${summary}\n3. Mark arrived`
  }
  return `CON Active trip\n${summary}\n4. Complete trip`
}

function buildMenu(): string {
  return [
    'CON CoastRide Driver',
    '1. View current trip',
    '2. Help',
  ].join('\n')
}

export async function handleDriverUssd(
  input: DriverUssdInput,
  deps: DriverUssdDeps,
): Promise<{ type: 'CON' | 'END'; text: string }> {
  const phone = normalizePhone(input.phoneNumber)
  const driver = await deps.prisma.driver.findUnique({ where: { phone } })

  if (!driver || !driver.active) {
    return { type: 'END', text: 'END This number is not registered as an active CoastRide driver.' }
  }

  const segments = input.text.split('*').filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return { type: 'CON', text: buildMenu() }
  }

  if (segments.length === 1 && segments[0] === '2') {
    return {
      type: 'END',
      text: 'END View your trip, then choose the action shown. Accept/decline offers promptly.',
    }
  }

  if (segments[0] !== '1' || segments.length > 2) {
    return { type: 'END', text: 'END Invalid choice. Please dial the driver code again.' }
  }

  const booking = await deps.prisma.booking.findFirst({
    where: {
      driverId: driver.id,
      state: { in: [...ACTIVE_STATES] },
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  })

  if (!booking) {
    return { type: 'END', text: 'END You have no active trip or offer right now.' }
  }

  if (segments.length === 1) {
    return { type: 'CON', text: buildTripScreen(booking) }
  }

  const choice = segments[1]
  try {
    if (booking.state === 'OFFERED' && choice === '1') {
      await acceptOffer(deps, { bookingId: booking.id, driverPhone: phone })
      return { type: 'END', text: `END Trip ${booking.ref} accepted. The passenger will be notified by SMS.` }
    }

    if (booking.state === 'OFFERED' && choice === '2') {
      await declineOffer(deps, { bookingId: booking.id, driverPhone: phone })
      await offerNextDriver(deps, { bookingId: booking.id })
      return { type: 'END', text: `END Trip ${booking.ref} declined. The next driver will be notified.` }
    }

    if (booking.state === 'CONFIRMED' && choice === '3') {
      await markArrived(deps, { bookingId: booking.id, driverPhone: phone })
      return { type: 'END', text: `END Arrival recorded for trip ${booking.ref}. The passenger will be notified.` }
    }

    if (booking.state === 'ARRIVED' && choice === '4') {
      await completeTrip(deps, { bookingId: booking.id, driverPhone: phone })
      return { type: 'END', text: `END Trip ${booking.ref} marked complete. Thank you.` }
    }

    return { type: 'END', text: 'END That action is not available for this trip. Dial again to refresh.' }
  } catch (error) {
    if (error instanceof ConflictError || error instanceof IllegalTransitionError) {
      return { type: 'END', text: 'END Trip status changed. Dial again to refresh your current trip.' }
    }
    throw error
  }
}
