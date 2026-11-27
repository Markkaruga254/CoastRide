import fastify, { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { getEnv } from '../config/env.js'
import { MessagingPort } from '../modules/messaging/port.js'
import { FakeMessenger } from '../modules/messaging/fake.js'
import { AfricasTalkingMessenger } from '../modules/messaging/africastalking.js'
import { errorHandler } from './error.js'
import healthRoutes from './routes/health.js'
import bookingsRoutes from './routes/bookings.js'
import webhooksRoutes from './routes/webhooks.js'
import ussdRoutes from './routes/ussd.js'
import smsRoutes from './routes/sms.js'
import jobsRoutes from './routes/jobs.js'

function parseFormBody(payload: string | Buffer): Record<string, string> {
  const payloadStr = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
  const params = new URLSearchParams(payloadStr)
  const result: Record<string, string> = {}
  for (const [key, value] of params) {
    result[key] = value
  }
  return result
}

export function redactSecret(url: string, secret: string): string {
  if (!secret) return url
  // Match /webhooks/<secret>/ and replace with /webhooks/[redacted]/
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return url.replace(new RegExp(`/webhooks/${escaped}/`), '/webhooks/[redacted]/')
}

export function buildApp(
  deps: { prisma: PrismaClient; messenger: MessagingPort },
  opts: { isTest?: boolean; logStream?: NodeJS.WritableStream; logLevel?: string } = {}
): FastifyInstance {
  const env = getEnv()

  const reqSerializer = (request: FastifyRequest) => ({
    method: request.method,
    url: redactSecret(request.url, env.WEBHOOK_SECRET),
    headers: request.headers,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  })

  const errSerializer = (err: FastifyError) => ({
    type: 'Error',
    message: err.message,
    stack: err.stack ?? '',
    statusCode: err.statusCode,
  })

  const loggerOptions = {
    level: opts.logLevel ?? env.LOG_LEVEL,
    redact: {
      paths: ['req.body.*', 'req.headers.authorization', 'req.headers.cookie', 'req.headers.x-cron-secret'],
      censor: '[REDACTED]',
    },
    serializers: {
      req: reqSerializer,
      err: errSerializer,
    },
  }

  const logger = opts.isTest
    ? false
    : {
        ...loggerOptions,
        ...(opts.logStream ? { stream: opts.logStream } : {}),
      }

  const app = fastify({ logger }) as FastifyInstance

  // Emit a structured completion record without logging request bodies.
  app.addHook('onResponse', (request, reply, done) => {
    request.log.info({ req: request, statusCode: reply.statusCode }, 'request completed')
    done()
  })

  // Add content type parser for form-urlencoded
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, function (request, payload, done) {
    try {
      const result = parseFormBody(payload)
      done(null, result)
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  app.setErrorHandler(errorHandler as (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => void)
  app.register(healthRoutes)
  app.register(webhooksRoutes)
  app.register(ussdRoutes, { prefix: '/webhooks/:secret', ...deps })
  app.register(smsRoutes, { prefix: '/webhooks/:secret', ...deps })
  app.register(jobsRoutes, deps)
  if (env.NODE_ENV !== 'production') {
    app.register(bookingsRoutes, deps)
  }
  return app
}

let activeApp: FastifyInstance | null = null

export async function listen(
  port?: number,
  callback?: (err: Error | null, address: string) => void,
): Promise<string> {
  const env = getEnv()
  const prisma = new PrismaClient()
  const messenger = env.AT_ENABLED ? new AfricasTalkingMessenger() : new FakeMessenger()
  const app = buildApp({ prisma, messenger }, { isTest: false })
  app.addHook('onClose', async () => prisma.$disconnect())
  activeApp = app
  const target = port ?? env.PORT
  const host = env.HOST

  try {
    const address = await app.listen({ port: target, host })
    app.log.info(`listening on ${host}:${target}`)
    callback?.(null, address)
    return address
  } catch (error) {
    app.log.error({ err: error }, 'failed to start CoastRide API')
    callback?.(error as Error, '')
    activeApp = null
    await prisma.$disconnect()
    throw error
  }
}

export async function closeServer(): Promise<void> {
  if (!activeApp) return
  const app = activeApp
  activeApp = null
  await app.close()
}

const self = fileURLToPath(import.meta.url)
const invokedScript = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedScript === self) {
  void listen().catch((error) => {
    console.error('CoastRide API failed to start', error)
    process.exitCode = 1
  })
}