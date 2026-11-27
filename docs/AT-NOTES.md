# Africa's Talking notes (source of truth for Phase 2)

Items marked **CONFIRMED** come from AT documentation and sample code. Items marked **VERIFY** must be checked against a real sandbox request before being relied on. When the sandbox shows something different from this file, the sandbox wins: update this file and tell the human.

## Sandbox
- Username is always `sandbox`. The API key is generated inside the sandbox app. Both come from env (`AT_USERNAME`, `AT_API_KEY`). Never commit them.
- The sandbox needs no sender ID: omit `from` when sending SMS.
- SMS and USSD are exercised through the dashboard simulator, not real phones. Voice is not available in the sandbox.
- Callback URLs are set in the dashboard (USSD service code and SMS callback settings), and must be public HTTPS (ngrok in dev).

## USSD callback (CONFIRMED)
- AT sends `POST` with `application/x-www-form-urlencoded` fields: `sessionId`, `serviceCode`, `phoneNumber` (E.164), `networkCode`, `text`.
- `text` is empty on the first request. After that it is the chain of all inputs so far, joined with `*` (for example `1*2*KQ100`). The latest input is the last element. The handler is stateless and dispatches by `serviceCode`.
- The response body must be plain text starting with `CON ` (keep the session open and show this screen) or `END ` (show this and close).
- A non-2xx response or a body that does not start with `CON` or `END` makes AT terminate the session.
- Sessions are time limited (roughly 20-180 seconds depending on the operator), so respond fast and never wait on outbound SMS.
- Passenger code: `*384*43639#`. Driver code: `*384*78088#`. Both use the same callback URL; the backend routes them independently.
- Driver USSD requires the caller number to match an active `Driver` record. The sandbox simulator number is not automatically provisioned as a driver.

## Send SMS (native fetch adapter)
- The backend uses `src/modules/messaging/africastalking.ts`, not the Node SDK.
- Sandbox endpoint: `https://api.sandbox.africastalking.com/version1/messaging` when `AT_USERNAME=sandbox`; live endpoint is selected for a non-sandbox username.
- A recipient response is accepted for processing when its status code is 100, 101, or 102. The provider response includes recipient status and a provider message ID. Keep the ID in `Message.providerId`.
- A database status of `sent` means accepted by the provider; it does not prove handset delivery. Delivery-report callbacks are not yet wired into CoastRide.

## Inbound SMS callback (VERIFY)
- Expected: `POST` form-encoded with fields such as `from`, `to`, `text`, `date`, `id`, `linkId`. Use the Phase 2 echo endpoint to log the real raw body, then confirm field names here.
- Respond `200` with an empty body quickly.

## Security (design decision, not an AT feature)
- AT callbacks are not signed. Protect webhooks with a secret path segment (`/webhooks/<WEBHOOK_SECRET>/...`), compare it in constant time, and return 404 on mismatch. Add rate limiting and Zod validation. Never log full phone numbers or message bodies at info level.

## Send SMS response (CONFIRMED against the sandbox, 25 Nov 2026)
- Shape: `SMSMessageData.Message` (summary string) and `SMSMessageData.Recipients[]`, each with `number`, `cost`, `messageId`, `status`, and `statusCode`.
- Observed success: status `Success`, statusCode `101`, messageId starting `ATXid_`.
- HTTP success does not mean delivery success: a recipient can come back with a non-success status. The adapter treats provider status codes outside 100, 101, and 102 as failures.
