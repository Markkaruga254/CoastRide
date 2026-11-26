# CoastRide Backend Readiness Audit

**Audit date:** 2026-11-26  
**Audited ref:** `main` at `c67f5dd1236f9a21a43fd4013f062307fc3f1bd5`  
**Scope:** Backend only — API, booking lifecycle, USSD/SMS webhooks, persistence, deployment and automated verification.  
**Method:** Static source review through the connected GitHub repository. No production credentials or live provider calls were used. Runtime tests have not yet been executed in this audit environment.

## Executive summary

CoastRide has a useful MVP foundation: Fastify + TypeScript, Prisma/PostgreSQL, a defined trip state machine, USSD flow, inbound SMS commands, an Africa's Talking adapter, persisted trip events/messages, and a database-backed end-to-end test.

It is not yet production-ready. The highest-priority issues are a Docker Compose configuration that cannot pass startup validation, webhook endpoints without effective rate limiting, inbound SMS processing errors that can be acknowledged and permanently deduplicated, and driver-offer selection without concurrency/availability guarantees.

## Findings

### P0 — Docker Compose app configuration fails environment validation

**Evidence:** `docker-compose.yml` configures `NODE_ENV=production`, a `WEBHOOK_SECRET` containing `REPLACE_ME`, and empty Africa's Talking credentials while `AT_ENABLED=false`. In `src/config/env.ts`, the secret validator rejects `REPLACE_ME`, and the refinement requires `AT_USERNAME` and `AT_API_KEY` whenever `NODE_ENV=production` OR `AT_ENABLED` is true.

**Impact:** The app exits during environment parsing before it can serve health checks. The README's documented `docker compose up -d db app` path is therefore not viable with the committed compose configuration.

**Fix direction:** Make provider credentials mandatory only when the provider is enabled (unless production intentionally requires a live provider), require a real secret via environment substitution, and provide a safe local compose path. Never commit a usable secret.

### P1 — SMS processing failures can be acknowledged as successful

**Evidence:** `src/modules/sms-inbound/service.ts` catches exceptions around booking commands and logs them without rethrowing. `src/http/routes/sms.ts` inserts the provider message ID into `WebhookEvent` before processing, then returns HTTP 200. The route only deletes the dedupe row if an exception reaches its own catch block.

**Impact:** A failed state transition or transient database/service error may be treated as processed. The provider receives 200, and a duplicate callback is discarded because the message ID remains in `WebhookEvent`. This can permanently lose a driver command.

**Fix direction:** Define explicit outcomes for invalid/unauthorized commands versus transient processing failures. Let transient failures reach the route, remove or transition the dedupe record safely, and return the provider-appropriate retry response. Add tests for failure-after-dedupe and retry.

### P1 — USSD and SMS webhook endpoints lack effective rate limiting

**Evidence:** `src/http/routes/webhooks.ts` implements an in-memory limiter only for `POST /webhooks/:secret/echo`. The actual `ussd.ts` and `sms.ts` routes validate the secret but do not apply a limiter. The spec calls for webhook and public REST rate limiting.

**Impact:** The main public callback routes can be flooded, increasing database and provider costs and exposing the service to resource exhaustion. An in-memory limiter alone will also be per-process and reset on restart; that limitation must be explicit.

**Fix direction:** Add a shared bounded limiter to all callback routes, with separate limits by endpoint and client identity. Document reverse-proxy/IP trust assumptions. Consider a shared store only when deploying multiple instances.

### P1 — Driver offer selection is not concurrency-safe

**Evidence:** `offerNextDriver` reads the booking state, reads declines, selects a driver, then updates the booking inside a transaction without a conditional state update/row lock or retry strategy. Multiple concurrent callers can observe `REQUESTED` and race to offer different drivers. Driver selection also only filters `active=true` and prior declines; it does not exclude a driver already assigned to another non-terminal trip.

**Impact:** Duplicate or competing offers may be sent, and one driver may receive overlapping trips.

**Fix direction:** Make offer acquisition atomic (conditional update/locking plus conflict handling), and define a deterministic availability rule that excludes drivers with an active `OFFERED`, `CONFIRMED`, or `ARRIVED` booking. Add concurrent integration tests.

### P1 — Offer timeout is modelled but not implemented

**Evidence:** `TripEvent` includes `OFFER_TIMEOUT` in the state machine and `BookingDecline.reason` includes `timeout`, but no scheduler/worker or expiry timestamp is present in the schema or service layer.

**Impact:** A driver who never replies can leave a booking in `OFFERED` indefinitely.

**Fix direction:** Add an explicit offer expiry and a reliable scheduled processor (or a clearly bounded polling mechanism for the MVP). Timeout must be idempotent and race safely with acceptance.

### P1 — Outbound message recovery is incomplete

**Evidence:** `dispatchQueued` sends messages after the database transaction and changes status to `sent` or `failed`. There is no retry count, next-attempt time, worker, or recovery process for persisted `queued`/ `failed` messages.

**Impact:** Process crashes after commit but before dispatch, or temporary provider outages, can leave notifications unsent without an automated recovery path. State changes can succeed while passengers/drivers are not informed.

**Fix direction:** Use the existing Message table as a transactional outbox: claim queued/retryable rows atomically, track attempts and last error safely, apply bounded exponential backoff, and make delivery idempotency/reconciliation explicit. Avoid adding a queue dependency until the simpler outbox is proven sufficient.

### P2 — No repository CI workflow is present

**Evidence:** The repository root has no `.github/workflows` directory. Existing scripts expose lint, typecheck, build and Vitest tests.

**Impact:** Pull requests do not have automated evidence that code compiles or tests pass.

**Fix direction:** Add GitHub Actions for install, Prisma client generation, lint, typecheck, build and tests against a disposable PostgreSQL service.

### P2 — Health check and operational configuration need verification

**Evidence:** The Dockerfile uses `node:20-slim`; Compose health check invokes `wget`, but the image does not explicitly install it. The health endpoint implementation and container startup need a real container smoke test. The test setup safely checks the test DB name before applying migrations, which should be preserved.

**Impact:** A missing health-check binary can mark a healthy API unhealthy. Startup/migration failures may be hard to distinguish from app health failures.

**Fix direction:** Use a health check that is guaranteed to exist in the image (for example, a small Node HTTP probe), and verify clean boot, migration and shutdown behaviour.

### P2 — API validation and public surface need hardening

**Evidence:** The development REST booking API validates basic shape but accepts unbounded free-text fields, does not enforce a future pickup time, and has no route-level rate limiting. These routes are disabled in production, which reduces exposure, but the contract still needs tighter limits and consistent validation. The GET booking endpoint exposes passenger and trip details by reference and is suitable only as a development/test route until an authorization design exists.

**Impact:** Oversized input and reference-based data exposure become risks if the development routes are ever exposed. The current MVP spec explicitly lists auth out of scope, so do not silently expose these endpoints publicly.

**Fix direction:** Bound string lengths, validate date ranges and pickup consistency, test error shapes, and keep unauthenticated REST routes disabled in production until an access-control design is approved.

## Strengths to preserve

- Existing TypeScript strict mode and Zod environment validation.
- Prisma migrations and separate test database guard.
- Pure trip state machine and typed illegal-transition/conflict errors.
- USSD stateless flow and unique `ussdSessionId` idempotency.
- Webhook secret comparison uses constant-time comparison after a length check.
- Inbound SMS authorization checks passenger/assigned-driver roles.
- Trip events and outbound message rows are written within booking transactions.
- Africa's Talking adapter is isolated behind `MessagingPort`.
- Existing end-to-end lifecycle test should remain a regression gate.

## Proposed implementation order

1. Repair environment validation and Docker Compose boot path; add a clean-container smoke test.
2. Add CI so each subsequent change has automated lint/typecheck/build/test feedback.
3. Correct SMS callback failure/retry semantics and apply rate limiting to actual callbacks.
4. Make driver offers atomic, add driver availability rules, and implement offer expiry.
5. Complete the transactional outbox retry/recovery path and operational logging.
6. Tighten REST input bounds and document production exposure boundaries.

## Verification status

- **Completed:** Repository tree, current `main` commit, core route/service/schema/config/Docker/docs/test source review.
- **Not completed:** `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, Docker Compose boot, live Africa's Talking sandbox callback/send. These require a runnable checkout and database/provider environment; no green status is claimed.
- **No secrets were read, changed, or added.**
