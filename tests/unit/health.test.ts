import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})
let app: FastifyInstance

describe.sequential('health routes', () => {
  beforeEach(async () => {
    app = buildApp({ prisma, messenger: { sendSms: async () => {} } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('GET /health returns 200 ok', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('GET /health/ready returns 200 with db ok when database is reachable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/ready',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' })
  })

  it('GET /health/ready returns 503 degraded when database is unreachable', async () => {
    // Mock $queryRaw to throw an error to simulate DB failure
    const failingPrisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('DB connection failed')),
    } as unknown as PrismaClient

    const failingApp = buildApp({ prisma: failingPrisma, messenger: { sendSms: async () => {} } })

    const res = await failingApp.inject({
      method: 'GET',
      url: '/health/ready',
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'degraded' })
  })
})