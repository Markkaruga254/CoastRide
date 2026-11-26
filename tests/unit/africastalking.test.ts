import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AfricasTalkingMessenger } from '../../src/modules/messaging/africastalking.js'
import { getEnv } from '../../src/config/env.js'

vi.mock('../../src/config/env.js', () => ({
  getEnv: vi.fn(),
}))

describe('AfricasTalkingMessenger', () => {
  const validEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://coastride:coastride@localhost:5432/coastride',
    TEST_DATABASE_URL: 'postgresql://coastride:coastride@localhost:5433/coastride_test',
    PORT: 3000,
    WEBHOOK_SECRET: 'valid-test-secret-123456789012345678901234',
    AT_ENABLED: true,
    AT_USERNAME: 'sandbox',
    AT_API_KEY: 'test-api-key',
    CRON_SECRET: 'test-cron-secret-0123456789',
    SEED_DRIVER_PHONES: '+254700000001,+254700000002,+254700000003,+254700000004',
    LOG_LEVEL: 'info',
  }

  const successPayload = {
    SMSMessageData: {
      Recipients: [{
        number: '+254700000001',
        status: 'Success',
        statusCode: 101,
        messageId: 'AT-msg-123',
        cost: 'KES 0.8000',
      }],
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getEnv as unknown as ReturnType<typeof vi.fn>).mockReturnValue(validEnv)
  })

  it('posts URL-encoded SMS to the sandbox endpoint and returns providerId', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(successPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const messenger = new AfricasTalkingMessenger(fetchMock)

    const result = await messenger.sendSms({
      to: '+254700000001',
      message: 'Test message',
      bookingId: 'booking-123',
    })

    expect(result).toEqual({ providerId: 'AT-msg-123' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.sandbox.africastalking.com/version1/messaging')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('apiKey')).toBe('test-api-key')
    expect(new Headers(init?.headers).get('content-type')).toContain('application/x-www-form-urlencoded')
    const body = init?.body as URLSearchParams
    expect(body.get('username')).toBe('sandbox')
    expect(body.get('to')).toBe('+254700000001')
    expect(body.get('message')).toBe('Test message')
  })

  it('uses the live endpoint for a non-sandbox username', async () => {
    (getEnv as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...validEnv,
      AT_USERNAME: 'coastride-live',
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(successPayload), { status: 200 }),
    )

    await new AfricasTalkingMessenger(fetchMock).sendSms({
      to: '+254700000001',
      message: 'Live test',
    })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.africastalking.com/version1/messaging')
  })

  it.each([100, 101, 102])('accepts provider status code %s', async (statusCode) => {
    const payload = {
      SMSMessageData: {
        Recipients: [{ status: 'Accepted', statusCode, messageId: `AT-${statusCode}` }],
      },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }),
    )

    await expect(new AfricasTalkingMessenger(fetchMock).sendSms({
      to: '+254700000001',
      message: 'Test message',
    })).resolves.toEqual({ providerId: `AT-${statusCode}` })
  })

  it('throws when the provider returns no recipients', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ SMSMessageData: { Recipients: [] } }), { status: 200 }),
    )
    await expect(new AfricasTalkingMessenger(fetchMock).sendSms({
      to: '+254700000001',
      message: 'Test message',
    })).rejects.toThrow("No recipients in Africa's Talking response")
  })

  it('throws when the provider reports a rejected message', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        SMSMessageData: {
          Recipients: [{ status: 'Invalid Phone Number', statusCode: 403 }],
        },
      }), { status: 200 }),
    )
    await expect(new AfricasTalkingMessenger(fetchMock).sendSms({
      to: '+254700000001',
      message: 'Test message',
    })).rejects.toThrow("Africa's Talking send failed")
  })

  it('throws on HTTP errors without exposing response bodies', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('secret provider response', { status: 503 }),
    )
    await expect(new AfricasTalkingMessenger(fetchMock).sendSms({
      to: '+254700000001',
      message: 'Test message',
    })).rejects.toThrow('HTTP 503')
  })

  it('propagates network errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network error'))
    await expect(new AfricasTalkingMessenger(fetchMock).sendSms({
      to: '+254700000001',
      message: 'Test message',
    })).rejects.toThrow('Network error')
  })
})
