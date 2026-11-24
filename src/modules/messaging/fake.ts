import { MessagingPort } from './port.js'

export class FakeMessenger implements MessagingPort {
  public readonly sent: Array<{
    to: string
    message: string
    bookingId?: string
  }> = []

  async sendSms(input: {
    to: string
    message: string
    bookingId?: string
  }): Promise<{ providerId?: string }> {
    this.sent.push(input)
    return { providerId: `fake-${crypto.randomUUID()}` }
  }
}
