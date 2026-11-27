import { afterAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { FakeMessenger } from '../../src/modules/messaging/fake.js'
import { createBooking, offerNextDriver } from '../../src/modules/bookings/service.js'
import { handleDriverUssd } from '../../src/modules/ussd/handleDriverUssd.js'

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL })
const messenger = new FakeMessenger()
const deps = { prisma, messenger }

async function createDriver(name: string, phone: string) {
  return prisma.driver.create({
    data: { name, phone, plate: 'KCA 123A', vehicle: 'Toyota Noah' },
  })
}

async function createOfferedBooking() {
  const booking = await createBooking(deps, {
    passengerPhone: '+254700000010',
    pickupPoint: 'MIA',
    arrivalRef: 'KQ100',
    pickupAt: '2026-12-01T10:00:00.000Z',
    destination: 'Diani',
    partySize: 2,
  })
  await offerNextDriver(deps, { bookingId: booking.id })
  return prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })
}

describe('driver USSD flow', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('shows the driver menu and reports no active trip clearly', async () => {
    await createDriver('Test Driver', '+254100314202')

    const menu = await handleDriverUssd({ phoneNumber: '+254100314202', text: '' }, deps)
    expect(menu.type).toBe('CON')
    expect(menu.text).toContain('1. View current trip')

    const empty = await handleDriverUssd({ phoneNumber: '+254100314202', text: '1' }, deps)
    expect(empty.type).toBe('END')
    expect(empty.text).toContain('no active trip')
  })

  it('accepts an offer, records arrival and completes the trip without replaying actions', async () => {
    await createDriver('Test Driver', '+254100314202')
    const booking = await createOfferedBooking()

    const view = await handleDriverUssd({ phoneNumber: '+254100314202', text: '1' }, deps)
    expect(view.type).toBe('CON')
    expect(view.text).toContain(booking.ref)
    expect(view.text).toContain('1. Accept')
    expect(view.text).toContain('2. Decline')

    const accepted = await handleDriverUssd({ phoneNumber: '+254100314202', text: '1*1' }, deps)
    expect(accepted.type).toBe('END')
    expect(accepted.text).toContain('accepted')
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).state).toBe('CONFIRMED')

    // Replaying the accept selection must not be interpreted as "mark arrived".
    const replay = await handleDriverUssd({ phoneNumber: '+254100314202', text: '1*1' }, deps)
    expect(replay.text).toContain('not available')
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).state).toBe('CONFIRMED')

    const arrived = await handleDriverUssd({ phoneNumber: '+254100314202', text: '1*3' }, deps)
    expect(arrived.text).toContain('Arrival recorded')
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).state).toBe('ARRIVED')

    const completed = await handleDriverUssd({ phoneNumber: '+254100314202', text: '1*4' }, deps)
    expect(completed.text).toContain('marked complete')
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).state).toBe('COMPLETED')

    expect(messenger.sent.some((message) => message.to === '+254700000010' && message.message.includes('confirmed'))).toBe(true)
    expect(messenger.sent.some((message) => message.to === '+254700000010' && message.message.includes('has arrived'))).toBe(true)
    expect(messenger.sent.some((message) => message.to === '+254700000010' && message.message.includes('completed'))).toBe(true)
  })

  it('declines an offer and sends it to the next available driver', async () => {
    await createDriver('First Driver', '+254100314202')
    await createDriver('Second Driver', '+254100314203')
    const booking = await createOfferedBooking()

    const declined = await handleDriverUssd({ phoneNumber: '+254100314202', text: '1*2' }, deps)
    expect(declined.text).toContain('declined')

    const updated = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { driver: true },
    })
    expect(updated.state).toBe('OFFERED')
    expect(updated.driver?.phone).toBe('+254100314203')
  })

  it('does not expose driver actions to unregistered numbers', async () => {
    const response = await handleDriverUssd({ phoneNumber: '+254100314202', text: '' }, deps)
    expect(response.type).toBe('END')
    expect(response.text).toContain('not registered')
  })
})
