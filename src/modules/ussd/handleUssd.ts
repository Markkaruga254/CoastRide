import { PrismaClient } from '@prisma/client'
import { MessagingPort } from '../messaging/port.js'
import { normalizePhone } from '../../lib/phone.js'
import { createBooking } from '../bookings/service.js'

export interface UssdDeps {
  prisma: PrismaClient
  messenger: MessagingPort
  now: () => Date
}

export interface UssdInput {
  phoneNumber: string
  text: string
  sessionId: string
}

export interface UssdResponse {
  type: 'CON' | 'END'
  text: string
}

const MAX_PARTY_SIZE = 6
const MAX_DESTINATION_LEN = 40
const MIN_DESTINATION_LEN = 2

type Step =
  | 'MAIN'
  | 'ARRIVAL_REF'
  | 'ARRIVAL_TIME'
  | 'DESTINATION'
  | 'PARTY_SIZE'
  | 'CONFIRM'
  | 'CHECK_BOOKING_REF'
  | 'CHECK_BOOKING_RESULT'

interface SessionState {
  step: Step
  pickupPoint?: string
  arrivalRef?: string
  pickupAt?: Date
  destination?: string
  partySize?: number
  errorCount: number
  action?: 'create-booking' | 'cancel-booking'
}

function isValidArrivalRef(input: string): boolean {
  return /^[A-Z0-9]{3,8}$/i.test(input)
}

function sanitizeDestination(input: string): string {
  return input.trim().slice(0, MAX_DESTINATION_LEN)
}

function isValidDestination(input: string): boolean {
  const s = sanitizeDestination(input)
  return s.length >= MIN_DESTINATION_LEN && s.length <= MAX_DESTINATION_LEN
}

function parseTimeHHMM(input: string, now: Date): Date | null {
  const match = input.match(/^(\d{2})(\d{2})$/)
  if (!match) return null
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null

  const tzOffset = 3 * 60 * 60 * 1000 // Africa/Nairobi is UTC+3
  const today = new Date(now.getTime() + tzOffset)
  today.setUTCHours(hours, minutes, 0, 0)

  const result = new Date(today.getTime() - tzOffset)
  if (result <= now) {
    result.setDate(result.getDate() + 1)
  }
  return result
}

function isValidPartySize(input: string): boolean {
  const n = parseInt(input, 10)
  return !isNaN(n) && n >= 1 && n <= MAX_PARTY_SIZE
}

function getStateLabel(state: string): string {
  const labels: Record<string, string> = {
    REQUESTED: 'Looking for driver',
    OFFERED: 'Driver offered',
    CONFIRMED: 'Driver confirmed',
    ARRIVED: 'Driver arrived',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
    NO_DRIVER: 'No driver available',
  }
  return labels[state] ?? state
}

function buildMainMenu(): string {
  return [
    'CON Welcome to CoastRide',
    '1. Airport pickup (MIA)',
    '2. SGR station pickup',
    '3. Check my booking',
  ].join('\n')
}

function buildArrivalRefScreen(pickupPoint: string, error = false): string {
  const lines = [
    `CON ${pickupPoint} - Arrival ref (flight/train no.)`,
    'Enter 3-8 alphanumeric chars:',
  ]
  if (error) lines.unshift('Invalid ref. Try again.')
  return lines.join('\n')
}

function buildArrivalTimeScreen(pickupPoint: string, arrivalRef: string, error = false): string {
  const lines = [
    `CON ${pickupPoint} - ${arrivalRef}`,
    'Arrival time (HHMM, 24h):',
  ]
  if (error) lines.unshift('Invalid time. Use HHMM format.')
  return lines.join('\n')
}

function buildDestinationScreen(pickupPoint: string, arrivalRef: string, error = false): string {
  const lines = [
    `CON ${pickupPoint} - ${arrivalRef}`,
    'Destination (2-40 chars):',
  ]
  if (error) lines.unshift('Invalid destination. 2-40 chars.')
  return lines.join('\n')
}

function buildPartySizeScreen(pickupPoint: string, arrivalRef: string, error = false): string {
  const lines = [
    `CON ${pickupPoint} - ${arrivalRef}`,
    'Party size (1-6):',
  ]
  if (error) lines.unshift('Invalid size. Enter 1-6.')
  return lines.join('\n')
}

function buildConfirmScreen(
  pickupPoint: string,
  arrivalRef: string,
  pickupAt: string,
  destination: string,
  partySize: number,
  error = false,
): string {
  const lines = [
    `CON ${pickupPoint} - ${arrivalRef}`,
    `Time: ${pickupAt}`,
    `To: ${destination}`,
    `Size: ${partySize}`,
    '1. Confirm',
    '2. Cancel',
  ]
  if (error) lines.unshift('Invalid choice. 1 or 2.')
  return lines.join('\n')
}

function buildCheckBookingRefScreen(error = false): string {
  const lines = ['CON Check my booking', 'Enter booking ref (e.g. CR1042):']
  if (error) lines.unshift('Invalid ref. Try again.')
  return lines.join('\n')
}

// Process one segment through the state machine. Returns the new state,
// or a terminal response when two consecutive invalid inputs occur on the
// same step, or when the user confirms/cancels on the CONFIRM step.
function processSegment(
  state: SessionState,
  segment: string,
  now: Date,
): { state: SessionState; terminal?: UssdResponse } {
  const nextError = (): SessionState => ({ ...state, errorCount: state.errorCount + 1 })

  switch (state.step) {
    case 'MAIN':
      if (segment === '1') {
        return { state: { step: 'ARRIVAL_REF', pickupPoint: 'MIA', errorCount: 0 } }
      }
      if (segment === '2') {
        return { state: { step: 'ARRIVAL_REF', pickupPoint: 'SGR', errorCount: 0 } }
      }
      if (segment === '3') {
        return { state: { step: 'CHECK_BOOKING_REF', errorCount: 0 } }
      }
      if (state.errorCount + 1 >= 2) {
        return { state, terminal: { type: 'END', text: 'END Sorry, please dial again.' } }
      }
      return { state: nextError() }

    case 'ARRIVAL_REF':
      if (isValidArrivalRef(segment) && state.pickupPoint) {
        return {
          state: {
            step: 'ARRIVAL_TIME',
            pickupPoint: state.pickupPoint,
            arrivalRef: segment.toUpperCase(),
            errorCount: 0,
          },
        }
      }
      if (state.errorCount + 1 >= 2) {
        return { state, terminal: { type: 'END', text: 'END Sorry, please dial again.' } }
      }
      return { state: nextError() }

    case 'ARRIVAL_TIME':
      if (state.pickupPoint && state.arrivalRef) {
        const pickupAt = parseTimeHHMM(segment, now)
        if (pickupAt) {
          return {
            state: {
              step: 'DESTINATION',
              pickupPoint: state.pickupPoint,
              arrivalRef: state.arrivalRef,
              pickupAt,
              errorCount: 0,
            },
          }
        }
      }
      if (state.errorCount + 1 >= 2) {
        return { state, terminal: { type: 'END', text: 'END Sorry, please dial again.' } }
      }
      return { state: nextError() }

    case 'DESTINATION':
      if (isValidDestination(segment) && state.pickupPoint && state.arrivalRef && state.pickupAt) {
        return {
          state: {
            step: 'PARTY_SIZE',
            pickupPoint: state.pickupPoint,
            arrivalRef: state.arrivalRef,
            pickupAt: state.pickupAt,
            destination: sanitizeDestination(segment),
            errorCount: 0,
          },
        }
      }
      if (state.errorCount + 1 >= 2) {
        return { state, terminal: { type: 'END', text: 'END Sorry, please dial again.' } }
      }
      return { state: nextError() }

    case 'PARTY_SIZE':
      if (
        isValidPartySize(segment) &&
        state.pickupPoint &&
        state.arrivalRef &&
        state.pickupAt &&
        state.destination
      ) {
        return {
          state: {
            step: 'CONFIRM',
            pickupPoint: state.pickupPoint,
            arrivalRef: state.arrivalRef,
            pickupAt: state.pickupAt,
            destination: state.destination,
            partySize: parseInt(segment, 10),
            errorCount: 0,
          },
        }
      }
      if (state.errorCount + 1 >= 2) {
        return { state, terminal: { type: 'END', text: 'END Sorry, please dial again.' } }
      }
      return { state: nextError() }

    case 'CONFIRM':
      if (segment === '1') {
        return { state: { ...state, action: 'create-booking' } }
      }
      if (segment === '2') {
        return { state: { ...state, action: 'cancel-booking' } }
      }
      if (state.errorCount + 1 >= 2) {
        return { state, terminal: { type: 'END', text: 'END Sorry, please dial again.' } }
      }
      return { state: nextError() }

    case 'CHECK_BOOKING_REF':
      if (/^CR\d{4}$/.test(segment)) {
        return {
          state: {
            step: 'CHECK_BOOKING_RESULT',
            arrivalRef: segment.toUpperCase(),
            errorCount: 0,
          },
        }
      }
      if (state.errorCount + 1 >= 2) {
        return { state, terminal: { type: 'END', text: 'END Sorry, please dial again.' } }
      }
      return { state: nextError() }

    case 'CHECK_BOOKING_RESULT':
      return { state }
  }
}

function reduceSegments(
  segments: string[],
  now: Date,
): { state: SessionState; terminal?: UssdResponse } {
  let state: SessionState = { step: 'MAIN', errorCount: 0 }

  for (const segment of segments) {
    const result = processSegment(state, segment, now)
    state = result.state
    if (result.terminal) {
      return { state, terminal: result.terminal }
    }
    if (state.action) {
      break
    }
  }

  return { state }
}

export async function handleUssd(
  input: UssdInput,
  deps: UssdDeps,
): Promise<UssdResponse> {
  const { phoneNumber, text, sessionId } = input
  const { prisma, now } = deps

  const phone = normalizePhone(phoneNumber)

  // Idempotency: existing booking with this sessionId returns its END message
  const existingBooking = await prisma.booking.findUnique({
    where: { ussdSessionId: sessionId },
    include: { driver: true },
  })

  if (existingBooking) {
    if (existingBooking.state === 'REQUESTED') {
      return { type: 'END', text: `END Booked! Ref ${existingBooking.ref}. We sent you an SMS.` }
    }
    const stateLabel = getStateLabel(existingBooking.state)
    let text = `END Booking ${existingBooking.ref}: ${stateLabel}`
    if (existingBooking.driver) {
      text += `\nDriver: ${existingBooking.driver.name} (${existingBooking.driver.plate})`
    }
    return { type: 'END', text }
  }

  const segments = text.split('*').filter((p) => p !== '')
  const { state, terminal } = reduceSegments(segments, now())

  if (terminal) {
    return terminal
  }

  if (state.action === 'cancel-booking') {
    return { type: 'END', text: 'END Booking cancelled.' }
  }

  if (state.action === 'create-booking') {
    const pickupPoint = state.pickupPoint!
    const arrivalRef = state.arrivalRef!
    const pickupAt = state.pickupAt!
    const destination = state.destination!
    const partySize = state.partySize!

    const booking = await createBooking(deps, {
      passengerPhone: phone,
      pickupPoint,
      arrivalRef,
      pickupAt: pickupAt.toISOString(),
      destination,
      partySize,
      ussdSessionId: sessionId,
    })

    return { type: 'END', text: `END Booked! Ref ${booking.ref}. We sent you an SMS.` }
  }

  // No terminal action: render the screen for the current step
  switch (state.step) {
    case 'MAIN':
      return { type: 'CON', text: buildMainMenu() }

    case 'ARRIVAL_REF':
      return {
        type: 'CON',
        text: buildArrivalRefScreen(state.pickupPoint!, state.errorCount > 0),
      }

    case 'ARRIVAL_TIME':
      return {
        type: 'CON',
        text: buildArrivalTimeScreen(
          state.pickupPoint!,
          state.arrivalRef!,
          state.errorCount > 0,
        ),
      }

    case 'DESTINATION':
      return {
        type: 'CON',
        text: buildDestinationScreen(
          state.pickupPoint!,
          state.arrivalRef!,
          state.errorCount > 0,
        ),
      }

    case 'PARTY_SIZE':
      return {
        type: 'CON',
        text: buildPartySizeScreen(
          state.pickupPoint!,
          state.arrivalRef!,
          state.errorCount > 0,
        ),
      }

    case 'CONFIRM': {
      const pickupAtStr = state.pickupAt!.toLocaleString('en-GB', {
        timeZone: 'Africa/Nairobi',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).replace(',', '')
      return {
        type: 'CON',
        text: buildConfirmScreen(
          state.pickupPoint!,
          state.arrivalRef!,
          pickupAtStr,
          state.destination!,
          state.partySize!,
          state.errorCount > 0,
        ),
      }
    }

    case 'CHECK_BOOKING_REF':
      return { type: 'CON', text: buildCheckBookingRefScreen(state.errorCount > 0) }

    case 'CHECK_BOOKING_RESULT': {
      const ref = state.arrivalRef!
      const booking = await prisma.booking.findUnique({
        where: { ref },
        include: { driver: true },
      })
      if (!booking) {
        return { type: 'END', text: `END Booking ${ref} not found.` }
      }
      const stateLabel = getStateLabel(booking.state)
      let resultText = `END Booking ${ref}: ${stateLabel}`
      if (booking.driver) {
        resultText += `\nDriver: ${booking.driver.name} (${booking.driver.plate})`
      }
      return { type: 'END', text: resultText }
    }
  }

  return { type: 'END', text: 'END Sorry, please dial again.' }
}
