import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { PrismaClient } from '@prisma/client'
import { getEnv } from '../../config/env.js'
import { verifySecret } from '../../lib/security.js'
import { MessagingPort } from '../../modules/messaging/port.js'
import { handleInboundSms } from '../../modules/sms-inbound/service.js'
import { normalizePhone } from '../../lib/phone.js'

const smsBodySchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  text: z.string().min(1),
  to: z.string().optional(),
  date: z.string().optional(),
  linkId: z.string().optional(),
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
      return reply.status(200).send()
    }

    const { id: messageId, from, text } = result.data

    // Idempotency: dedupe on AT message id via webhook_events
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

    try {
      await handleInboundSms(
        { prisma: deps.prisma, messenger: deps.messenger },
        { from: normalizePhone(from), text, messageId },
      )
    } catch (err) {
      request.log.error({ err, messageId, phone: from.replace(/\d(?=\d{4})/g, '*') }, 'SMS inbound handler error')
    }

    return reply.status(200).send()
  })
}

export default smsRoute
