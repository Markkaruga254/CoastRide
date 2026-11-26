import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { PrismaClient } from '@prisma/client'
import { getEnv } from '../../config/env.js'
import { MessagingPort } from '../../modules/messaging/port.js'
import { verifySecret } from '../../lib/security.js'
import { handleUssd } from '../../modules/ussd/handleUssd.js'
import { normalizePhone } from '../../lib/phone.js'
import { offerNextDriver } from '../../modules/bookings/service.js'

const ussdBodySchema = z.object({
  sessionId: z.string().min(1),
  serviceCode: z.string().optional(),
  phoneNumber: z.string().min(1),
  networkCode: z.string().optional(),
  text: z.string().default(''),
})

const ussdRoute: FastifyPluginAsync<{ prisma: PrismaClient; messenger: MessagingPort }> = async (
  app,
  deps,
) => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const env = getEnv()
    const params = request.params as { secret: string }
    const secret = params.secret
    if (!verifySecret(secret, env.WEBHOOK_SECRET)) {
      return reply.status(404).send()
    }
  })

  app.post<{
    Params: { secret: string }
    Body: z.infer<typeof ussdBodySchema>
  }>('/ussd', async (request, reply) => {
    const result = ussdBodySchema.safeParse(request.body)
    if (!result.success) {
      reply.type('text/plain')
      return 'END Service temporarily unavailable. Please try again.'
    }

    const { sessionId, phoneNumber, text } = result.data
    const phone = normalizePhone(phoneNumber)

    try {
      const response = await handleUssd(
        { phoneNumber: phone, text, sessionId },
        { prisma: deps.prisma, messenger: deps.messenger, now: () => new Date() },
      )

      // Fire and forget: offer the newly created booking to the first available driver.
      // The USSD response must not wait on this or on SMS dispatch.
      if (response.type === 'END' && response.text.includes('Booked!')) {
        const log = request.log
        void deps.prisma.booking
          .findUnique({ where: { ussdSessionId: sessionId } })
          .then((booking) => {
            if (booking && booking.state === 'REQUESTED') {
              return offerNextDriver({ prisma: deps.prisma, messenger: deps.messenger }, {
                bookingId: booking.id,
              })
            }
            return null
          })
          .catch((err) => {
            log.error({ err, sessionId }, 'USSD post-booking offer failed')
          })
      }

      reply.type('text/plain')
      return response.text
    } catch (err) {
      request.log.error({ err, sessionId, phone: phone.replace(/\d(?=\d{4})/g, '*') }, 'USSD handler error')
      reply.type('text/plain')
      return 'END Service temporarily unavailable. Please try again.'
    }
  })
}

export default ussdRoute