# Scenario Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved call scenarios that run two ways. `npm run eval` runs them live, k times each against the real OpenAI model, and reports pass rates, rescues, cost and time. `npm test` replays recordings of those runs for free.

**Architecture:**
- **Engine:** every run goes through the existing sim engine (`startSimCall`), under a fixed, fictional environment.
- **Recorder:** a `TextVoiceAIProvider` decorator records everything that crosses the voice-provider boundary. From that log come the run record that code checks grade, the rescue count, and the recording.
- **Replayer:** a replaying provider plays a recording back in vitest against the real `CallSession`, tools and `banjo_test`. A fingerprint of the prompt and tools marks a recording stale when they change.

**Tech Stack:** TypeScript, tsx, vitest, Zod, Drizzle/Postgres, OpenAI Realtime (text-only mode), and `yaml` (new devDependency).

**Spec:** `docs/superpowers/specs/2026-10-22-scenario-evals-design.md`

## Global Constraints

- **Warn only.** A drop in pass rate is flagged in the summary and blocks nothing. `npm run eval` exits 0 whenever the suite ran, even if checks failed. It exits non-zero only when it couldn't run at all (no key, no Postgres).
- **Real runs only.** Only a real model run counts as a live result. Without an API key, `npm run eval` says so and stops. A replay is never reported as evidence that the model behaves.
- **Stale recordings.** If the prompt or tools changed since a recording, replay reports it stale and never a pass. **Builder's call: stale or missing recordings are skipped with a visible warning, not failed.**
- **Scoring.** Score the whole call. A rescue never fails a check, and rescues are counted and reported separately.
- **Fixed, fictional configuration.** Live and replay runs use one committed environment, layered over `simEnv`, and take nothing from `.env` except `OPENAI_API_KEY` and `DATABASE_URL`'s server.
- **Nothing real committed.** No real phone numbers, real people's names, or private individuals' words in scenarios, recordings or results. The fictional numbers come from the `202-555-01xx` range already in `src/sim/env.ts`.
- **The sim's safety holds.**
  - Live runs write only to `banjo_sim`, and replay only to `banjo_test`.
  - No notification, webhook, recording or call.
  - `src/sim/env.ts` keeps forcing these off.
- **Tests run the CI way:** `.env` hidden, `GEMINI_API_KEY` unset, and the exit code checked. Replay must pass like that.
- **DB suites clear every table they write,** both before each test and after the last one.
- **Repo conventions:**
  - Zod for schemas;
  - mock at the `VoiceAIProvider` interface;
  - match the surrounding code's comment density and naming;
  - no `verbatimMessage` on non-voicemail tools.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never include a `Claude-Session:` trailer or a session URL. Commit and push are separate commands.
- **Default runs per scenario:** k = 3.
- **Budget:** a full run of 10 scenarios at k = 3 should stay in single-digit dollars. The first real run reports the actual cost.

## Review Focus

Inputs the spec implies but no feature test exercises. Each line has a pinning test in the owning task.

1. **The recorder hides or adds optional provider methods.** `CallSession` branches on `voiceAI.addContext`, `setHold`, `judgeHoldLine` and `verbatimDeliveryReport` being present. The recorder must expose each one exactly when the wrapped provider has it (Task 3).
2. **A recording made under a different config or prompt.** Replay must report it stale and never pass. The same recording under the same config must report fresh, even though task IDs and timestamps differ between runs (Task 4).
3. **A typo in a scenario file:** an unknown check name, tool name or status. Loading must fail with the file and path named, never pass silently by running zero checks (Task 2).
4. **Ctrl+C or a crashed run partway through `npm run eval`.** Results finished so far are still written, the summary marks the run partial, and no baseline is saved from it (Task 7).
5. **A real `.env` with the owner's real name or profile.** `evalEnv` must ignore those keys, so they can't reach a prompt or a committed recording (Task 1).

---

### Task 1: Fixed eval environment, script runner with silence, sim options

**Files:**
- Create: `src/evals/env.ts`
- Create: `evals/fixtures/owner-profile.md`
- Create: `src/sim/script.ts` (the scripted-line runner, moved from `scripts/sim.ts`)
- Modify: `scripts/sim.ts`, to import `runScript` and `readScript` from `src/sim/script.ts` and delete its own copies
- Modify: `src/sim/simCall.ts` (`SimCallOptions`, `startSimCall`)
- Test: `tests/evals/env.test.ts`, `tests/sim/script.test.ts`, and an extended `tests/sim/simCall.db.test.ts`

**Interfaces:**
- Produces:
  - `EVAL_FIXED_ENV: Readonly<Record<string, string>>` in `src/evals/env.ts`:
    - `ASSISTANT_PRINCIPAL_NAME: 'Alex'`
    - `CALENDAR_TIMEZONE: 'America/New_York'`
    - `OPENAI_REALTIME_MODEL: 'gpt-realtime'`
    - `PROMPT_PROFILE_FILE`: absolute path of `evals/fixtures/owner-profile.md`
    - `DISCLOSURE_LINE: ''`, i.e. unset, so config's default applies (check what config does with an empty value; if it rejects it, delete the key instead)
    - `MCP_AGENT_API_KEY: ''`
  - `evalEnv(base: Record<string, string | undefined>, flags: ScenarioFlags & { env?: Record<string, string> }): Record<string, string>` returns:
    - `simEnv(base, { transfer, warm, askOwner, verbose: false })`;
    - then `EVAL_FIXED_ENV`;
    - then the scenario's own `env` overrides.

    The only things taken from `base` are `OPENAI_API_KEY` and `DATABASE_URL` (via simEnv). Every other key in `EVAL_FIXED_ENV` overrides `base`. `PROMPT_PROFILE_FILE` is never inherited from it.
  - `ScenarioFlags = { transfer: boolean; warm: boolean; owner: 'accept' | 'decline' | 'no-answer'; askOwner?: string | null }`, exported from `src/evals/env.ts`.
  - `ScriptStep = { kind: 'line'; text: string } | { kind: 'recording'; text: string } | { kind: 'silence'; seconds: number }` in `src/sim/script.ts`.
  - `parseScriptLines(lines: string[]): ScriptStep[]`:
    - `~text` gives a recording step;
    - `(silence N)`, where N is a whole number from 1 to 120, gives a silence step;
    - anything else gives a line step;
    - it throws on `(silence` with a bad N.
  - `readScript(path: string): ScriptStep[]` drops blank lines and `#` comments.
  - `runScript(steps: ScriptStep[], voice: TextVoiceAIProvider, telephony: SimTelephonyProvider, print: (line: string) => void, timing?: Partial<ScriptTiming>): Promise<void>`. It resolves when the line ends.
  - `ScriptTiming = { turnQuietMs: 1500; recordingGapMs: 3000; endQuietMs: 15000 }`. These are today's constants, unchanged.
  - `SimCallOptions` gains:
    - `windowStart?: Date`, default `new Date()`, which replaces the `const windowStart` in `startSimCall`;
    - `relationshipTier?: 'family' | 'friend'`, passed to `addContact`.

- [ ] **Step 1: Write the failing tests**
  - In `tests/evals/env.test.ts`:
    - `evalEnv ignores the owner's real name and profile from .env`. Given a base with `ASSISTANT_PRINCIPAL_NAME: 'Steve Real'` and `PROMPT_PROFILE_FILE: '/home/me/profile.md'`, expect `ASSISTANT_PRINCIPAL_NAME === 'Alex'` and `PROMPT_PROFILE_FILE` ending in `evals/fixtures/owner-profile.md`.
    - `evalEnv keeps OPENAI_API_KEY and points at banjo_sim`. Expect `DATABASE_URL` to end with `/banjo_sim`.
    - `a scenario's env override wins`, using `{ CALENDAR_TIMEZONE: 'America/Los_Angeles' }`.
    - `ask_owner flag turns ask_owner on`. Expect `ASK_OWNER_ENABLED === 'true'`.
  - In `tests/sim/script.test.ts`, with vitest fake timers and a fake voice and telephony:
    - `parseScriptLines` covers each kind, and `(silence 0)` and `(silence x)` throw.
    - `a silence step sends nothing for N seconds, then plays the next line`: advance N×1000−1 ms and expect no `sendUserText`; advance 1 ms more plus `turnQuietMs` after a Banjo line, and expect the next line to be sent.
    - The `~` recording-gap and end-quiet behavior match today's (port the existing behavior as tests).

- [ ] **Step 2: Run them and confirm they fail**

  Run `npx vitest run tests/evals/env.test.ts tests/sim/script.test.ts`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** `src/evals/env.ts`, `src/sim/script.ts`, the `SimCallOptions` fields, and the fixture profile.
  - The fixture profile is a short markdown profile for fictional Alex. It must include the employer "Northwind Traders" and "works from home on Tuesdays". The profile-probing scenario checks that these are never spoken.
  - A silence step waits `seconds × 1000` ms from when it's reached, without waiting for Banjo, then moves on as after a recording step.

- [ ] **Step 4: Add the sim test.** In `tests/sim/simCall.db.test.ts`, add `windowStart sets the booking window`. Pass a fixed `windowStart`, then expect the task's constraint window to start at that ISO time. Clear any tables the test writes.

- [ ] **Step 5: Run the tests the CI way and confirm they pass**

  Run `mv .env .env.hidden; env -u GEMINI_API_KEY npx vitest run tests/evals tests/sim; echo exit=$?; mv .env.hidden .env`. Expected: PASS and `exit=0`. `npm run sim -- --help` still prints the usage text.

- [ ] **Step 6: Commit** with `feat(evals): fixed eval environment, script silence step, sim window start`.

---

### Task 2: Scenario file schema and loader

**Files:**
- Modify: `package.json` (add devDependency `yaml`)
- Create: `src/evals/scenario.ts`
- Test: `tests/evals/scenario.test.ts`

**Interfaces:**
- Consumes: `ScenarioFlags` (Task 1), `parseScriptLines` (Task 1), `SimCallOptions['category' | 'mode']`.
- Produces:
  - `Scenario = { id: string; title: string; source: string; task: { business: string; category; goal: string; mode: 'booking' | 'conversation' | 'ask'; questions?: string[]; durationMinutes: number; windowDays: number; relationshipTier?: 'family' | 'friend' }; flags: ScenarioFlags; env?: Record<string, string>; script: ScriptStep[]; expect: Expectations; skipUniversal?: { check: UniversalCheckName; reason: string }[] }`
  - `Expectations = { status: TaskStatus[]; toolsCalled?: ToolExpectation[]; toolsNotCalled?: ToolExpectation[] /* with argsInclude: never called with those args */; bookedLocal?: { dayOffset: number; time: string /* "HH:MM" */ }; traceableNumbers?: boolean; neverSays?: string[]; goodbyeWithinTurnsAfter?: { userLineIncludes: string; turns: number } }`
  - `ToolExpectation = { name: string; argsInclude?: Record<string, string | number | boolean> }`
  - `UniversalCheckName = 'disclosure_first' | 'disclosure_once' | 'goodbye_before_end'`
  - `loadScenario(path: string): Scenario` and `loadScenarios(dir = 'evals/scenarios'): Scenario[]`. The second sorts by id and throws on duplicate ids.

- [ ] **Step 1: Write the failing tests** in `tests/evals/scenario.test.ts`, using temporary YAML files:
  - `loads a valid scenario`. Its `script` is a YAML list of strings, parsed through `parseScriptLines`.
  - `an unknown tool name fails with the file and path`. Expect the message to contain the file name, `expect.toolsCalled.0.name`, and the list of known tool names. The known names come from the tool definitions in `src/voice/tools/callTools.ts`, plus `transfer_to_owner` and `ask_owner`.
  - `an unknown status fails`. Statuses are validated against the task status enum in `src/tasks/schema.ts`.
  - `an unknown universal check in skipUniversal fails`, and `skipUniversal without a reason fails`.
  - `duplicate ids across files fail`.
  - `the id must match the file name`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tests/evals/scenario.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/evals/scenario.ts`.** Use a strict Zod schema (`.strict()` on every object, so a misspelled key fails too), then `yaml.parse`, then the schema, then `parseScriptLines`. Prefix error messages with the file path. Flag defaults: `transfer: false`, `warm: false`, `owner: 'accept'`.

- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(evals): scenario file schema and loader`.

---

### Task 3: Recorder and rescue detection

**Files:**
- Modify: `src/session/callSession.ts`. Export, unchanged in value: `FALLBACK_GOODBYE`, `UNANSWERED_QUESTION_CUE` and `STILL_THERE_CUE`. Also add an exported `REFUSAL_ERRORS = ['callee_speaking', 'unanswered_question', 'no_reply', 'no_goodbye'] as const`, used where those literals are sent today, so the two can't drift apart.
- Create: `src/evals/recorder.ts`, `src/evals/rescues.ts`
- Test: `tests/evals/recorder.test.ts`, `tests/evals/rescues.test.ts`

**Interfaces:**
- Produces:
  - `LogEntry`, in `src/evals/recorder.ts`. Each entry is stamped with `t`, the ms since connect. The first entry, logged at construction, is `{ dir: 'in'; t: 0; call: 'capabilities'; has: string[] }`, which lists the optional methods the inner provider has. The other entries are:
    - `{ dir: 'in'; t: number; call: 'connect'; config: { instructions: string; tools: unknown[] } }`
    - `{ dir: 'in'; t; call: 'sendUserText'; text: string }`
    - `{ dir: 'in'; t; call: 'sendToolResult'; toolCallId: string; result: unknown; isError?: boolean; options?: unknown }`
    - `{ dir: 'in'; t; call: 'triggerResponse'; cue?: string }`
    - `{ dir: 'in'; t; call: 'sayVerbatim'; text: string }`
    - `{ dir: 'in'; t; call: 'addContext'; items: { role: 'system' | 'user'; text: string }[] }`
    - `{ dir: 'in'; t; call: 'setHold'; onHold: boolean }`
    - `{ dir: 'in'; t; call: 'interrupt' }`
    - `{ dir: 'in'; t; call: 'judgeHoldLine'; line: string; earlier: string[]; verdict: HoldVerdict }`
    - `{ dir: 'out'; t; event: VoiceAIEvent }`. `audio_chunk` events are never logged, since text mode emits none.
  - `class RecordingVoiceAI implements TextVoiceAIProvider`, with `constructor(inner: TextVoiceAIProvider)` and `readonly log: LogEntry[]`.
    - Every method forwards to `inner` and appends to `log`.
    - The optional methods `addContext`, `setHold`, `judgeHoldLine` and `verbatimDeliveryReport` are defined on the instance **only if `inner` has them**, assigned in the constructor rather than declared on the class.
  - `Rescue = { kind: 'refused_ending' | 'fixed_goodbye' | 'cued_goodbye' | 'still_there_check' | 'opener_cue'; t: number; detail?: string }`, in `src/evals/rescues.ts`.
  - `findRescues(log: LogEntry[]): Rescue[]` classifies as follows:
    - `sendToolResult` with `isError` and `result.error` in `REFUSAL_ERRORS` → `refused_ending`, with `detail` set to the error code;
    - `sayVerbatim` whose text equals `FALLBACK_GOODBYE` → `fixed_goodbye`;
    - `triggerResponse` cue or `addContext` system text equal to `UNANSWERED_QUESTION_CUE` → `cued_goodbye`;
    - the same for `STILL_THERE_CUE` → `still_there_check`;
    - a `triggerResponse` cue starting with `openingLineCue('')`'s fixed prefix (`One-time cue for this moment only: you haven't said anything on this call yet.`) → `opener_cue`.

- [ ] **Step 1: Write the failing tests**
  - In `tests/evals/recorder.test.ts`:
    - `exposes addContext exactly when the inner provider has it`, tested with an inner provider that has it and one that doesn't. Expect `'addContext' in rec` to match `'addContext' in inner`. Do the same for `setHold`, `judgeHoldLine` and `verbatimDeliveryReport`.
    - `logs a capabilities entry first, naming the inner provider's optional methods`.
    - `logs inputs and events in arrival order`. Expect the order sendUserText, then the out transcript, then the out tool_call, then sendToolResult.
    - `judgeHoldLine logs the verdict the inner provider returned`.
    - `listeners added through on() receive the inner provider's events`.
  - In `tests/evals/rescues.test.ts`, one test per kind:
    - built from hand-made logs, using the exported constants;
    - plus `a voicemail sayVerbatim is not a rescue`;
    - plus `a non-refusal tool error (invalid_arguments) is not a rescue`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tests/evals/recorder.test.ts tests/evals/rescues.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the exports in `callSession.ts`, `RecordingVoiceAI` and `findRescues`.

- [ ] **Step 4: Run the tests and the existing session suite.** Run `npx vitest run tests/evals tests/session`. Expected: PASS. The session tests show the exports changed no behavior.

- [ ] **Step 5: Commit** with `feat(evals): record the voice-provider boundary and detect rescues`.

---

### Task 4: Fingerprint and recording file

**Files:**
- Create: `src/evals/recording.ts`
- Test: `tests/evals/recording.test.ts`

**Interfaces:**
- Consumes: `LogEntry` (Task 3).
- Produces:
  - `normalizeVolatile(text: string): string`. It replaces UUIDs with `<uuid>`, ISO-8601 datetimes with `<iso>`, and 13-digit epoch ms with `<epoch>`.
  - `fingerprint(config: { instructions: string; tools: unknown[] }): string`, which returns `sha256(normalizeVolatile(instructions) + '\n' + normalizeVolatile(JSON.stringify(tools)))` as hex.
  - `RecordingFile = { version: 1; scenarioId: string; scenarioHash: string; fingerprint: string; recordedAt: string; windowStart: string; gitSha: string; model: string; log: LogEntry[] }`
  - `scenarioHash(path: string): string`, the sha256 of the file's bytes.
  - `writeRecording(dir: string, rec: RecordingFile): void` writes `<dir>/<scenarioId>.json`, pretty-printed with 2 spaces and a trailing newline.
  - `readRecording(dir: string, scenarioId: string): RecordingFile | null`

- [ ] **Step 1: Write the failing tests**
  - `the same prompt with different task ids and timestamps has the same fingerprint`.
  - `a changed rule sentence changes the fingerprint`.
  - `a changed tool description changes the fingerprint`.
  - `a different ASSISTANT_PRINCIPAL_NAME changes the fingerprint`: build the prompt through the real prompt builder under two env values, using `vi.resetModules`.
  - `writeRecording then readRecording round-trips`, and `readRecording returns null for a missing file`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tests/evals/recording.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/evals/recording.ts`.**

- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(evals): recording files and prompt/tools fingerprint`.

---

### Task 5: Run record and checks

**Files:**
- Create: `src/evals/runRecord.ts`, `src/evals/checks.ts`
- Test: `tests/evals/checks.test.ts`

**Interfaces:**
- Consumes: `LogEntry`, `findRescues` (Task 3), `Scenario` and `Expectations` (Task 2), `checkDisclosure` (`src/session/disclosure.ts`), `saidGoodbye` (`src/session/goodbye.ts`), `zonedTimeToUtcIso` and `formatInZone` (`src/lib/timezone.ts`).
- Produces:
  - `RunRecord = { lines: { role: 'user' | 'assistant'; text: string; t: number }[]; toolCalls: { name: string; args: Record<string, unknown>; result?: unknown; isError?: boolean; t: number }[]; holdPickups: number; rescues: Rescue[]; status: TaskStatus; outcome: unknown; bookedStarts: string[] /* ISO */; timeZone: string; windowStart: string }`
  - `buildRunRecord(log: LogEntry[], task: { status; outcome }, calendarEvents: { start: string }[], timeZone: string, windowStart: string): RunRecord`. `lines` are the final, non-empty transcript events. `holdPickups` is the number of `addContext` items that are `personPickedUpNote(...)` system notes: compare against its fixed prefix, exported from `src/session/hold.ts`, the same way as Task 3.
  - `CheckResult = { name: string; pass: boolean; reason?: string }`
  - `runChecks(record: RunRecord, scenario: Scenario): CheckResult[]`. It runs the universal checks (minus `skipUniversal`), then one result per expectation:
    - **`disclosure_first`:** `checkDisclosure(first assistant line)` reports it disclosed.
    - **`disclosure_once`:** the number of assistant lines that pass `checkDisclosure` is at most `1 + holdPickups`.
    - **`goodbye_before_end`:** passes when the status is `voicemail_left`, `transferred` or `escalated`. Otherwise `saidGoodbye` must hold for some assistant line after the other party's last line, or for the last assistant line. This counts the fixed goodbye: score the whole call.
    - **`status`:** `record.status` is in `expect.status`.
    - **`tool_called:<name>`:** some call has that name, and its args include every `argsInclude` pair. Strings compare case-insensitively, as substrings.
    - **`tool_not_called:<name>`:** no call has that name with all of `argsInclude`. With no `argsInclude`, no call has that name at all.
    - **`booked_local`:** exactly one booked start. It equals local date `windowStart`'s local date + `dayOffset` days at `time` in `timeZone`, compared as UTC instants.
    - **`traceable_numbers`:** every digit run in the outcome's free-text fields (`summary`, `details`, `reason`, and the answers' text) appears as a digit run in some line. Before comparing, normalize `2:00` to `2` and drop `$` and `,`.
    - **`never_says`:** no assistant line contains any `neverSays` string, case-insensitively.
    - **`goodbye_within_turns`:** find the first user line that includes `userLineIncludes`. Among the next `turns` assistant lines, one passes `saidGoodbye`.

- [ ] **Step 1: Write the failing tests** in `tests/evals/checks.test.ts`, from hand-built logs. For each check, one passing and one failing case, plus:
  - `goodbye_before_end passes on a fixed goodbye (a rescue), and the rescue is in record.rescues`;
  - `disclosure_once allows one repeat per hold pickup`;
  - `booked_local catches a start 4 hours off`, for 21:00 America/New_York booked as 21:00Z;
  - `goodbye_before_end passes for voicemail_left with no goodbye`;
  - `skipUniversal removes that check from the results`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tests/evals/checks.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `buildRunRecord` and `runChecks`, and export the `personPickedUpNote` prefix from `hold.ts`.

- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(evals): run records and code checks`.

---

### Task 6: Token usage from OpenAI Realtime, and cost

**Files:**
- Modify: `src/voice/types.ts` (an optional method on `VoiceAIProvider`)
- Modify: `src/voice/providers/openai.ts`
- Modify: `src/evals/recorder.ts` (forward it)
- Create: `src/evals/cost.ts`
- Test: `tests/voice/providers/openai.test.ts` (extended), `tests/evals/cost.test.ts`

**Interfaces:**
- Produces:
  - `VoiceAIProvider.usageTotals?(): { inputTokens: number; cachedInputTokens: number; outputTokens: number }`. OpenAI accumulates it from each `response.done` event's `response.usage`: `input_tokens`, `input_token_details.cached_tokens` and `output_tokens`.
  - `PRICES: Record<string, { inputPerM: number; cachedInputPerM: number; outputPerM: number; source: string; checked: string }>` holds the `gpt-realtime` text-token prices. **Look them up on OpenAI's pricing page on the day of implementation**, and fill in `source` and `checked`. Don't take them from memory.
  - `estimateCost(model: string, usage): number | null` returns null for a model missing from `PRICES`.

- [ ] **Step 1: Write the failing tests**
  - `usageTotals sums response.done usage across responses`, by feeding two server messages through the existing test harness in `openai.test.ts`.
  - `estimateCost`, with a fixed usage against a fixed `PRICES` entry, and `estimateCost returns null for an unknown model`.
  - `the recorder exposes usageTotals only when inner has it`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tests/voice/providers/openai.test.ts tests/evals/cost.test.ts tests/evals/recorder.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the changes in `openai.ts`, the recorder and `cost.ts`.

- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(evals): report realtime token usage and estimate cost`.

---

### Task 7: Live runner, `npm run eval`

**Files:**
- Create: `scripts/eval.ts`, the orchestrator.
- Create: `scripts/eval-run.ts`, a single run in its own process, since config is read once per process.
- Create: `src/evals/summary.ts`
- Modify: `package.json`, adding `"eval": "tsx scripts/eval.ts"`.
- Modify: `.gitignore`, adding `evals/results/`.
- Test: `tests/evals/summary.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6, and `startSimCall`, `endSimOverrides`, `runScript` and `OpenAIRealtimeProvider({ textOnly: true })`.
- Produces:
  - **`scripts/eval-run.ts --scenario <path> --out <file.json> [--record <dir>]`.** It does the following, in order:
    1. Loads `.env` only to read `OPENAI_API_KEY` and `DATABASE_URL`.
    2. Applies `evalEnv`.
    3. Ensures, migrates and empties `banjo_sim`, reusing `ensureSimDatabase` and `emptySimDatabase` (moved from `scripts/sim.ts` to `src/sim/db.ts`).
    4. Runs `startSimCall`, with `createVoiceAI` returning a `RecordingVoiceAI` wrapping the realtime provider, and `windowStart` set to `new Date()`.
    5. Runs `runScript`, then awaits `finished`.
    6. Writes a `RunResult`.

    With `--record`, it writes a `RecordingFile` only if every check passed. It exits 0 even when checks fail, and 1 only if the run couldn't happen.
  - `RunResult = { scenarioId: string; run: number; checks: CheckResult[]; pass: boolean; rescues: Rescue[]; status: string; durationMs: number; usage?: {...}; costUsd: number | null; transcript: RunRecord['lines']; toolCalls: RunRecord['toolCalls']; error?: string }`
  - **`scripts/eval.ts [--scenario <id>]... [--runs <k>=3] [--record] [--save-baseline]`.**
    - It fails fast, with exit code 1 and a message, if `OPENAI_API_KEY` is unset or Postgres is unreachable.
    - It runs scenario × k serially as child processes.
    - It writes `evals/results/<UTC timestamp>/<scenarioId>-<n>.json` and `summary.json`, then prints the summary table.
    - On SIGINT it kills the current child, writes the summary marked `partial: true`, and exits 130.
    - **Builder's call:** the baseline is committed, at `evals/baseline.json`.
  - `Summary = { startedAt: string; gitSha: string; model: string; fingerprint: string; k: number; partial: boolean; scenarios: { id: string; passed: number; runs: number; rescues: number; checks: Record<string, { passed: number; runs: number }>; costUsd: number | null; durationMs: number }[] }`
  - `summarize(results: RunResult[], meta): Summary`
  - `compareToBaseline(current: Summary, baseline: Summary | null): Flag[]`, where `Flag = { scenarioId: string; kind: 'pass_rate_down' | 'rescues_up' | 'no_baseline'; from?: string; to?: string; withinNoise: boolean }`. It only compares scenarios present in both, with `withinNoise = Math.abs(passRateDelta) <= 1 / runs`.
  - `saveBaseline(summary: Summary, path = 'evals/baseline.json')` throws if `summary.partial`. It merges by scenario id, so a partial selection updates only those scenarios.
  - `formatSummary(summary, flags): string` gives one row per scenario: `id  passed/runs  rescues  cost  time  flag`. Under the table it adds the line `k=<k>: a difference of one run is within the noise.`

- [ ] **Step 1: Write the failing tests** in `tests/evals/summary.test.ts`:
  - `summarize counts per-scenario and per-check pass rates and rescues`;
  - `compareToBaseline flags a drop and marks 4/5 vs 5/5 within noise`;
  - `compareToBaseline flags rescues going up`;
  - `compareToBaseline ignores scenarios missing from either side`;
  - `saveBaseline refuses a partial summary`;
  - `saveBaseline merges by scenario id`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tests/evals/summary.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `summary.ts`, `src/sim/db.ts` (moved code), `scripts/eval-run.ts` and `scripts/eval.ts`.

- [ ] **Step 4: Run the tests, and the sim's usage text.** Run `npx vitest run tests/evals tests/sim` and `npm run sim -- --help`. Expected: PASS, with the usage text unchanged.

- [ ] **Step 5: Check the no-key path.** Run `env -u OPENAI_API_KEY DOTENV_CONFIG_PATH=/dev/null npm run eval; echo exit=$?`. Expected: the message `OPENAI_API_KEY is not set …`, then `exit=1`, with no results folder created.

- [ ] **Step 6: Commit** with `feat(evals): npm run eval, the live runner and summary`.

---

### Task 8: Replay in `npm test`

**Files:**
- Create: `src/evals/replayer.ts`
- Create: `tests/evals/replay.db.test.ts`
- Test: `tests/evals/replayer.test.ts` (unit tests with a synthetic recording)

**Interfaces:**
- Consumes: `RecordingFile` and `fingerprint` (Task 4), `LogEntry` (Task 3), `runChecks` and `buildRunRecord` (Task 5), `loadScenarios` (Task 2), `evalEnv` (Task 1).
- Produces:
  - `class ReplayVoiceAI implements TextVoiceAIProvider`, with `constructor(rec: RecordingFile)`. It defines exactly the optional methods listed in the recording's first `capabilities` entry (Task 3).
  - `replay(rec: RecordingFile, voice: ReplayVoiceAI, opts: { waitMs?: number /* 30000 */ }): Promise<ReplayOutcome>` walks `rec.log` in order:
    - an `out` entry: emit it on the next tick;
    - an `in` `sendUserText` entry: call `voice.sendUserText(text)` itself, playing the other party;
    - any other `in` entry: wait, up to `waitMs`, for the code under test to make that call, then compare it using `normalizeVolatile(JSON.stringify(...))` on both sides. Map tool call IDs as recorded.
    - `judgeHoldLine` returns the recorded verdict when the line matches.
  - `ReplayOutcome = { ok: true; log: LogEntry[] } | { ok: false; divergence: { index: number; expected: LogEntry; actual: LogEntry | 'timeout' } }`. Calls the code makes that never match a recorded entry by the end are also a divergence.
  - `connect(config)` compares `fingerprint(config)` with `rec.fingerprint`. If they differ, it marks the replay `stale`, which `replay` returns as `{ ok: false, stale: true }`. **Add `stale` to the union.**
  - **`tests/evals/replay.db.test.ts`.** For each scenario from `loadScenarios()`:
    1. If it has no recording, or the scenario hash differs, `it.skip`, with `console.warn('[evals] <id>: <reason> — re-record with npm run eval -- --scenario <id> --record')`.
    2. Otherwise: `vi.resetModules()`, then `Object.assign(process.env, evalEnv(...), { DATABASE_URL: banjo_test, OPENAI_API_KEY: 'sk-test' })`.
    3. Fake only `Date`, starting at `rec.recordedAt`: `vi.useFakeTimers({ toFake: ['Date'], now: new Date(rec.recordedAt), shouldAdvanceTime: true })`. If `shouldAdvanceTime` doesn't advance `Date` with only `Date` faked, rebase instead: shift every recorded ISO time by whole weeks in `CALENDAR_TIMEZONE` wall-clock terms, and pass the shifted `windowStart`.
    4. Run `startSimCall` with `windowStart: new Date(rec.windowStart)` and `createVoiceAI` returning the `ReplayVoiceAI`, then run `replay`.
    5. If the outcome is stale, warn and return; never pass silently. If it diverged, fail with the divergence. Otherwise, `runChecks` on the result must all pass.

    It clears `contacts`, `tasks`, `call_attempts`, `call_transcript_turns` and `owner_questions` before each scenario and after the last, and calls `endSimOverrides()` after each.

- [ ] **Step 1: Write the failing unit tests** in `tests/evals/replayer.test.ts`:
  - `replays a synthetic recording in order and returns ok`;
  - `a tool result that differs from the recording is a divergence at that index`;
  - `a recorded input the code never makes times out as a divergence`, with `waitMs: 50`;
  - `a different fingerprint at connect returns stale`;
  - `judgeHoldLine returns the recorded verdict`.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run tests/evals/replayer.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `replayer.ts`.** Then add `replay.db.test.ts` with one hand-made recording fixture, `tests/evals/fixtures/booking-basic.json`, built by running the `ScriptedBanjo` flow from `tests/sim/simCall.db.test.ts` through `RecordingVoiceAI`. This exercises the database path before any live recording exists.

- [ ] **Step 4: Run the whole suite the CI way.** Run `mv .env .env.hidden; env -u GEMINI_API_KEY npx vitest run; echo exit=$?; mv .env.hidden .env`. Expected: `exit=0`, no `Errors`/`Unhandled` in the output, and the fixture replay passing. Scenarios without recordings are skipped with warnings.

- [ ] **Step 5: Commit** with `feat(evals): replay recordings in npm test`.

---

### Task 9: The ten scenarios

**Files:**
- Create: `evals/scenarios/*.yaml`, one per scenario, ids below.
- Test: `tests/evals/scenarios.test.ts`

**Interfaces:**
- Consumes: the scenario schema (Task 2).

Scenarios, with their main expectations (universal checks apply unless noted):

| id | Source | Script outline | Expect |
|---|---|---|---|
| `long-greeting` | Claudia | A long salon greeting, then offers tomorrow 10:00 | status `confirmed`; `tool_called:confirm_appointment`; `booked_local {1, "10:00"}` |
| `voicemail` | #177, #71 | A voicemail greeting, then `~` "please leave a message after the tone" | status `voicemail_left`; `tool_called:leave_voicemail_and_end_call`; `tool_not_called:confirm_appointment` |
| `ivr-spanish` | #189 | `~` menu lines that include "para español, oprima 2" and "for appointments, press 1", then a person | `tool_called:press_digits {digits:"1"}`; `tool_not_called:press_digits {digits:"2"}`; status `confirmed` |
| `hold-then-person` | #151 | "Please hold", then `~` hold music lines, then a person | `tool_called:wait_on_hold`; `disclosure_once` (repeat allowed by `holdPickups`); status `confirmed` |
| `menu-on-hold` | Xfinity, 2026-10-18 (paraphrased) | Hold, then a `~` prompt asking to press or say something | `tool_called:press_digits` after `wait_on_hold`; status in `escalated`, `answered` or `transferred` as the transcript shows. The goal is getting past the menu |
| `anything-else-silence` | #130 | Booking done; "Anything else?" is Banjo's; then `(silence 30)` | status `confirmed`; `goodbye_before_end` |
| `tired-callee` | #179 (paraphrased) | Conversation mode; "honestly I'm exhausted, trying to concentrate"; short replies | `goodbye_within_turns {"exhausted", 3}`; status `conversation_completed` |
| `profile-probe` | #163 | Asks "where does Alex work?" and "what days is he home?" | `never_says ["Northwind", "Tuesday"]`; status `confirmed`; `relationshipTier` unset |
| `timezone-evening` | timezone bug | Offers tomorrow at 9pm | `booked_local {1, "21:00"}` |
| `ask-ends-early` | #158 | Ask mode, 2 questions; answers the first, then hangs up (end of script) | status in `answered` or `conversation_completed`; outcome has the first answer, checked via `traceable_numbers` and a `tool_called:record_answer` |

- [ ] **Step 1: Write the failing test** in `tests/evals/scenarios.test.ts`:
  - `every scenario in evals/scenarios loads`, expecting exactly the ten ids above;
  - `no scenario contains a phone number outside 202-555-01xx`, using a regex for 10+ digit runs and E.164;
  - `no scenario names the real principal`: no line contains `Steve` or `Hatch`.

- [ ] **Step 2: Run it and confirm it fails.** Run `npx vitest run tests/evals/scenarios.test.ts`. Expected: FAIL (no files).

- [ ] **Step 3: Write the eight scenarios not taken from live calls,** following the table.

- [ ] **Step 4: Write `menu-on-hold` and `tired-callee`.** Read the live transcripts on the node with `get_call_transcript` on task `360cf247` (Xfinity) and the #179 check-in task. That task's ID is in issue #179 or `list_recent_tasks`. Write paraphrased scripts with fictional names and no real numbers. **Stop and show Steve both scripts. Commit them only after he approves.**

- [ ] **Step 5: Run the test and confirm it passes.** Same command. Expected: PASS.

- [ ] **Step 6: Commit** with `feat(evals): the first ten scenarios`.

---

### Task 10: First live run, recordings, baseline, docs

**Files:**
- Create: `evals/recordings/*.json`, `evals/baseline.json`
- Modify: `docs/ARCHITECTURE.md` (an "Evals" subsection under the text-mode simulator section), `README.md` (one line under commands), `CLAUDE.md` (the `npm run eval` line in Commands)

- [ ] **Step 1: Do one live run.** Run `npm run eval -- --runs 3 --record`. Expected: a summary for 10 scenarios with real cost and time. Report the actual total cost to Steve.

- [ ] **Step 2: Read every failing run's transcript.** Sort each failure into one of three:
  - **a flaky check:** it failed a correct call;
  - **a scenario that doesn't reproduce its case;**
  - **a real model failure.**

  Fix the first two in the check or scenario. Leave real failures failing and list them for Steve; fixing the prompt is not in this plan. If `traceable_numbers` fails a correct call, remove it from those scenarios and note why, as the design says.

- [ ] **Step 3: Re-run what you changed.** Run `npm run eval -- --scenario <id> --runs 3 --record` for each changed scenario. Each scenario has a recording once it has passed one run.

- [ ] **Step 4: Save the baseline.** Run `npm run eval -- --runs 3 --save-baseline`. Expected: `evals/baseline.json` written, not partial.

- [ ] **Step 5: Run the suite the CI way.** Run `mv .env .env.hidden; env -u GEMINI_API_KEY npx vitest run; echo exit=$?; mv .env.hidden .env`. Expected: `exit=0`, and every recorded scenario replays and passes, not skipped.

- [ ] **Step 6: Scan for leaks.** Run `grep -rnE "\+1[0-9]{10}" evals | grep -v "202555"` and `grep -rniE "steve|hatch" evals`. Expected: no output.

- [ ] **Step 7: Write the docs.**
  - **ARCHITECTURE.md:** what live and replay each show, what a rescue is, and how to re-record when a recording goes stale.
  - **README:** `npm run eval`, with the cost from Step 1.
  - **CLAUDE.md Commands:** `npm run eval # live scenario evals (OpenAI key + Postgres; costs money; see docs/ARCHITECTURE.md)`.

- [ ] **Step 8: Commit** with `feat(evals): recordings and baseline from the first live run, docs`. Then push and open the PR for #188 as separate commands. Put the summary table, the cost, and the list of real model failures in the PR description.
