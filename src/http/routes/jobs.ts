import { FastifyPluginAsync } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { getEnv } from '../../config/env.js'
import { verifySecret } from '../../lib/security.js'
import { MessagingPort } from '../../modules/messaging/port.js'
import { processPendingWork } from '../../modules/bookings/service.js'

const jobsRoutes: FastifyPluginAsync<{ prisma: PrismaClient; messenger: MessagingPort }> = async (
  app,
  deps,
) => {
  app.post('/internal/jobs/process', async (request, reply) => {
    const env = getEnv()
    const suppliedSecret = request.headers['x-cron-secret']
    if (
      !env.CRON_SECRET ||
      typeof suppliedSecret !== 'string' ||
      !verifySecret(suppliedSecret, env.CRON_SECRET)
    ) {
      return reply.status(404).send()
    }

    const result = await processPendingWork(deps)
    return reply.status(200).send(result)
  })
}

export default jobsRoutes
