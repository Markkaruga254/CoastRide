# CoastRide: rules for the coding agent (updated 27 Nov 2026)

You work on a backend that is being demoed TODAY at a hackathon against the Africa's Talking SANDBOX, deployed on Render. Reliability beats features. Read `docs/SPEC.md`, `docs/AT-NOTES.md` and the current `docs/PHASE-N.md` before coding.

## Current stack (do not substitute)
- Node.js 22, TypeScript (strict, ESM), Fastify 5, Zod 4, pino 9
- PostgreSQL + Prisma 5.22 (migrations committed; the Prisma CLI is present in node_modules)
- Vitest. Tests need `TEST_DATABASE_URL` (database name must end in `_test`).
- SMS goes through our own native `fetch` adapter (`src/modules/messaging/africastalking.ts`). The `africastalking` npm SDK is NOT used. Do not add it back.

## Hard rules
1. **No new dependencies.** If you think one is needed, stop and ask.
2. **No schema changes or migrations** unless the task says so. If a task needs one, create it with `npx prisma migrate dev --name <name>` and report it; never hand-write SQL or backdate folder names.
3. **Never read, print, log or commit secrets.** Do not `cat .env`. Never paste API keys, webhook secrets or database URLs in output, commits, tests or docs. Phone numbers are masked in logs and in any API response (`+2547****1234`).
4. **Do not change existing behaviour** except where the task says so. All existing tests stay green after every commit.
5. **State changes go through the trip state machine and the existing services.** No ad-hoc `UPDATE ... SET state`.
6. **Webhook handlers must stay fast and safe:** constant-time secret checks, 404 on mismatch, Zod validation, idempotency, no full phone numbers or message bodies in logs.
7. **Anything rendered in a browser must be escaped:** use `textContent`, never `innerHTML`, for data that came from users (destinations, names, message text).
8. **Git workflow:** work only on the branch you were given. Small commits, conventional messages (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Do not push to `main`. Do not force-push.

## Reporting (evidence, not claims)
Your final message for each task group MUST include, copied from real command output:
- `git log --oneline -n 10`
- the last lines of `npm test` (file and test counts) and the results of `npm run lint` and `npm run typecheck`
- the list of files changed
- a section "NOT DONE / NOT VERIFIED" listing anything skipped, anything you could not run, and any assumption you made
Never say tests pass unless you ran them in this session and pasted the output. If a test is flaky or you changed a test to make it pass, say so explicitly.

## Do not build (unless a task says so)
Auth systems, payments, voice, maps, multi-tenancy, caching layers, new frameworks, refactors of working code.
