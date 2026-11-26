import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AfricasTalkingMessenger } from '../../src/modules/messaging/africastalking.js'
import { getEnv } from '../../src/config/env.js'

vi.mock('../../src/config/env.js', () => ({
  getEnv: vi.fn(),
}))

vi.mock('africastalking', () => {
  const mockSend = vi.fn()
  return {
    default: vi.fn(() => ({
      SMS: {
        send: mockSend,
      },
    })),
    __mockSend: mockSend,
  }
})

import { __mockSend } from 'africastalking'

describe('AfricasTalkingMessenger', () => {
  const validEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://coastride:coastride@localhost:5432/coastride',
    TEST_DATABASE_URL: 'postgresql://coastride:coastride@localhost:5433/coastride_test',
    PORT: '3000',
    WEBHOOK_SECRET: 'valid-test-secret-123456789012345678901234',
    AT_ENABLED: 'true',
    AT_USERNAME: 'sandbox',
    AT_API_KEY: 'test-api-key',
    SEED_DRIVER_PHONES: '+254700000001,+254700000002,+254700000003,+254700000004',
    LOG_LEVEL: 'info',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getEnv as unknown as ReturnType<typeof vi.fn>).mockReturnValue(validEnv)
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('sends SMS and returns providerId on success', async () => {
    __mockSend.mockResolvedValue({
      SMSMessageData: {
        Recipients: [
          {
            number: '+254700000001',
            status: 'Success',
            statusCode: 101,
            messageId: 'AT-msg-123',
            cost: 'KES 0.8000',
          },
        ],
      },
    })

    const messenger = new AfricasTalkingMessenger()
    const result = await messenger.sendSms({
      to: '+254700000001',
      message: 'Test message',
      bookingId: 'booking-123',
    })

    expect(result).toEqual({ providerId: 'AT-msg-123' })
    expect(__mockSend).toHaveBeenCalledWith({
      to: ['+254700000001'],
      message: 'Test message',
    })
  })


  it('accepts a queued provider response (statusCode 102)', async () => {
    __mockSend.mockResolvedValue({
      SMSMessageData: {
        Recipients: [{
          number: '+254700000001',
          status: 'Queued',
          statusCode: 102,
          messageId: 'AT-msg-queued',
          cost: 'KES 0.8000',
        }],
      },
    })

    const messenger = new AfricasTalkingMessenger()
    await expect(messenger.sendSms({
      to: '+254700000001',
      message: 'Test message',
    })).resolves.toEqual({ providerId: 'AT-msg-queued' })
  })

  it('throws when recipient list is empty', async () => {
    __mockSend.mockResolvedValue({
      SMSMessageData: {
        Recipients: [],
      },
    })

    const messenger = new AfricasTalkingMessenger()
    await expect(
      messenger.sendSms({
        to: '+254700000001',
        message: 'Test message',
      })
    ).rejects.toThrow("No recipients in Africa's Talking response")
  })

  it('throws when statusCode indicates failure', async () => {
    __mockSend.mockResolvedValue({
      SMSMessageData: {
        Recipients: [
          {
            number: '+254700000001',
            status: 'Failed',
            statusCode: 403,
            messageId: 'AT-msg-123',
            cost: 'KES 0.8000',
          },
        ],
      },
    })

    const messenger = new AfricasTalkingMessenger()
    await expect(
      messenger.sendSms({
        to: '+254700000001',
        message: 'Test message',
      })
    ).rejects.toThrow("Africa's Talking send failed")
  })

  it('throws when SDK throws an error', async () => {
    __mockSend.mockRejectedValue(new Error('Network error'))

    const messenger = new AfricasTalkingMessenger()
    await expect(
      messenger.sendSms({
        to: '+254700000001',
        message: 'Test message',
      })
    ).rejects.toThrow('Network error')
  })

  it('omits from parameter in send call', async () => {
    __mockSend.mockResolvedValue({
      SMSMessageData: {
        Recipients: [
          {
            number: '+254700000001',
            status: 'Success',
            statusCode: 101,
            messageId: 'AT-msg-123',
            cost: 'KES 0.8000',
          },
        ],
      },
    })

    const messenger = new AfricasTalkingMessenger()
    await messenger.sendSms({
      to: '+254700000001',
      message: 'Test message',
    })

    const callArgs = __mockSend.mock.calls[0][0]
    expect(callArgs).not.toHaveProperty('from')
    expect(callArgs.to).toEqual(['+254700000001'])
  })
})