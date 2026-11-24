import { describe, it, expect, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { selectNextDriver } from '../../src/modules/drivers/selection.js'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})

const DRIVERS = [
  { name: 'Alice Wanjiku', phone: '+254700000001', plate: 'KBA 123A', vehicle: 'Toyota Noah' },
  { name: 'Brian Otieno', phone: '+254700000002', plate: 'KBC 456B', vehicle: 'Toyota Voxy' },
  { name: 'Catherine Njeri', phone: '+254700000003', plate: 'KBD 789C', vehicle: 'Toyota Hiace' },
  { name: 'David Omondi', phone: '+254700000004', plate: 'KBE 012D', vehicle: 'Toyota Wish' },
]

async function seedDrivers() {
  await prisma.driver.createMany({ data: DRIVERS, skipDuplicates: true })
  return prisma.driver.findMany({ orderBy: { id: 'asc' } })
}

async function decline(driverId: string, bookingId: string) {
  await prisma.bookingDecline.create({ data: { bookingId, driverId, reason: 'declined' } })
}

beforeEach(async () => {
  await prisma.driver.createMany({ data: DRIVERS, skipDuplicates: true })
})

describe('driver selection', () => {
  it('picks the active driver with the lowest id', async () => {
    const drivers = await seedDrivers()
    const booking = await prisma.booking.create({
      data: {
        ref: 'CR0001',
        passengerPhone: '+254700000010',
        pickupPoint: 'MIA',
        pickupAt: new Date('2026-11-24T14:30:00Z'),
        destination: 'Westlands',
        partySize: 2,
      },
    })
    const selected = await selectNextDriver(prisma, booking.id)
    expect(selected?.id).toBe(drivers[0].id)
    expect(selected?.name).toBe(drivers[0].name)
  })

  it('skips drivers who already declined for this booking', async () => {
    const drivers = await seedDrivers()
    const booking = await prisma.booking.create({
      data: {
        ref: 'CR0002',
        passengerPhone: '+254700000010',
        pickupPoint: 'MIA',
        pickupAt: new Date('2026-11-24T14:30:00Z'),
        destination: 'Westlands',
        partySize: 2,
      },
    })
    await decline(drivers[0].id, booking.id)
    await decline(drivers[1].id, booking.id)

    const selected = await selectNextDriver(prisma, booking.id)
    expect(selected?.id).toBe(drivers[2].id)
  })

  it('returns null when no drivers are left', async () => {
    const drivers = await seedDrivers()
    const booking = await prisma.booking.create({
      data: {
        ref: 'CR0003',
        passengerPhone: '+254700000010',
        pickupPoint: 'MIA',
        pickupAt: new Date('2026-11-24T14:30:00Z'),
        destination: 'Westlands',
        partySize: 2,
      },
    })
    for (const d of drivers) {
      await decline(d.id, booking.id)
    }
    const selected = await selectNextDriver(prisma, booking.id)
    expect(selected).toBeNull()
  })

  it('does not skip decliners from a different booking', async () => {
    const drivers = await seedDrivers()
    const bookingA = await prisma.booking.create({
      data: {
        ref: 'CR0004',
        passengerPhone: '+254700000010',
        pickupPoint: 'MIA',
        pickupAt: new Date('2026-11-24T14:30:00Z'),
        destination: 'Westlands',
        partySize: 2,
      },
    })
    const bookingB = await prisma.booking.create({
      data: {
        ref: 'CR0005',
        passengerPhone: '+254700000011',
        pickupPoint: 'SGR',
        pickupAt: new Date('2026-11-24T15:00:00Z'),
        destination: 'Westlands',
        partySize: 2,
      },
    })
    await decline(drivers[0].id, bookingA.id)
    // driver 0 declined for bookingA but should still be selectable for bookingB
    const selected = await selectNextDriver(prisma, bookingB.id)
    expect(selected?.id).toBe(drivers[0].id)
  })
})
