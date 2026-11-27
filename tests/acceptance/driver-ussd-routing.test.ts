import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../src/http/server.js'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL })
const messenger = new FakeMessenger()
const secret = process.env.WEBHOOK_SECRET || 'fc0e113be1bd6451921044b0b61a8934'

describe('USSD service-code routing', () => {
  beforeEach(() => {
    messenger.sent.length = 0
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('routes the configured driver code to the driver menu', async () => {
    await prisma.driver.create({
      data: {
        name: 'Sandbox Driver',
        phone: '+254100314202',
        plate: 'KCA 123A',
        vehicle: 'Toyota Noah',
      },
    })
    const app = buildApp({ prisma, messenger })
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/${secret}/ussd`,
      payload: {
        sessionId: 'driver-route-session',
        serviceCode: '*384*78088#',
        phoneNumber: '+254100314202',
        text: '',
      },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.body).toContain('CoastRide Driver')
    expect(response.body).toContain('1. View current trip')
  })

  it('keeps the passenger service code on the existing passenger menu', async () => {
    const app = buildApp({ prisma, messenger })
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/${secret}/ussd`,
      payload: {
        sessionId: 'passenger-route-session',
        serviceCode: '*384*43639#',
        phoneNumber: '+254700000010',
        text: '',
      },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Welcome to CoastRide')
    expect(response.body).not.toContain('CoastRide Driver')
  })

  it('does not silently route an unknown service code to passenger booking', async () => {
    const app = buildApp({ prisma, messenger })
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/${secret}/ussd`,
      payload: {
        sessionId: 'unknown-route-session',
        serviceCode: '*384*99999#',
        phoneNumber: '+254700000010',
        text: '',
      },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('service code is not configured')
  })
})
