# Contributing to Banjo

## First, what Banjo is not

Banjo runs errands on the phone for one person. Most of what people reasonably expect from
"AI that makes calls" is deliberately absent, and will stay absent. Read this before opening a PR —
it's the difference between a change that gets merged and one that gets a polite no after you've
already written it.

Banjo is **not**:

- **Multi-tenant, and won't be retrofitted.** There is no tenant column, no per-tenant auth, no
  data partitioning, and `MCP_API_KEY` is a single static token for the whole instance. If you need
  to serve several people, run several instances — the Mattermost/n8n pattern. That's viable now
  that Banjo ships as a container; it wasn't before.
- **A business scheduling system.** No services × staff × assets model, no resource allocation, no
  availability rules beyond one calendar and a business-hours window.
- **A product with a UI.** No dashboard, no analytics, no admin panel, no booking page, no web chat.
  The interfaces are an MCP server and a phone line. A PR adding a frontend is a different project.
- **A receptionist.** The inbound line (`INBOUND_BOOKING_ENABLED`, off by default) exists so people
  can call *back*. Banjo's centre of gravity is outbound.
- **A general voice-agent platform.** The `VoiceAIProvider`/`TelephonyProvider` seams exist so this
  application can swap vendors — not so you can build other applications on top of them. Generalising
  them further, for use cases Banjo doesn't have, makes them harder to keep correct for the one it does.

What *is* wanted: making the calls work better, making it easier to self-host, filling in the gaps
in [`docs/ROADMAP.md`](docs/ROADMAP.md), and hardening the provider adapters that have never carried
live traffic.

## Getting set up

See the README's Quickstart. `docker compose up` gets you a running instance; `npm run dev` with
`docker compose up -d postgres` gets you hot reload. Placing a real call needs real Twilio and voice
AI credentials and a publicly reachable hostname — there is no offline simulator.

```bash
npm run typecheck
npm test
```

Both must pass. CI runs exactly these, plus a build, against a Postgres service.

## Conventions that will bite you

**The test database is `banjo_test`, never `banjo`.** `vitest.config.ts` points there, and the
DB-backed suites additionally hardcode `postgresql://banjo:banjo@localhost:5432/banjo_test` in their
own `beforeAll`. Compose creates it on first run; migrate it with
`DATABASE_URL=postgresql://banjo:banjo@localhost:5432/banjo_test npm run db:migrate`.

**Clean up every table you write.** `fileParallelism` is `false` because the DB suites share one
database and truncate the same tables. Clear what your file writes both in `beforeEach` *and* after
its last test. A row left behind breaks a different file's setup — and only when vitest happens to
order that file next, which makes it a miserable failure to chase.

**Mock at the interface boundary.** Provider and session tests mock `VoiceAIProvider` /
`TelephonyProvider`, not the Twilio or OpenAI SDKs. That's what the abstraction is for; tests that
reach past it into vendor internals pin the wrong contract.

**Don't strip the comments.** Much of the commentary in this codebase is load-bearing — it records
what went wrong on a specific real phone call and why the code is shaped the way it is. The
`jsonSchema7` conversion in `src/voice/tools/defineVoiceTool.ts`, the hang-up timing in
`src/voice/tools/callTools.ts`, the `<Parameter>` workaround in
`src/telephony/providers/twilio.ts` — all of these look like removable noise and are not. If a
comment seems wrong, check git history before deleting it.

**Timezones go through `src/lib/timezone.ts`.** `CALENDAR_TIMEZONE` is the single source of truth
for what a spoken time means. A real booking once landed four hours off; don't reintroduce a bare
unzoned timestamp on any call-facing or calendar-write path.

**Postgres is the source of truth** for whether an appointment was booked — never what the model
said out loud, never Google Calendar alone.

**Schema changes ship with their migration.** Run `npm run db:generate` and commit the generated SQL
alongside your `src/**/schema.ts` edit. A new table also needs re-exporting from `src/db/schema.ts`,
or drizzle-kit won't see it.

## Pull requests

- Branch from `main`. Keep the PR to one concern.
- Say what you actually verified. "Placed a real call and it booked" is worth ten green unit tests
  on a call-path change; so is "I couldn't test this against real Twilio" — that's useful, not
  disqualifying.
- Behaviour changes need tests. Provider adapters that can't be tested without live credentials
  should say so in the PR.
- New config goes in `src/config/index.ts` with a comment explaining *why* it exists, plus
  `.env.example`. Booleans use `z.enum(['true','false'])`, never `z.coerce.boolean()` — `Boolean("false")`
  is `true`.

## Reporting security issues

Don't open an issue. See [`SECURITY.md`](SECURITY.md).
