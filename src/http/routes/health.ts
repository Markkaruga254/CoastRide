import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient } from '@prisma/client'

const healthRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (app, { prisma }) => {
  app.get('/health', async () => ({ status: 'ok' }))

  app.get<{
    Reply: { status: string; db?: string }
  }>('/health/ready', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return { status: 'ok', db: 'ok' }
    } catch {
      reply.status(503)
      return { status: 'degraded' }
    }
  })
}

export default healthRoutes;
