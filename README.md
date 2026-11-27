# CoastRide

Airport and SGR transfer coordination backend.

## Requirements

- Node.js 22 or newer for local development.
- Docker Engine and Docker Compose for the containerized setup.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Runtime environment |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `TEST_DATABASE_URL` | No | — | Test database (name must end in `_test`) |
| `PORT` | No | `3000` | HTTP port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `WEBHOOK_SECRET` | Yes | — | High-entropy secret for webhook endpoints (min 24 chars, no placeholders) |
| `AT_ENABLED` | No | `false` | Enable Africa's Talking adapter |
| `AT_USERNAME` | When `AT_ENABLED=true` | — | Africa's Talking username |
| `AT_API_KEY` | When `AT_ENABLED=true` | — | Africa's Talking API key |
| `CRON_SECRET` | No | — | Secret for `/internal/jobs/process` (min 24 chars) |
| `OFFER_TIMEOUT_SECONDS` | No | `180` | Driver offer expiry in seconds (min 10) |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `SEED_DRIVER_PHONES` | No | 4 sandbox numbers | Comma-separated driver phones for seeding |

## Run locally with Docker Compose

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Generate a dedicated webhook secret and put it in `.env`:
   ```bash
   openssl rand -hex 32
   ```
   Set the output as `WEBHOOK_SECRET`. Do not use the example placeholder or commit your real `.env` file.
3. Start PostgreSQL and the API:
   ```bash
   docker compose up -d --build db app
   ```
4. Check API health:
   ```bash
   curl --fail http://localhost:3000/health
   ```

The Compose app runs with the Africa's Talking adapter disabled by default. To enable it, set `AT_ENABLED=true` and provide valid `AT_USERNAME` and `AT_API_KEY` values in your untracked `.env` file, then recreate the app container.

## Run Phase 1

```bash
# 1. Start Postgres
docker compose up -d db

# 2. Run migrations
npm run db:migrate

# 3. Seed drivers
npm run db:seed

# 4. Dev server
npm run dev

# 5. Health check
curl http://localhost:3000/health
```

## Run Phase 1 — happy path (curl)

```bash
BASE=http://localhost:3000

# Create a booking (returns REF like CR1042)
REF=$(curl -s -X POST $BASE/bookings \
  -H 'Content-Type: application/json' \
  -d '{"passengerPhone":"+254700000010","passengerName":"John Doe","pickupPoint":"MIA","arrivalRef":"BA123","pickupAt":"2026-11-24T14:30:00Z","destination":"Westlands","partySize":2}' \
  | jq -r '.ref')
echo "Booking ref: $REF"

# View the booking (state: REQUESTED)
curl -s $BASE/bookings/$REF | jq .

# Offer driver 1 (via service — no HTTP offer endpoint yet)
npm run db:seed
node --env-file=.env -e "
import { PrismaClient } from '@prisma/client';
import { offerNextDriver } from './src/modules/bookings/service.js';
const p = new PrismaClient();
(async () => {
  const b = await p.booking.findUnique({ where: { ref: '$REF' } });
  const o = await offerNextDriver({ prisma: p, messenger: { sendSms: async () => ({}) } }, { bookingId: b.id });
  console.log('Offered to driver:', o.driver?.name, o.driver?.phone);
  await p.$disconnect();
})();
"

# Driver accepts
curl -s -X POST $BASE/bookings/$REF/driver-response \
  -H 'Content-Type: application/json' \
  -d '{"driverPhone":"+254700000001","action":"accept"}' \
  | jq .

# View booking (state: CONFIRMED)
curl -s $BASE/bookings/$REF | jq .

# Delay 90 minutes
curl -s -X POST $BASE/bookings/$REF/delay \
  -H 'Content-Type: application/json' \
  -d '{"minutes":90}' | jq .

# Cancel
curl -s -X POST $BASE/bookings/$REF/cancel \
  -H 'Content-Type: application/json' \
  -d '{}' | jq .
```

## Connect to the Africa's Talking sandbox

Set `AT_ENABLED=true`, `AT_USERNAME=sandbox`, and the sandbox API key in your untracked `.env` file. Configure the public HTTPS callback URLs in the Africa's Talking dashboard:

- USSD: `https://<host>/webhooks/<WEBHOOK_SECRET>/ussd`
- Inbound SMS: `https://<host>/webhooks/<WEBHOOK_SECRET>/sms`

For local development, expose the API with a trusted HTTPS tunnel and use its public URL in the dashboard. Never paste the API key or webhook secret into source control or issue comments.


## Scheduled backend recovery

The API exposes one authenticated job endpoint that:
- expires unanswered driver offers after three minutes and offers the trip to the next eligible driver;
- retries queued/failed SMS outbox rows with bounded exponential backoff;
- retries old `REQUESTED` bookings whose initial driver dispatch did not complete.

Generate a separate high-entropy secret and set `CRON_SECRET` in the API environment:

```bash
openssl rand -hex 32
```

Call the endpoint once per minute from a trusted scheduler (for example, a Render Cron Job):

```bash
curl --fail-with-body -X POST https://<api-host>/internal/jobs/process \
  -H "x-cron-secret: $CRON_SECRET"
```

Set `CRON_SECRET` in the scheduler's secret environment too. The endpoint returns counts for expired offers, retried bookings and dispatched messages. Do not use the Africa's Talking webhook secret as the cron secret. If no cron secret is configured, the endpoint returns 404.


### SMS status semantics

A message marked `sent` means Africa's Talking accepted it for processing (immediate status codes 100 Processed, 101 Sent, or 102 Queued). It does **not** guarantee delivery to the passenger's handset. Final handset delivery reports are not yet wired into CoastRide; add the Africa's Talking SMS delivery-report callback before using the database status as a delivery guarantee.

## Quality checks

```bash
npm run lint
npm run typecheck
npm run build
npm test
```
