import { FastifyPluginAsync } from 'fastify'
import { z, ZodError } from 'zod'
import { PrismaClient } from '@prisma/client'
import { MessagingPort } from '../../modules/messaging/port.js'
import {
  createBooking,
  acceptOffer,
  declineOffer,
  cancelBooking,
  applyDelay,
} from '../../modules/bookings/service.js'
import { normalizePhone } from '../../lib/phone.js'

const createBookingSchema = z.object({
  passengerPhone: z.string().min(1).refine((p) => {
    try {
      normalizePhone(p)
      return true
    } catch {
      return false
    }
  }, 'Invalid phone number'),
  passengerName: z.string().optional(),
  pickupPoint: z.string().min(1),
  arrivalRef: z.string().optional(),
  pickupAt: z.string().datetime(),
  destination: z.string().min(1),
  partySize: z.number().int().min(1).max(6),
})

const driverResponseSchema = z.object({
  driverPhone: z.string().min(1).refine((p) => {
    try {
      normalizePhone(p)
      return true
    } catch {
      return false
    }
  }, 'Invalid phone number'),
  action: z.enum(['accept', 'decline']),
})

const delaySchema = z.object({
  minutes: z.number().int().positive(),
})

type BookingsDeps = {
  prisma: PrismaClient
  messenger: MessagingPort
}

async function bookingByRef(prisma: PrismaClient, ref: string) {
  const booking = await prisma.booking.findUnique({ where: { ref } })
  if (!booking) {
    const err = new Error(`Booking ${ref} not found`) as Error & { statusCode?: number }
    err.statusCode = 404
    throw err
  }
  return booking
}

const bookingsRoutes: FastifyPluginAsync<BookingsDeps> = async (app, opts) => {
  const { prisma, messenger } = opts

  app.post('/bookings', async (request, reply) => {
    try {
      const body = createBookingSchema.parse(request.body)
      const booking = await createBooking(
        { prisma, messenger },
        {
          passengerPhone: body.passengerPhone,
          pickupPoint: body.pickupPoint,
          arrivalRef: body.arrivalRef,
          pickupAt: body.pickupAt,
          destination: body.destination,
          partySize: body.partySize,
          passengerName: body.passengerName,
        }
      )
      return reply.status(201).send(booking)
    } catch (e) {
      if (e instanceof ZodError) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: e.message } })
      }
      throw e
    }
  })

  app.get('/bookings/:ref', async (request, reply) => {
    const { ref } = request.params as { ref: string }
    try {
      return await bookingByRef(prisma, ref)
    } catch (e) {
      const err = e as Error & { statusCode?: number }
      if (err.statusCode === 404) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } })
      }
      throw e
    }
  })

  app.post<{ Params: { ref: string }; Body: z.infer<typeof driverResponseSchema> }>(
    '/bookings/:ref/driver-response',
    async (request, reply) => {
      try {
        const { ref } = request.params
        const body = driverResponseSchema.parse(request.body)
        const booking = await bookingByRef(prisma, ref)
        const phone = normalizePhone(body.driverPhone)
        if (body.action === 'accept') {
          await acceptOffer({ prisma, messenger }, { bookingId: booking.id, driverPhone: phone })
        } else {
          await declineOffer({ prisma, messenger }, { bookingId: booking.id, driverPhone: phone })
        }
        return await bookingByRef(prisma, ref)
      } catch (e) {
        if (e instanceof ZodError) {
          return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: e.message } })
        }
        throw e
      }
    }
  )

  app.post<{ Params: { ref: string }; Body: z.infer<typeof delaySchema> }>(
    '/bookings/:ref/delay',
    async (request, reply) => {
      try {
        const { ref } = request.params
        const body = delaySchema.parse(request.body)
        const booking = await bookingByRef(prisma, ref)
        await applyDelay({ prisma, messenger }, { bookingId: booking.id, minutes: body.minutes })
        return await bookingByRef(prisma, ref)
      } catch (e) {
        if (e instanceof ZodError) {
          return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: e.message } })
        }
        throw e
      }
    }
  )

  app.post('/bookings/:ref/cancel', async (request) => {
    const { ref } = request.params as { ref: string }
    const booking = await bookingByRef(prisma, ref)
    await cancelBooking({ prisma, messenger }, { bookingId: booking.id })
    return await bookingByRef(prisma, ref)
  })
}

export default bookingsRoutes
