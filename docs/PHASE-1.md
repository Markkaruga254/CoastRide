# PHASE 1: Foundation and domain core (no Africa's Talking yet)

Time box: 11:00-13:00. Read `docs/SPEC.md` and `.kilocode/rules/rules.md` first.

## Goal
A running API where a booking can move through the full trip lifecycle, with every outbound SMS captured by a fake messenger. No real network calls to Africa's Talking.

## Tasks (do in this order; commit after each)

### 1. Scaffold
- TypeScript strict, ESM, Fastify, pino, Zod, Prisma, Vitest, ESLint + Prettier
- `src/config/env.ts`: Zod-validated env (`DATABASE_URL`, `PORT`, `WEBHOOK_SECRET`, `LOG_LEVEL`)
- Scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `db:migrate`, `db:seed`
- `docker-compose.yml`: Postgres 16 + the app; `.env.example`
- `GET /health` returns `{ status: "ok" }`

### 2. Schema and seed
- Prisma schema exactly per SPEC data model; first migration committed
- `db:seed`: 4 drivers (names, plates, phones as placeholders read from `SEED_DRIVER_PHONES` env, comma-separated, falling back to dummy +2547 numbers)

### 3. Trip state machine (`src/modules/trips/stateMachine.ts`)
- Transition table per SPEC; pure function `applyEvent(state, event) -> newState` or throws `IllegalTransitionError`
- `PICKUP_DELAYED` leaves state unchanged and is only allowed in REQUESTED/OFFERED/CONFIRMED
- Unit tests: every valid transition, at least 8 illegal transitions, delay allowed/denied cases

### 4. Messaging
- `MessagingPort` interface and `FakeMessenger` (stores sent messages in memory and writes to `messages` table)
- `templates.ts`: pure functions producing SMS text for: booking confirmation, driver offer, driver confirmed (to passenger), delay (to passenger and driver), cancelled, arrived, completed, help text. Each under 160 chars.
- Unit tests for template output (snapshot or exact strings)

### 5. Services
- `createBooking`, `offerNextDriver`, `acceptOffer`, `declineOffer`, `markArrived`, `completeTrip`, `cancelBooking`, `applyDelay`
- Each runs in a DB transaction, goes through the state machine, writes a `trip_events` row, and calls the messenger
- Ref generator (`CR` + 4 digits, collision retry)
- Phone normalization helper to E.164 (Kenya: `07..`, `7..`, `+254..`, `254..`) with tests

### 6. Temporary REST API (dev and test only; this is how we exercise the core before webhooks exist)
- `POST /bookings` body: `{ passengerPhone, pickupPoint, arrivalRef, pickupAt, destination, partySize }`
- `GET /bookings/:ref`
- `POST /bookings/:ref/driver-response` body: `{ driverPhone, action: "accept" | "decline" }`
- `POST /bookings/:ref/delay` body: `{ minutes }`
- `POST /bookings/:ref/cancel`
- Zod validation on all bodies; consistent error shape `{ error: { code, message } }`

## Acceptance tests (must exist and pass)
1. Creating a booking yields state `REQUESTED` then `OFFERED` to driver 1, and the fake messenger recorded 2 SMS (passenger confirmation, driver offer).
2. Driver 1 accepts: state `CONFIRMED`, passenger receives driver name, plate, phone.
3. Driver 1 declines: booking returns to `REQUESTED`, driver 2 is offered, driver 1 is never offered again for this booking.
4. All drivers decline: state `NO_DRIVER`.
5. Delay of 90 minutes in `CONFIRMED` updates `pickup_at`, keeps state, and messages both passenger and driver.
6. `ARRIVED` then `COMPLETED` follows the legal path; `COMPLETED` then `CANCEL` throws and returns a 409.
7. A driver who is not assigned to the booking cannot accept it.
8. Phone normalization table test (at least 6 formats).

## Definition of done
`docker compose up` brings up the API and DB; `npm run lint && npm run typecheck && npm test` pass; a README section "Run Phase 1" lists the curl commands for the happy path.

## Do not build in this phase
Anything using the `africastalking` SDK, USSD or SMS webhooks, pg-boss, dashboard, rate limiting, CI.

## Final message to report
Files changed, commands to run, anything skipped, any assumption you made.
