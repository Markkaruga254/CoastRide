import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'
import { resetRateLimits } from '../../src/lib/rateLimit.js'

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL })
const messenger = new FakeMessenger()
const secret = process.env.CRON_SECRET ?? ''

describe('scheduled backend recovery endpoint', () => {
  beforeEach(() => resetRateLimits())
  afterAll(async () => prisma.$disconnect())

  it('rejects requests without the cron secret', async () => {
    const app = buildApp({ prisma, messenger })
    const response = await app.inject({
      method: 'POST',
      url: '/internal/jobs/process',
      headers: { 'x-cron-secret': 'wrong-secret' },
    })
    expect(response.statusCode).toBe(404)
    await app.close()
  })

  it('runs recovery work for an authenticated scheduler', async () => {
    expect(secret.length).toBeGreaterThanOrEqual(24)
    const app = buildApp({ prisma, messenger })
    const response = await app.inject({
      method: 'POST',
      url: '/internal/jobs/process',
      headers: { 'x-cron-secret': secret },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      expiredOffers: 0,
      retriedBookings: 0,
      dispatchedMessages: 0,
    })
    await app.close()
  })
})
