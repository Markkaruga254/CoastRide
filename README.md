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
