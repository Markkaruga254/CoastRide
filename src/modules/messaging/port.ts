export interface MessagingPort {
  sendSms(input: {
    to: string
    message: string
    bookingId?: string
  }): Promise<{ providerId?: string }>
}
