import fastify, { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { getEnv } from '../config/env.js'
import { MessagingPort } from '../modules/messaging/port.js'
import { FakeMessenger } from '../modules/messaging/fake.js'
import { errorHandler } from './error.js'
import healthRoutes from './routes/health.js'
import bookingsRoutes from './routes/bookings.js'
import webhooksRoutes from './routes/webhooks.js'

function parseFormBody(payload: unknown): Record<string, string> {
  let payloadStr: string
  if (typeof payload === 'string') {
    payloadStr = payload
  } else if (Buffer.isBuffer(payload)) {
    payloadStr = payload.toString('utf8')
  } else if (payload && typeof payload === 'object' && '_lightMyRequest' in payload) {
    // Fastify inject passes the Request object with _lightMyRequest.payload
    const req = payload as { _lightMyRequest?: { payload: string } }
    payloadStr = req._lightMyRequest?.payload || ''
  } else {
    payloadStr = String(payload)
  }
  const params = new URLSearchParams(payloadStr)
  const result: Record<string, string> = {}
  for (const [key, value] of params) {
    result[key] = value
  }
  return result
}

export function buildApp(deps: { prisma: PrismaClient; messenger: MessagingPort }, opts: { isTest?: boolean } = {}): FastifyInstance {
  const env = getEnv()
  const app = fastify({
    logger: opts.isTest
      ? false
      : {
          level: env.LOG_LEVEL,
          redact: {
            paths: ['req.body.*', 'req.headers.authorization', 'req.headers.cookie'],
            censor: '[REDACTED]',
          },
        },
  })

  // Add content type parser for form-urlencoded
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, async (payload: unknown) => {
    return parseFormBody(payload)
  })

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
  const app = buildApp({ prisma, messenger }, { isTest: false })
  const target = port ?? env.PORT
  app.listen({ port: target }, (err, address) => {
    if (!err) {
      app.log.info(`listening on port ${target}`)
    }
    callback?.(err, address)
  })
}

const self = new URL(import.meta.url).pathname
if (process.argv[1] === self) {
  listen()
}