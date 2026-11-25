import fastify, { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { getEnv } from '../config/env.js'
import { MessagingPort } from '../modules/messaging/port.js'
import { FakeMessenger } from '../modules/messaging/fake.js'
import { errorHandler } from './error.js'
import healthRoutes from './routes/health.js'
import bookingsRoutes from './routes/bookings.js'
import webhooksRoutes from './routes/webhooks.js'

export function buildApp(deps: { prisma: PrismaClient; messenger: MessagingPort }): FastifyInstance {
  const app = fastify({ logger: false })
  app.setErrorHandler(errorHandler)
  app.register(healthRoutes)
  app.register(webhooksRoutes)
  app.register(bookingsRoutes, deps)
  return app
}

export function listen(port?: number, callback?: (err: Error | null, address: string) => void) {
  const env = getEnv()
  const prisma = new PrismaClient()
  const messenger = new FakeMessenger()
  const app = buildApp({ prisma, messenger })
  const target = port ?? env.PORT
  app.listen({ port: target }, callback ?? (() => {}))
}

const self = new URL(import.meta.url).pathname
if (process.argv[1] === self) {
  listen()
}
