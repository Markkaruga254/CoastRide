# Africa's Talking notes (source of truth for Phase 2)

Items marked **CONFIRMED** come from AT documentation and sample code. Items marked **VERIFY** must be checked against a real sandbox request before being relied on. When the sandbox shows something different from this file, the sandbox wins: update this file and tell the human.

## Sandbox
- Username is always `sandbox`. The API key is generated inside the sandbox app. Both come from env (`AT_USERNAME`, `AT_API_KEY`). Never commit them.
- The sandbox needs no sender ID: omit `from` when sending SMS.
- SMS and USSD are exercised through the dashboard simulator, not real phones. Voice is not available in the sandbox.
- Callback URLs are set in the dashboard (USSD service code and SMS callback settings), and must be public HTTPS (ngrok in dev).

## USSD callback (CONFIRMED)
- AT sends `POST` with `application/x-www-form-urlencoded` fields: `sessionId`, `serviceCode`, `phoneNumber` (E.164), `networkCode`, `text`.
- `text` is empty on the first request. After that it is the chain of all inputs so far, joined with `*` (for example `1*2*KQ100`). The latest input is the last element. Because `text` carries the whole history, the USSD handler can be **stateless**; no session table is needed.
- The response body must be plain text starting with `CON ` (keep the session open and show this screen) or `END ` (show this and close).
- A non-2xx response or a body that does not start with `CON` or `END` makes AT terminate the session.
- Sessions are time limited (roughly 20-180 seconds depending on the operator), so respond fast and never wait on outbound SMS.
- AT can send an optional end-of-session notification to a separate callback URL (fields include `date`, `sessionId`, `serviceCode`, `networkCode`, `status`). Not needed for the MVP; if received, return 200 and ignore it.

## Send SMS (Node SDK `africastalking`)
- Init: `AfricasTalking({ apiKey, username })`, then `.SMS.send({ to: ['+2547...'], message })`. **VERIFY** the exact response shape on the first real send: log the full response once, paste it into this file, then base success/failure handling on it. Until then: treat a thrown error as failure, and a missing recipient entry as failure.

## Inbound SMS callback (VERIFY)
- Expected: `POST` form-encoded with fields such as `from`, `to`, `text`, `date`, `id`, `linkId`. Use the Phase 2 echo endpoint to log the real raw body, then confirm field names here.
- Respond `200` with an empty body quickly.

## Security (design decision, not an AT feature)
- AT callbacks are not signed. Protect webhooks with a secret path segment (`/webhooks/<WEBHOOK_SECRET>/...`), compare it in constant time, and return 404 on mismatch. Add rate limiting and Zod validation. Never log full phone numbers or message bodies at info level.

## Send SMS response (CONFIRMED against the sandbox, 25 Nov 2026)
- Shape: SMSMessageData.Message (summary string) and SMSMessageData.Recipients[], each with { number, cost, messageId, status, statusCode }.
- Observed success: status "Success", statusCode 101, messageId starting "ATXid_".
- HTTP success does not mean delivery success: a recipient can come back with a non-Success status. The adapter must treat any recipient whose status is not "Success" as a failure and throw.
