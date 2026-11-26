import { describe, it, expect, beforeEach } from 'vitest'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'
import { redactSecret } from '../../src/http/server.js'
import { Writable } from 'node:stream'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})
const messenger = new FakeMessenger()

// Use the actual secret from the environment (set in .env)
const SECRET = process.env.WEBHOOK_SECRET || 'fc0e113be1bd6451921044b0b61a8934'

describe('secret redaction in logs', () => {
  it('redactSecret replaces secret with [redacted] in URL', () => {
    const url = `/webhooks/${SECRET}/echo`
    const redacted = redactSecret(url, SECRET)
    expect(redacted).toBe('/webhooks/[redacted]/echo')
    expect(redacted).not.toContain(SECRET)
  })

  it('logger redacts webhook secret in URL', async () => {
    // Create a custom stream to capture logs
    const chunks: Buffer[] = []
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })

    const app = buildApp({ prisma, messenger }, { isTest: false, logStream })

    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/echo`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'test=data',
    })
    expect(res.statusCode).toBe(200)

    // Closing the app flushes Fastify/Pino request logs to the supplied stream.
    await app.close()

    const logText = Buffer.concat(chunks).toString('utf8')
    expect(logText).not.toContain(SECRET)
    expect(logText).toContain('/webhooks/[redacted]/')
  })
})

describe('webhook form body and error handling', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = buildApp({ prisma, messenger })
  })

  it('echo returns 200 with form-encoded body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/echo`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'sessionId=abc&phoneNumber=%2B254700000001&text=1',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('ok')
  })

  it('echo returns 404 with wrong secret and form-encoded body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wrong-secret/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'sessionId=abc&phoneNumber=%2B254700000001&text=1',
    })
    expect(res.statusCode).toBe(404)
  })

  it('malformed JSON returns 400 with standard error shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/${SECRET}/echo`,
      headers: { 'content-type': 'application/json' },
      body: '{not valid json}',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) } })
  })

  it('rate limit: more than limit within window returns 429', async () => {
    const url = `/webhooks/${SECRET}/echo`
    const results = []
    for (let i = 0; i < 70; i++) {
      const res = await app.inject({
        method: 'POST',
        url,
        body: { test: i },
      })
      results.push(res.statusCode)
    }
    const limited = results.filter((c) => c === 429).length
    expect(limited).toBeGreaterThan(0)
  })
})

describe('placeholder secret rejection', () => {
  it('rejects WEBHOOK_SECRET containing "change-me"', async () => {
    const { envSchema } = await import('../../src/config/env.js')
    expect(() => {
      envSchema.parse({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://coastride:coastride@localhost:5432/coastride',
        TEST_DATABASE_URL: 'postgresql://coastride:coastride@localhost:5433/coastride_test',
        PORT: '3000',
        WEBHOOK_SECRET: 'change-me-in-production-secret',
        AT_ENABLED: 'false',
        AT_USERNAME: '',
        AT_API_KEY: '',
        SEED_DRIVER_PHONES: '+254700000001,+254700000002,+254700000003,+254700000004',
        LOG_LEVEL: 'info',
      })
    }).toThrow(/WEBHOOK_SECRET must not contain placeholder values/)
  })

  it('rejects WEBHOOK_SECRET containing "REPLACE_ME"', async () => {
    const { envSchema } = await import('../../src/config/env.js')
    expect(() => {
      envSchema.parse({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://coastride:coastride@localhost:5432/coastride',
        TEST_DATABASE_URL: 'postgresql://coastride:coastride@localhost:5433/coastride_test',
        PORT: '3000',
        WEBHOOK_SECRET: 'REPLACE_ME_with_openssl_rand_hex_16',
        AT_ENABLED: 'false',
        AT_USERNAME: '',
        AT_API_KEY: '',
        SEED_DRIVER_PHONES: '+254700000001,+254700000002,+254700000003,+254700000004',
        LOG_LEVEL: 'info',
      })
    }).toThrow(/WEBHOOK_SECRET must not contain placeholder values/)
  })
})