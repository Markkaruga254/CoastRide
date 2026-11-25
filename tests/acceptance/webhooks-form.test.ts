import { describe, it, expect, beforeEach } from 'vitest'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})
const messenger = new FakeMessenger()
let app: FastifyInstance

beforeEach(async () => {
  app = buildApp({ prisma, messenger })
})

describe('webhook form body and error handling', () => {
  const SECRET = 'change-me-in-production-secret'

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
    // Test with a low limit by making many requests
    // Note: rate limit is per IP and in-memory; this test verifies the mechanism
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
    // Should have some 429s after the limit (60 per minute per IP)
    const limited = results.filter((c) => c === 429).length
    expect(limited).toBeGreaterThan(0)
  })
})