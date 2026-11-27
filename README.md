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
| `AT_PASSENGER_USSD_CODE` | No | `*384*43639#` | Passenger booking service code |
| `AT_DRIVER_USSD_CODE` | No | `*384*78088#` | Driver trip-management service code |
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

## Connect to the Africa's Talking sandbox

Set `AT_ENABLED=true`, `AT_USERNAME=sandbox`, and the sandbox API key in your untracked `.env` file. Configure both USSD service codes to use the same public HTTPS callback:

- Passenger `*384*43639#`: `https://<host>/webhooks/<WEBHOOK_SECRET>/ussd`
- Driver `*384*78088#`: `https://<host>/webhooks/<WEBHOOK_SECRET>/ussd`
- Inbound SMS: `https://<host>/webhooks/<WEBHOOK_SECRET>/sms`

The USSD callback routes by the `serviceCode` field, so the passenger and driver codes reach separate handlers even though they share the callback URL. If either code changes in the Africa's Talking dashboard, update its matching environment variable.

### Driver USSD journey

The caller's number must match an active driver record in the `Driver` table. The driver menu shows the driver's current offer/trip and exposes only the action valid for its state:

- `OFFERED`: choose `1` to accept or `2` to decline.
- `CONFIRMED`: choose `3` to mark arrival.
- `ARRIVED`: choose `4` to complete the trip.

A repeated or stale action is rejected rather than being interpreted as a different state transition. Kenyan mobile numbers in both the `07x` and `01x` ranges are accepted. The sandbox simulator must use a number registered to an active CoastRide driver; a syntactically valid but unregistered number is not automatically enrolled.

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
