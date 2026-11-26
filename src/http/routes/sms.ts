import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { Prisma, PrismaClient } from '@prisma/client'
import { getEnv } from '../../config/env.js'
import { verifySecret } from '../../lib/security.js'
import { allowRateLimit } from '../../lib/rateLimit.js'
import { MessagingPort } from '../../modules/messaging/port.js'
import { handleInboundSms } from '../../modules/sms-inbound/service.js'
import { normalizePhone } from '../../lib/phone.js'

const smsBodySchema = z.object({
  id: z.string().min(1).max(256).optional(),
  from: z.string().min(1).max(32).optional(),
  phoneNumber: z.string().min(1).max(32).optional(),
  text: z.string().min(1).max(1_000),
  to: z.string().max(32).optional(),
  date: z.string().max(64).optional(),
  linkId: z.string().max(256).optional(),
}).refine((data) => data.from || data.phoneNumber, {
  message: 'Either from or phoneNumber is required as sender',
})

function isDuplicateWebhook(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

const smsRoute: FastifyPluginAsync<{ prisma: PrismaClient; messenger: MessagingPort }> = async (
  app,
  deps,
) => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const env = getEnv()
    const params = request.params as { secret: string }
    if (!verifySecret(params.secret, env.WEBHOOK_SECRET)) {
      return reply.status(404).send()
    }
    if (!allowRateLimit(`sms:${request.ip}`, 120, 60_000)) {
      return reply.status(429).send()
    }
  })

  app.post<{
    Params: { secret: string }
    Body: z.infer<typeof smsBodySchema>
  }>('/sms', async (request, reply) => {
    const result = smsBodySchema.safeParse(request.body)
    if (!result.success) {
      request.log.warn({ issues: result.error.issues.map((issue) => issue.path) }, '[SMS-INBOUND] invalid payload')
      return reply.status(200).send()
    }

    const { id: messageId, from, phoneNumber, text } = result.data
    const sender = (from ?? phoneNumber)!

    if (messageId) {
      try {
        await deps.prisma.webhookEvent.create({ data: { id: messageId } })
      } catch (error) {
        if (isDuplicateWebhook(error)) return reply.status(200).send()
        throw error
      }
    }

    try {
      await handleInboundSms(
        { prisma: deps.prisma, messenger: deps.messenger },
        { from: normalizePhone(sender), text, messageId: messageId ?? '' },
      )
    } catch (err) {
      if (messageId) {
        await deps.prisma.webhookEvent.delete({ where: { id: messageId } }).catch((deleteError) => {
          request.log.error({ err: deleteError, messageId }, 'failed to release SMS webhook deduplication key')
        })
      }
      request.log.error(
        { err, messageId, phone: sender.replace(/\d(?=\d{4})/g, '*') },
        'SMS inbound processing failed; provider retry is required',
      )
      return reply.status(500).send()
    }

    return reply.status(200).send()
  })
}

export default smsRoute
