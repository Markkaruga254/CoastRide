# CoastRide: SPEC

Hackathon: Africa's Talking Hospitality & Tourism Hackathon, Mombasa, 27 Nov 2026.
Challenge: **CoastRide**, an airport and SGR transfer company that must coordinate drivers, passengers, pickup locations, arrival times and last-minute changes.

## One-sentence pitch
CoastRide turns every airport and SGR arrival into a coordinated pickup: passengers book by USSD, drivers manage offers and trip progress by a separate USSD code or SMS commands, and delays update everyone automatically.

## Actors
- **Passenger**: books and checks bookings via USSD (any phone, no app).
- **Driver**: receives trip offers by SMS and can accept, decline and update trip progress by SMS or the driver USSD service.
- **Dispatcher** (read-only for the MVP): watches trips on a live board.

## Trip states
`REQUESTED -> OFFERED -> CONFIRMED -> ARRIVED -> COMPLETED`, plus `CANCELLED` and `NO_DRIVER`.

| From | Event | To | Side effects |
|---|---|---|---|
| (new) | `BOOKING_CREATED` | `REQUESTED` | SMS passenger: confirmation with ref |
| `REQUESTED` | `DRIVER_OFFERED` | `OFFERED` | SMS driver: trip offer |
| `REQUESTED` | `NO_DRIVER_AVAILABLE` | `NO_DRIVER` | log event (dispatcher alert later) |
| `OFFERED` | `DRIVER_ACCEPTED` | `CONFIRMED` | SMS passenger: driver name, plate, phone |
| `OFFERED` | `DRIVER_DECLINED` / `OFFER_TIMEOUT` | `REQUESTED` | offer next driver |
| `CONFIRMED` | `DRIVER_ARRIVED` | `ARRIVED` | SMS passenger |
| `ARRIVED` | `TRIP_COMPLETED` | `COMPLETED` | SMS passenger |
| `REQUESTED`/`OFFERED`/`CONFIRMED`/`ARRIVED` | `CANCELLED` | `CANCELLED` | SMS all parties |

**Delay is not a state.** `PICKUP_DELAYED` is an event allowed in `REQUESTED`, `OFFERED`, `CONFIRMED`. It updates `pickup_at` and notifies the passenger and the assigned driver. State is unchanged.

Illegal transitions must throw a typed `IllegalTransitionError`.

## Booking reference
`CR` + 4 digits (e.g. `CR1042`). Unique; retry on collision.

## Driver SMS keywords (case-insensitive, whitespace tolerant)
- `1 <ref>` accept, `2 <ref>` decline
- `DELAY <minutes> <ref>`
- `ARRIVED <ref>`, `DONE <ref>`, `CANCEL <ref>`

Unknown or malformed messages get a short help SMS reply. Replies from numbers that are not the assigned driver for that ref are ignored and logged.

## Driver selection (MVP)
Active drivers ordered by id, skipping any who already declined or timed out for this booking. Offer to one driver at a time.

## USSD service codes

Passenger code `*384*43639#`:

```
CON Welcome to CoastRide
1. Airport pickup (MIA)
2. SGR station pickup
3. Check my booking
```

Booking path: pickup point -> arrival reference (flight/train no.) -> arrival time (HHMM) -> destination -> party size (1-6) -> confirm. "Check my booking" asks for ref and returns state + driver (if any).

Driver code `*384*78088#`:

```
CON CoastRide Driver
1. View current trip
2. Help
```

After selecting the current trip, the action depends on the trip state:
- `OFFERED`: `1. Accept`, `2. Decline`.
- `CONFIRMED`: `3. Mark arrived`.
- `ARRIVED`: `4. Complete trip`.

The driver's caller ID must match an active driver record. Invalid or stale actions end safely and never perform a different transition. Both service codes use the same callback endpoint; the handler dispatches using the incoming `serviceCode`.

Rules: max 160 chars per screen; invalid input re-prompts once, then `END`.

## Data model (Postgres)
- `drivers(id, name, phone unique, plate, vehicle, active)`
- `bookings(id, ref unique, passenger_name null, passenger_phone, pickup_point, arrival_ref, pickup_at, destination, party_size, state, driver_id null, created_at, updated_at)`
- `booking_declines(booking_id, driver_id)`, used for skipping drivers
- `trip_events(id, booking_id, type, payload jsonb, created_at)`
- `messages(id, booking_id null, direction, channel, phone, body, provider_id null, status, created_at)`
- `webhook_events(id text primary key, received_at)`, used for idempotency

## Architecture
```
src/
  config/            env parsing (Zod)
  http/              Fastify app, routes, webhooks
  modules/
    bookings/        service, repo, ref generator
    trips/           stateMachine.ts, transitions, events
    drivers/          repo, selection
    messaging/       MessagingPort, FakeMessenger, AfricasTalkingMessenger, templates
    ussd/            passenger and driver handlers
    sms-inbound/     keyword parser
  lib/               phone normalization, logger, masking
prisma/              schema + migrations
tests/
```

### MessagingPort
```ts
interface MessagingPort {
  sendSms(input: { to: string; message: string; bookingId?: string }): Promise<{ providerId?: string }>
}
```

## Africa's Talking callback contract
- **Sandbox:** username `sandbox`; use the sandbox API key from the dashboard. Never commit it.
- **USSD callback:** HTTP POST, `application/x-www-form-urlencoded`, fields include `sessionId`, `serviceCode`, `phoneNumber`, `networkCode`, and `text`. The `text` value is the `*`-joined history of inputs. Response is `text/plain` starting with `CON ` or `END `.
- **Inbound SMS callback:** HTTP POST, form-encoded, fields include `from`, `to`, `text`, `date`, `id`, and `linkId`.
- Callbacks are protected by a secret path segment and rate limiting.

## Security requirements
- Webhook secret in path, constant-time compare
- Zod validation on every inbound payload
- Rate limit webhooks and public REST endpoints
- Masked phone numbers in logs; no message bodies at info level
- Driver actions authorized by the registered caller number and current trip assignment
- Replayed/stale USSD selections cannot advance a trip to a different state
