#!/usr/bin/env tsx
import 'dotenv/config'
import { AfricasTalkingMessenger } from '../src/modules/messaging/africastalking.js'
import { getEnv } from '../src/config/env.js'

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 2) {
    console.error('Usage: npm run smoke:sms -- <phone> "<message>"')
    process.exit(1)
  }

  const [phone, message] = args

  const env = getEnv()
  if (!env.AT_ENABLED) {
    console.error('Error: AT_ENABLED must be true')
    process.exit(1)
  }
  if (!env.AT_USERNAME || !env.AT_API_KEY) {
    console.error('Error: AT_USERNAME and AT_API_KEY must be set')
    process.exit(1)
  }

  const messenger = new AfricasTalkingMessenger()

  try {
    const result = await messenger.sendSms({ to: phone, message })
    console.log('SMS sent successfully:', result)
  } catch (error) {
    const err = error as Error
    console.error('Failed to send SMS:', err.message)
    process.exit(1)
  }
}

main()