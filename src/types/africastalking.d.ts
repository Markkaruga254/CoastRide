declare module 'africastalking' {
  interface AfricasTalkingOptions {
    apiKey: string
    username: string
  }

  interface SMSRecipient {
    number: string
    status: string
    statusCode: number
    messageId: string
    cost: string
  }

  interface SMSMessageData {
    Recipients: SMSRecipient[]
  }

  interface SMSSendResponse {
    SMSMessageData: SMSMessageData
  }

  interface SMS {
    send(options: { to: string[]; message: string; from?: string }): Promise<SMSSendResponse>
  }

  interface AfricasTalking {
    SMS: SMS
  }

  function AfricasTalking(options: AfricasTalkingOptions): AfricasTalking

  export default AfricasTalking
}