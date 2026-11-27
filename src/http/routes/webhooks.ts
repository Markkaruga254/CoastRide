import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { getEnv } from '../../config/env.js'
import { verifySecret, maskPhone } from '../../lib/security.js'
import { allowRateLimit } from '../../lib/rateLimit.js'

const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const env = getEnv()
    const params = request.params as { secret: string }
    if (!verifySecret(params.secret, env.WEBHOOK_SECRET)) {
      return reply.status(404).send()
    }
  })

  app.post('/webhooks/:secret/echo', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!allowRateLimit(`echo:${request.ip}`, 60, 60_000)) {
      return reply.status(429).send({ error: 'rate limited' })
    }

    const body = request.body as Record<string, string>
    const maskedBody = { ...body }
    if (maskedBody.phoneNumber) maskedBody.phoneNumber = maskPhone(maskedBody.phoneNumber)
    if (maskedBody.from) maskedBody.from = maskPhone(maskedBody.from)
    if (maskedBody.to) maskedBody.to = maskPhone(maskedBody.to)

    request.log.debug({ body: maskedBody }, 'echo webhook received')
    return 'ok'
  })
}

export default webhookRoutes
