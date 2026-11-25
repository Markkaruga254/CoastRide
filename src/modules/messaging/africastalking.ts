import { MessagingPort } from './port.js'
import { getEnv } from '../../config/env.js'
import AfricasTalking from 'africastalking'
import pino from 'pino'

let logger: pino.Logger | null = null
function getLogger(): pino.Logger {
  if (!logger) {
    logger = pino({ level: getEnv().LOG_LEVEL })
  }
  return logger
}

let loggedSdkResponse = false

export class AfricasTalkingMessenger implements MessagingPort {
  private readonly sdk: ReturnType<typeof AfricasTalking>['SMS']
  private readonly username: string

  constructor() {
    const env = getEnv()
    // AT_USERNAME and AT_API_KEY are validated as required when AT_ENABLED=true in env schema
    const username = env.AT_USERNAME as string
    const apiKey = env.AT_API_KEY as string
    this.username = username
    const at = AfricasTalking({
      apiKey,
      username,
    })
    this.sdk = at.SMS
  }

  async sendSms(input: {
    to: string
    message: string
    bookingId?: string
  }): Promise<{ providerId?: string }> {
    try {
      const response = await this.sdk.send({
        to: [input.to],
        message: input.message,
      })

      if (!loggedSdkResponse) {
        const masked = this.maskResponse(response)
        getLogger().debug({ masked }, '[AfricasTalking] send response')
        loggedSdkResponse = true
      }

      const recipients = response?.SMSMessageData?.Recipients
      if (!recipients || recipients.length === 0) {
        throw new Error('No recipients in Africa\'s Talking response')
      }

      const recipient = recipients[0]
      if (recipient.statusCode !== 101 && recipient.statusCode !== 100) {
        throw new Error(`Africa's Talking send failed: ${recipient.status} (code ${recipient.statusCode})`)
      }

      return { providerId: recipient.messageId }
    } catch (err) {
      const error = err as Error
      getLogger().error({ message: error.message, bookingId: input.bookingId }, '[AfricasTalking] sendSms error')
      throw error
    }
  }

  private maskResponse(response: unknown): unknown {
    if (!response || typeof response !== 'object') return response
    const obj = response as Record<string, unknown>
    const masked = { ...obj }
    if (masked.SMSMessageData && typeof masked.SMSMessageData === 'object') {
      const smsData = masked.SMSMessageData as Record<string, unknown>
      if (smsData.Recipients && Array.isArray(smsData.Recipients)) {
        masked.SMSMessageData = {
          ...smsData,
          Recipients: smsData.Recipients.map((r: unknown) => {
            if (!r || typeof r !== 'object') return r
            const rec = r as Record<string, unknown>
            return {
              ...rec,
              number: rec.number ? this.maskPhone(rec.number as string) : rec.number,
              messageId: rec.messageId,
              status: rec.status,
              statusCode: rec.statusCode,
              cost: rec.cost,
            }
          }),
        }
      }
    }
    return masked
  }

  private maskPhone(phone: string): string {
    if (phone.length <= 4) return '****'
    return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4)
  }
}