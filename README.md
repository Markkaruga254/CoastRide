# CoastRide

Airport and SGR transfer coordination backend.

## Run Phase 1

```bash
# 1. Start Postgres + app
docker compose up -d db app

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
npm run db:seed  # ensures drivers exist
node --env-file=.env -e "
import { PrismaClient } from '@prisma/client';
import { offerNextDriver } from './src/modules/bookings/service.js';
const p = new PrismaClient();
(async () => {
  const b = await p.booking.findUnique({ where: { ref: '$REF' } });
  const o = await offerNextDriver({ p, messenger: { sendSms: async () => ({}) } }, { bookingId: b.id });
  console.log('Offered to driver:', o.driver?.name, o.driver?.phone);
  await p.\$disconnect();
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
  -d '{"minutes":90}' \
  | jq .

# Cancel
curl -s -X POST $BASE/bookings/$REF/cancel \
  -H 'Content-Type: application/json' \
  -d '{}' \
  | jq .
```
