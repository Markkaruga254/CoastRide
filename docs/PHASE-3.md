# PHASE 3: Demo hardening and live board (27 Nov 2026)

Read `.kilocode/rules/rules.md` first. Existing behaviour stays unless a task changes it. Every task gets tests. Run `npm run lint && npm run typecheck && npm test` before each commit.

## Facts about the current code (verified by reading main)
- Offers expire after a fixed 3 minutes (`OFFER_TIMEOUT_MS` in `src/modules/bookings/service.ts`). `acceptOffer` rejects an offer older than that even if the job has not run, and without the job the booking stays `OFFERED`.
- `handleInboundSms` (`src/modules/sms-inbound/service.ts`) only treats `ConflictError` as a final, acknowledged failure. An `IllegalTransitionError` (for example `DONE` before `ARRIVED`) becomes HTTP 500, so the provider retries.
- `helpText()` does not match the parser grammar.
- `/health` does not check the database.
- Drivers with a booking in `OFFERED`, `CONFIRMED` or `ARRIVED` are skipped by driver selection, so stale test bookings can starve the demo.
- There is no dashboard and no reset tooling.

## BRANCH `demo/hardening` (tasks A to E, one commit each)

### A. Configurable offer timeout
- New env `OFFER_TIMEOUT_SECONDS`: integer, min 10, default 180. Replace the constant everywhere it is used (`acceptOffer`, `expirePendingOffers`). Read it at call time through `getEnv()`, not at module load.
- Add to `.env.example` and the README config table.
- Tests: with a short timeout, an old offer is rejected by `acceptOffer` and expired by `expirePendingOffers`; with the default, behaviour is unchanged.

### B. Inbound SMS: invalid commands are final, not retried
- In `handleInboundSms`, treat `IllegalTransitionError` exactly like `ConflictError`: log at warn (masked phone, no message body), acknowledge with HTTP 200, and keep the dedupe record (do NOT delete it, no provider retry).
- If the sender is the assigned driver or the booking's passenger, send one short SMS from a new template `actionNotAvailable(ref)`: `CoastRide <ref>: that action isn't available right now.` Unknown senders and unauthorized senders still get no reply (do not leak whether a ref exists).
- Tests: `ARRIVED` while `OFFERED`, `DONE` before `ARRIVED`, `1 <ref>` twice. Each returns 200, leaves the state unchanged, and does not delete the `webhook_events` row.

### C. Help text matches the parser
- `helpText()` must list exactly: `1 <ref> accept, 2 <ref> decline, DELAY <min> <ref>, ARRIVED <ref>, DONE <ref>` in a message under 160 characters. Update the exact-string test.

### D. Readiness endpoint
- `GET /health/ready` runs `SELECT 1` through Prisma. 200 `{"status":"ok","db":"ok"}`; on failure 503 `{"status":"degraded"}` with no error details. Leave `/health` unchanged. Test both outcomes.

### E. Demo reset script
- `npm run demo:reset -- --yes` (script in `scripts/demo-reset.ts`). Deletes, in one transaction and FK-safe order: `Message`, `TripEvent`, `BookingDecline`, `WebhookEvent`, `Booking`. NEVER touches `Driver`.
- Refuses to run without `--yes`. Refuses when `NODE_ENV=production` unless `ALLOW_DEMO_RESET=true`. Before running, prints only the database host and name (never the user, password or full URL). Afterwards prints the number of rows deleted per table.
- Tests (against the test database): bookings and messages are removed, drivers remain, and it refuses without `--yes`.

## BRANCH `demo/dashboard` (tasks F to J, one commit each; branch from `main` after `demo/hardening` is merged)

### F. Dashboard token
- New optional env `DASHBOARD_TOKEN` (min 16 characters, same placeholder rejection as `WEBHOOK_SECRET`, must differ from `WEBHOOK_SECRET` and `CRON_SECRET`). When it is unset, every dashboard route returns 404.
- Helper to check `Authorization: Bearer <token>` with the existing constant-time compare. Bad or missing token: 404, empty body. Reuse `allowRateLimit` (120 requests per minute per IP).

### G. Read-only board API
- `GET /api/board`, token protected, `Cache-Control: no-store`.
- Response `{ generatedAt, trips: [...], messages: [...] }`:
  - `trips`: the 20 most recently updated bookings: `ref, state, pickupPoint, pickupAt (ISO), destination, partySize, passengerPhone (masked), driver: { name, plate } | null, updatedAt`.
  - `messages`: the 30 most recent: `createdAt, direction, channel, phone (masked), body, status, attempts, bookingRef | null`. In `body`, mask any `+254` number (`+2547****1234`).
- No mutations, no secrets, no full phone numbers anywhere. Tests: auth failures return 404, masking is applied, ordering is correct, the lists are capped.

### H. Dashboard page
- `GET /dashboard` serves one self-contained HTML page and `GET /dashboard.js` serves its script (no build step, no dependencies, no external fonts or CDNs). Both are public static files; the data is protected by the token on `/api/board`. Send `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` and `Cache-Control: no-store`.
- Page behaviour: a token field (kept in `sessionStorage`), polling `/api/board` every 2 seconds. Header shows "CoastRide live board", the last update time in Africa/Nairobi, and a connection indicator that turns red after two failed polls.
- Layout, readable on a projector (large type, high contrast, works on a 1280 px wide screen): columns `Requested | Offered | Confirmed | Arrived | Completed | Cancelled / No driver`. Each trip card shows the ref in large type, `MIA 17:00 -> Diani, 3 pax`, `Brian Otieno, KBC 456B` when assigned, and the age (`12s ago`). Cards that changed in the last 5 seconds are highlighted. Below the board, a message log, newest first: time, direction and channel, masked phone, body, status badge (`queued` grey, `sending` blue, `sent` green, `failed` red) and attempts.
- All dynamic text must be inserted with `textContent` (never `innerHTML`). Add a test that a destination containing `<script>` is returned as plain data and that the page source contains no `innerHTML`.

### I. Demo controls (OPTIONAL, only if F to H are green; separate commit so it can be dropped)
- New env `DEMO_CONTROLS_ENABLED` (default false). When false, the route below is not registered.
- `POST /api/demo/driver-action`, token protected, body `{ ref, action }` with action one of `accept | decline | delay30 | arrived | done`. The server finds the assigned driver's phone and calls the same `handleInboundSms` path with a synthetic message id (`demo-<uuid>`) and the matching keyword text (`1 <ref>`, `2 <ref>`, `DELAY 30 <ref>`, `ARRIVED <ref>`, `DONE <ref>`), so parsing, authorization, state machine and SMS notifications are exactly what a real driver SMS would trigger. Return 200 `{ ok: true }`, 404 for an unknown ref, 409 for an action not allowed in the current state.
- On the dashboard, show buttons on each trip card, only when the controls are enabled (add `controlsEnabled` to the `/api/board` response). Label the section "Simulated driver phone (sandbox)".
- Tests: each action drives the correct transition, a disabled flag returns 404, no token returns 404, an illegal action returns 409.

### J. Docs
- README: Node 22, the full env table (including `CRON_SECRET`, `OFFER_TIMEOUT_SECONDS`, `DASHBOARD_TOKEN`, `DEMO_CONTROLS_ENABLED`, `ALLOW_DEMO_RESET`), a "Demo day runbook" section (reset, health checks, job loop, dashboard URL), and remove the stale Phase 1 curl section.
- `docs/AT-NOTES.md`: replace the SDK notes with the native adapter behaviour (status codes 100/101/102, sandbox endpoint selection) and mark inbound SMS callback fields as still unverified against a real sandbox callback.
- Set `.nvmrc` to 22.

## Definition of done for each branch
Lint, typecheck and the full test suite pass locally. The branch is pushed (never `main`). The final report follows the evidence format in `rules.md`.
