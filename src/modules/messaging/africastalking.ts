import { MessagingPort } from './port.js'
import { getEnv } from '../../config/env.js'
import pino from 'pino'

let logger: pino.Logger | null = null
function getLogger(): pino.Logger {
  if (!logger) logger = pino({ level: getEnv().LOG_LEVEL })
  return logger
}

type Recipient = {
  number?: string
  status?: string
  statusCode?: number | string
  messageId?: string
}

type SendResponse = {
  SMSMessageData?: {
    Recipients?: Recipient[]
  }
}

/**
 * Small native-fetch adapter for Africa's Talking SMS.
 * Avoids pulling the provider SDK's HTTP/validation dependency tree into the API.
 */
export class AfricasTalkingMessenger implements MessagingPort {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sendSms(input: {
    to: string
    message: string
    bookingId?: string
  }): Promise<{ providerId?: string }> {
    const env = getEnv()
    if (!env.AT_ENABLED || !env.AT_USERNAME || !env.AT_API_KEY) {
      throw new Error("Africa's Talking is not enabled or configured")
    }

    const endpoint = env.AT_USERNAME === 'sandbox'
      ? 'https://api.sandbox.africastalking.com/version1/messaging'
      : 'https://api.africastalking.com/version1/messaging'
    const body = new URLSearchParams({
      username: env.AT_USERNAME,
      to: input.to,
      message: input.message,
    })

    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          apiKey: env.AT_API_KEY,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        throw new Error(`Africa's Talking SMS API returned HTTP ${response.status}`)
      }

      const payload = await response.json() as SendResponse
      const recipient = payload.SMSMessageData?.Recipients?.[0]
      if (!recipient) {
        throw new Error("No recipients in Africa's Talking response")
      }

      const statusCode = Number(recipient.statusCode)
      if (![100, 101, 102].includes(statusCode)) {
        throw new Error(
          `Africa's Talking send failed: ${recipient.status ?? 'unknown status'} (code ${statusCode})`,
        )
      }

      return { providerId: recipient.messageId }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown Africa\'s Talking error')
      getLogger().error(
        { message: error.message, bookingId: input.bookingId },
        '[AfricasTalking] sendSms error',
      )
      throw error
    }
  }
}
