import { PrismaClient } from '@prisma/client'
import { beforeEach, afterAll } from 'vitest'

const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
})

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Message", "TripEvent", "BookingDecline", "Booking", "Driver", "WebhookEvent" RESTART IDENTITY CASCADE`,
  )
})

afterAll(async () => {
  await prisma.$disconnect()
})
