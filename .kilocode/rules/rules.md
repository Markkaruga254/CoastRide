# CoastRide: rules for the coding agent

You are implementing a backend described in `docs/SPEC.md`, one phase at a time.
Only work on the phase you are explicitly given. Read `docs/SPEC.md` and the current `docs/PHASE-N.md` before writing code.

## Stack (fixed; do not substitute)
- Node.js 20+, TypeScript (strict), ESM
- Fastify, Zod (validation + config), pino (logging)
- PostgreSQL + Prisma (migrations committed)
- Vitest for tests
- pg-boss for delayed jobs (Phase 3 only)
- Official `africastalking` npm SDK (Phase 2 only)
- Docker Compose for local Postgres and the app

## Hard rules
1. **No new dependencies** without asking. If you think one is needed, stop and say why.
2. **Never invent Africa's Talking API behavior.** Only use the request/response formats pasted in `docs/SPEC.md` or `docs/AT-NOTES.md`. If something is unclear, stop and ask.
3. **Africa's Talking is accessed only through the `MessagingPort` interface.** Core/domain code must never import the SDK. Tests use `FakeMessenger`.
4. **State changes only go through the trip state machine** (`src/modules/trips/stateMachine.ts`). No ad-hoc `UPDATE bookings SET state`.
5. **Webhook handlers must respond fast.** Never await an outbound SMS/voice call inside a USSD handler. Persist, enqueue, return.
6. **USSD logic is a pure function:** `handleUssd(input, deps) -> { type: 'CON' | 'END', text: string }`. No HTTP inside it.
7. **Idempotency:** every inbound webhook is deduplicated via `webhook_events`.
8. **Phone numbers** are normalized to E.164 (`+2547XXXXXXXX`) at the edge. Logs mask them (`+2547****1234`).
9. **No secrets in code or logs.** All config via environment variables, validated at boot with Zod.
10. **Small commits, one concern each.** Conventional commit messages (`feat:`, `test:`, `chore:`).

## Definition of done for any task
- `npm run lint`, `npm run typecheck`, `npm test` all pass
- New behavior has tests; illegal paths have tests too
- No TODOs left in code you wrote; unfinished work is listed in your final message
- Final message lists: files changed, how to run it, what you did NOT do

## Do not build (unless a phase says so)
Auth/login, multi-tenancy, payments, voice, maps/geolocation, admin UI beyond what the phase specifies, caching layers, microservices.
