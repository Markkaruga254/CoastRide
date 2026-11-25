# PHASE 2: Africa's Talking sandbox integration

Read `.kilocode/rules/rules.md`, `docs/SPEC.md`, `docs/AT-NOTES.md` and this file first. Rule 2 applies strictly: do not invent Africa's Talking behavior. Anything marked VERIFY in AT-NOTES.md must be handled defensively and reported to the human.

## Goal
Against the AT **sandbox**: a passenger books through USSD, gets a confirmation SMS, the driver is offered the trip by SMS and replies with a keyword, and the passenger is told the driver details. All existing Phase 1 tests keep passing.

## Allowed changes
- New dependency: `africastalking` (official SDK) only. Nothing else.
- One additive Prisma migration only if needed (see Task C): nullable unique `Booking.ussdSessionId`. Create it with `npx prisma migrate dev --name add_ussd_session_id`, then tell the human.
- Phase 1 REST routes are for dev only: register them only when `NODE_ENV !== 'production'`.

## Tasks (one commit each, in this order)

### A. Webhook foundation and echo endpoint
- Env: `AT_USERNAME`, `AT_API_KEY` become required when `NODE_ENV=production` or `AT_ENABLED=true`; add `AT_ENABLED` (default false) and `NODE_ENV` to the schema and `.env.example`.
- Route prefix `/webhooks/:secret/*`. A preHandler compares `:secret` to `WEBHOOK_SECRET` in constant time (`crypto.timingSafeEqual` after length check) and returns 404 on mismatch.
- Form-encoded body parsing for these routes (use Fastify's built-in capabilities or `@fastify/formbody` only if truly required; if a dependency is needed, stop and ask).
- `POST /webhooks/:secret/echo`: logs the raw body (with phone numbers masked) at debug level and returns 200 `ok`. This is used for the human's smoke test.
- Rate limit the webhook routes in a simple in-memory way (no new dependency). Tests: wrong secret returns 404, right secret returns 200.

### B. Africa's Talking SMS adapter
- `src/modules/messaging/africastalking.ts` implementing `MessagingPort` with the official SDK. No SDK import anywhere else.
- Constructed from env; omit `from`. Log the full SDK response once at debug level (masked). On a thrown error or an empty recipient list, throw so the existing dispatch code marks the row `failed`.
- Wire it so `buildApp` uses `AfricasTalkingMessenger` when `AT_ENABLED=true`, else `FakeMessenger`.
- Unit test with the SDK mocked.

### C. USSD booking flow (pure function plus webhook)
- `src/modules/ussd/handleUssd.ts`: `handleUssd({ phoneNumber, text }, deps) -> { type: 'CON' | 'END', text }`. Stateless: derive the step from `text.split('*')`.
- Menu (each screen under 160 chars, plain text):
  1. Main: `1. Airport pickup (MIA)`, `2. SGR station pickup`, `3. Check my booking`
  2. Booking path: arrival reference (flight or train number, 3-8 alphanumeric) -> arrival time as HHMM (24h) -> destination (free text, 2-40 chars, sanitized) -> party size 1-6 -> confirmation screen (`1. Confirm`, `2. Cancel`) -> on confirm create the booking and return `END Booked! Ref CR1042. We sent you an SMS.`
  3. Check my booking: ask for ref, return state and driver name and plate if assigned, else a friendly state label.
- Invalid input: re-prompt once with the same screen plus a short error line; a second invalid input on the same step returns `END Sorry, please dial again.`
- Pickup time: interpret HHMM as today in `Africa/Nairobi`; if that time has already passed, use tomorrow. Pass `now` into the function as a dependency so tests are deterministic.
- Add `ussdSessionId` migration (nullable, unique) and use it for idempotency: a retried final confirmation for the same session returns the existing booking's END message instead of creating a second booking.
- Route `POST /webhooks/:secret/ussd`: validate with Zod, normalize phone, call `handleUssd`, create the booking via the existing service, and return `text/plain`. The handler must never await SMS delivery; booking creation queues messages and dispatches after commit as in Phase 1, but the HTTP response must not wait for dispatch to finish (fire and forget with error logging).
- If anything throws, respond `200` with `END Service temporarily unavailable. Please try again.` and log the error (AT terminates the session on a non-2xx).
- Tests: every menu path, invalid input handling, time rollover to tomorrow, idempotent retry, text injection attempts (`*`, newlines, very long input).

### D. Inbound SMS keywords
- `src/modules/sms-inbound/parse.ts`: pure parser, case-insensitive, whitespace tolerant:
  - `1 <ref>` accept, `2 <ref>` decline, `ARRIVED <ref>`, `DONE <ref>`, `DELAY <minutes> <ref>`, `CANCEL <ref>`.
  - `minutes` is an integer 5-720. Refs match `^CR\d{4}$` after uppercasing.
- Authorization (in the handler, not the parser): accept, decline, ARRIVED and DONE only from the assigned driver; DELAY from the assigned driver or the booking's passenger; CANCEL only from the passenger. Anything else is ignored, logged with masked numbers, and gets no reply (do not leak whether a ref exists).
- Unknown or malformed text from a known driver gets the help SMS; from an unknown number, nothing.
- Route `POST /webhooks/:secret/sms`: validate with Zod, dedupe on the AT message `id` via `webhook_events` (insert first; if it already exists, return 200 and do nothing), normalize `from`, run the right service, return 200 with an empty body.
- Tests: each keyword, unauthorized senders, duplicate delivery, malformed text.

### E. End-to-end scenario test
- One test using FakeMessenger and Fastify `inject`: USSD booking, then SMS `2 <ref>` from the first driver (decline), then SMS `1 <ref>` from the second driver (accept), then `DELAY 90 <ref>` from the driver, then `ARRIVED`, then `DONE`. Assert states, `pickup_at`, and the exact sequence of messages sent.

### F. Docs
- `README.md`: "Connect to the Africa's Talking sandbox" section: env vars, ngrok command, the exact callback URL formats (`https://<host>/webhooks/<WEBHOOK_SECRET>/ussd` and `/sms`), and a manual test script for the simulator.

## Definition of done
`npm run lint && npm run typecheck && npm test` pass. No SDK imports outside `africastalking.ts`. No secrets in the repo. README steps work from a clean clone.

## Do not build
Voice, pg-boss, dashboard, payments, new REST features, any change to the state machine.

## Final message to report
Files changed, commands to run, the migration name if one was added, every VERIFY item you could not confirm, anything skipped.
