import { PrismaClient } from '@prisma/client'

export async function selectNextDriver(
  prisma: PrismaClient,
  bookingId: string,
): Promise<{
  id: string
  name: string
  phone: string
  plate: string
} | null> {
  const declines = await prisma.bookingDecline.findMany({
    where: { bookingId },
    select: { driverId: true },
  })
  const declinedIds = new Set(declines.map((d) => d.driverId))

  const drivers = await prisma.driver.findMany({
    where: {
      active: true,
      id: { notIn: [...declinedIds] },
      Booking: {
        none: { state: { in: ['OFFERED', 'CONFIRMED', 'ARRIVED'] } },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 1,
  })

  if (drivers.length === 0) return null
  const d = drivers[0]
  return { id: d.id, name: d.name, phone: d.phone, plate: d.plate }
}
