import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { PrismaClient } from '@prisma/client'
import { getEnv } from '../../config/env.js'
import { verifySecret } from '../../lib/security.js'
import { MessagingPort } from '../../modules/messaging/port.js'
import { handleInboundSms } from '../../modules/sms-inbound/service.js'
import { normalizePhone } from '../../lib/phone.js'

const smsBodySchema = z.object({
  id: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  phoneNumber: z.string().min(1).optional(),
  text: z.string().min(1),
  to: z.string().optional(),
  date: z.string().optional(),
  linkId: z.string().optional(),
}).refine((data) => data.from || data.phoneNumber, {
  message: 'Either from or phoneNumber is required as sender',
})

const smsRoute: FastifyPluginAsync<{ prisma: PrismaClient; messenger: MessagingPort }> = async (
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
    Body: z.infer<typeof smsBodySchema>
  }>('/sms', async (request, reply) => {
    const result = smsBodySchema.safeParse(request.body)
    if (!result.success) {
      // Debug: log field names of the received body (not values)
      try {
        const body = request.body as Record<string, unknown>
        request.log.debug({ fields: Object.keys(body) }, '[SMS-INBOUND] invalid body fields')
      } catch {
        // ignore
      }
      return reply.status(200).send()
    }

    // Debug: log field names of every inbound SMS body (not values)
    request.log.debug({ fields: Object.keys(result.data) }, '[SMS-INBOUND] received')

    const { id: messageId, from, phoneNumber, text } = result.data
    const sender = (from ?? phoneNumber)!

    // Idempotency: dedupe on AT message id via webhook_events.
    // If no id is present, process without dedupe.
    if (messageId) {
      let alreadyExists = false
      try {
        await deps.prisma.webhookEvent.create({
          data: { id: messageId },
        })
      } catch {
        alreadyExists = true
      }

      if (alreadyExists) {
        return reply.status(200).send()
      }
    }

    try {
      await handleInboundSms(
        { prisma: deps.prisma, messenger: deps.messenger },
        { from: normalizePhone(sender), text, messageId: messageId ?? '' },
      )
    } catch (err) {
      // Delete dedupe row so a retry can be processed instead of being lost
      if (messageId) {
        await deps.prisma.webhookEvent.delete({ where: { id: messageId } }).catch(() => {
          // ignore delete errors
        })
      }
      request.log.error({ err, messageId, phone: sender.replace(/\d(?=\d{4})/g, '*') }, 'SMS inbound handler error')
    }

    return reply.status(200).send()
  })
}

export default smsRoute
