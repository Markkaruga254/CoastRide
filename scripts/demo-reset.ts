#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function parseArgs(): { yes: boolean } {
  const args = process.argv.slice(2)
  return { yes: args.includes('--yes') }
}

function getDbInfo(): { host: string; name: string } {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || ''
  try {
    const u = new URL(url)
    const host = u.hostname
    const name = u.pathname.slice(1)
    return { host, name }
  } catch {
    return { host: 'unknown', name: 'unknown' }
  }
}

async function main() {
  const { yes } = parseArgs()

  if (!yes) {
    console.error('Error: this operation is destructive. Re-run with --yes to confirm.')
    process.exit(1)
  }

  const nodeEnv = process.env.NODE_ENV
  const allowDemoReset = process.env.ALLOW_DEMO_RESET

  if (nodeEnv === 'production' && allowDemoReset !== 'true') {
    console.error('Error: demo reset is not allowed in production. Set ALLOW_DEMO_RESET=true to override.')
    process.exit(1)
  }

  const { host, name } = getDbInfo()
  console.log(`Database: ${host}/${name}`)

  try {
    const result = await prisma.$transaction(async (tx) => {
      const deleted = {
        Message: 0,
        TripEvent: 0,
        BookingDecline: 0,
        WebhookEvent: 0,
        Booking: 0,
      }

      deleted.Message = (await tx.message.deleteMany({})).count
      deleted.TripEvent = (await tx.tripEvent.deleteMany({})).count
      deleted.BookingDecline = (await tx.bookingDecline.deleteMany({})).count
      deleted.WebhookEvent = (await tx.webhookEvent.deleteMany({})).count
      deleted.Booking = (await tx.booking.deleteMany({})).count

      return deleted
    })

    console.log('Rows deleted:')
    console.log(`  Message: ${result.Message}`)
    console.log(`  TripEvent: ${result.TripEvent}`)
    console.log(`  BookingDecline: ${result.BookingDecline}`)
    console.log(`  WebhookEvent: ${result.WebhookEvent}`)
    console.log(`  Booking: ${result.Booking}`)
  } finally {
    await prisma.$disconnect()
  }
}

main()