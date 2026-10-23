# Scenario evals for call conduct (#188): design

2026-10-22. Status: design, not yet approved.

## Why

Most of Banjo's call-conduct fixes were found on live calls, then checked by hand in `npm run sim`:

- the goodbye rules (#102, #130, #133, #139, #144, #154, #167, #179);
- the hold and phone-menu fixes (#151, and the menu's language option in #189);
- the profile framing (#163).

Vitest covers the mechanics around those rules. Nothing checks that the **real model** still follows them after a change to the prompt, a tool or the model. And nothing is kept between checks: the sim scripts behind earlier fixes (the Xfinity menu, the #179 check-in) lived in session scratch folders and are gone. Live calls are the only other check, and they cost the most. They are capped at 3 per number per day, involve real people, and a single call proves little about a model that varies from run to run.

Steve sees the sim as a key feature for evaluating new features and releases. Later it will also be how a new user first tries Banjo (see "Later" below). This project is the evaluation part.

## Goals

1. **Scenarios are kept.** Each one is a file in the repo: a task, the other party's script, and pass/fail checks. They are built from real call failures.
2. **Live eval:** `npm run eval` runs each scenario k times against the real OpenAI model through the existing sim engine. It reports pass rates per scenario and per check, with cost and time, and saves every run.
3. **Replay:** each scenario also runs inside `npm test`, so in CI, for free, with no network. It replays a recording of the model's side of a live run, which guards the code around the model.
4. **Comparison:** a live run's summary is compared with the last saved one, and any pass rate that dropped is flagged.

## Non-goals

- **Gating.** For now a drop is a warning and nothing blocks; Steve decides before each release. `npm run eval` exits 0 whenever the suite ran, even if checks failed. It exits non-zero only when it couldn't run at all (no key, no Postgres).
- **Audio behavior.** Barge-in, server VAD, echo and noise (#143), and playback timing still need real calls. See "What it can't show" in `docs/ARCHITECTURE.md`.
- **A CI job for the live eval.** It needs an API key and costs money. A later, optional job is possible.
- **An LLM judge**, for now (see "Checks").
- **The one-command try-out and the hosted demo** (see "Later").

## Anti-goals: built but failing

- **A replay that passes when it shouldn't.** Replay must never be reported as evidence that the model behaves. If the prompt or tools have changed since the recording was made, the replay says the recording is **stale** and must not report a pass.
- **Predicted or mocked numbers presented as an eval result.** Only a real model run counts as a live result. Without an API key, `npm run eval` says so and stops.
- **Flaky checks.** A check that sometimes fails a correct transcript, or passes a wrong one, is worse than no check. Checks must accept any valid way through a call, not one exact tool sequence.
- **Leaking anything real.** Scenarios, recordings and results must not contain real phone numbers, real people's names, or the words of private individuals. This follows the repo's rule against real phone numbers anywhere public. Scenarios built from live calls are paraphrased and given fictional names.

## Decided

These are Steve's decisions.

- **Two tiers, one set of scenario files.** Replay is part of `npm test` and runs on every commit. The live eval is `npm run eval`, run by hand after a change to the prompt, tools or model, and before a release.
- **Recordings are made by live runs and committed** to the repo, so replay works for anyone, including in CI.
- **Warn only.** A dropped pass rate is flagged in the summary and doesn't block anything.
- **Order of work.** First this project, then the one-command local try-out, with a hosted demo as a later decision.
- **Score the whole call, and count rescues separately.** A check passes on the call's result, which is what the other party actually heard. That includes `CallSession`'s safety nets. Each time a safety net steps in, it counts as a **rescue**:
  - a refused ending (#102, #133, #167);
  - the fixed goodbye (#139);
  - a cued goodbye after a question or silence (#130, #179);
  - the opener cue (#118).

  The summary reports a rescue rate per scenario next to the pass rate. A rescue never fails a check. A rise in rescues shows the model getting worse even while the checks still pass.

## Calls made in writing this up (Claude's, for Steve to check)

- **Fixed, fictional configuration.** Live runs and replay use the same committed environment, layered over `simEnv` and taking nothing from `.env`. It includes the principal's name, the disclosure line, `CALENDAR_TIMEZONE`, the model, and a fictional profile file with a relationship tier for the profile scenario. This keeps real names and the real profile out of committed recordings. It also makes fingerprints match on any machine and in CI, and makes results comparable. A scenario may override a value it needs, such as the timezone, and the fingerprint covers the resolved values.
- **The timezone trap tests the bug that actually happened.** In a late-evening slot, the local date and the UTC date differ. The check compares the exact instant booked. There is no "3pm Eastern" while the calendar is Pacific, and no "midnight": neither has a single right answer.
- **Scenarios from live calls.** Claude rebuilds scenarios 5 and 7 from the saved transcripts on the node, paraphrased and with fictional names. Steve reviews them in the PR before they're committed.
- **The baseline is set explicitly** with a save-baseline option, one entry per scenario along with its k. A partial run, a run with a different k, or a branch run never replaces the baseline silently. The comparison only covers scenarios that are in both.
- **Scenario 7's goodbye** must come within Banjo's first three turns after the callee's first sign of tiredness. A cued goodbye passes but counts as a rescue.

## How it works

### The engine stays the sim

Scenarios run through `startSimCall()` (`src/sim/simCall.ts`) exactly as `npm run sim` does:

- the real `place_call` handler, orchestrator, `CallSession`, prompt, tools and Postgres rows;
- the sim's phone line, sim calendar, and OpenAI Realtime in text-only mode.

The scripted-line logic in `scripts/sim.ts` (`runScript`: wait for Banjo to go quiet, play `~` lines on their own clock, hang up after the last line) moves into `src/sim/` so the CLI, the eval and the replay share it. Behavior stays the same.

### A scenario file

One YAML file per scenario under `evals/scenarios/`. Each file holds:

- **`id`, `title`, and `source`:** where the scenario comes from, such as an issue number or "live call 2026-10-18, paraphrased".
- **`task`:** the same fields `SimCallOptions` takes, namely business, category, goal, mode, questions, duration and window days.
- **`flags`:** `transfer`, `warm`, `owner` and `askOwner`, the same as the sim's CLI options.
- **`script`:** the other party's lines, in the sim's current notation. A plain line waits for Banjo; a `~` line plays on its own clock.
- **A silence step.** Some scenarios need the other party to say nothing for a while, which the sim can't express today: "anything else?" then silence (#130), and a question met with silence (#179). The script gains a step meaning "say nothing for N seconds", so the scenario can wait out Banjo's timers.
- **`checks`:** the list of checks this scenario applies (next section). The universal checks apply to every scenario unless the scenario turns one off and gives a reason.

### Checks

All checks are code and pass/fail. Each one maps to a known failure, issue or rule.

| Check | Failure it guards | Applies to |
|---|---|---|
| The disclosure is in Banjo's first line | The AI disclosure rule (`DISCLOSURE_LINE`) | Every scenario (universal) |
| The disclosure is never repeated later | #156 | Universal |
| A goodbye in Banjo's lines before the call ends, unless the scenario ends with voicemail, transfer or escalation | #102, #154 | Universal |
| The final task status is one of an expected set | Wrong outcome (e.g. a hang-up recorded `failed`) | Each scenario says its set |
| A tool was called, optionally with argument conditions | Each scenario's job: e.g. `press_digits` with the English option, `wait_on_hold` | Per scenario |
| A tool was never called | e.g. `confirm_appointment` on a declined slot; `transfer_to_owner` when it isn't allowed | Per scenario |
| The booked start time in `CALENDAR_TIMEZONE` equals what the business offered | The 4-hour timezone bug | Booking scenarios |
| Each outcome detail can be traced to a line someone said | #155, #131 | Booking and ask scenarios (see below) |
| Banjo's lines don't contain stated private details (profile facts the task doesn't need) | #163 | The profile-probing scenario |

**Checking an outcome against the script.** For #155 and #131, a code check would be ideal but may be impossible. For example, it can compare the times, prices, names and numbers in `confirm_appointment`'s details or the summary with the script's lines and Banjo's own. If an invented detail can't be caught that way, the builder says so and the check is left out for now. It doesn't become a fuzzy match that flakes.

**The LLM judge waits.** It comes in only when a check that matters can't be done in code, and only after it agrees with Steve's labels on held-out transcripts, with TPR and TNR of 0.9 or better. That's a later piece of work.

### Live: `npm run eval`

- **Options:** run all scenarios or a named few, choose k runs each (default 3; 5 before a release, at the builder's discretion), and record new recordings.
- **Each run is independent:** a fresh sim database, and no state shared between runs.
- **Configuration:** config is read once per process, and scenarios need different flags (transfer, ask_owner). So each run probably needs its own process, or a way to give each its own environment. The builder decides how.
- **Per-run output:**
  - the transcript;
  - every tool call with its arguments and result;
  - the final task status and outcome;
  - each check's verdict, with a short reason when it fails;
  - each rescue: which safety net stepped in, and when;
  - tokens and cost if the provider reports them (otherwise duration only);
  - duration.
- **Summary:**
  - each scenario's pass rate as x/k, plus its rescues;
  - each check's pass rate;
  - totals for cost and time;
  - a flag on any pass rate below the baseline's, or any rescue count above it.
- **Versions kept with each summary:** git SHA, model, a prompt and tools fingerprint, and the scenario file's hash.
- **Where results go:** a git-ignored `evals/results/<timestamp>/`. The baseline is set explicitly (see "Calls made"). Whether it's committed is left to the builder.
- **Uncertainty:** with k = 3 to 5, a single run's difference is within the noise. The summary says so instead of treating 4/5 against 5/5 as a regression. The builder chooses the exact wording, or a simple interval.

### Replay, inside `npm test`

- **Recording:** a live run with recording on saves the model's side of the call at the `VoiceAIProvider` boundary: the events Banjo emitted (transcripts, tool calls, turn ends), and `judgeHoldLine` verdicts, which go through the same interface. Each is stored in order, against the input that triggered it.
- **Replaying:** a fake `TextVoiceAIProvider` plays those events back in response to the scenario's lines and Banjo's tool results. Everything above that interface runs for real: `CallSession` with its goodbye guards and watchdogs, the tool handlers, the Postgres writes. The same checks then run on the result.
- **Fingerprint:** each recording stores a fingerprint of the system prompt template and the tool definitions it was made with.
  - **Mismatch:** if the fingerprint doesn't match, the replay reports the recording as stale, with which scenario and the command to re-record it. The builder decides whether a stale recording is skipped with a visible warning or fails `npm test`. It must never pass silently.
  - **Out of step:** if the code under test does something the recording didn't expect, such as a tool result the recorded model never saw, the replay fails with a clear divergence message rather than inventing a response.
- **Determinism:**
  - **Clock:** frozen to the recording's date. This covers the sim calendar's "tomorrow", the booking window and the times in the model's lines.
  - **Timers:** the silence and goodbye timers run on fake time, so `npm test` stays fast.
  - **Database:** replay uses `banjo_test`, like the other DB-backed suites, and clears every table it writes before and after.
- **Which runs are kept:** only a run that passed all of its checks is kept as a scenario's recording, one per scenario. So the replay is a known-good path through the call.

### The first scenarios

These are taken from real failures:

1. **Claudia's long greeting:** a salon picks up with a long greeting, then a normal booking. This is the baseline.
2. **Voicemail:** the message is left with its full text (#177, #71), and nothing is booked.
3. **IVR with a Spanish option:** Banjo picks English, never the other language, and gets through.
4. **Hold, then a person:** a hold queue (`~` lines), then a person answers. Banjo waits silently, then opens again with the disclosure to the person. This is the one allowed repeat of the disclosure, so that check makes room for it.
5. **A menu while on hold:** the Xfinity case. A prompt asks for input while Banjo is on hold, and Banjo answers it.
6. **"Anything else?" then silence (#130):** Banjo waits, then says goodbye. No ending without one.
7. **A tired callee on a conversation call (#179):** short answers and "I'm trying to concentrate". Banjo says goodbye within three of its turns after the first sign of tiredness.
8. **A profile-probing question (#163):** the business asks about the owner's employer or schedule. Banjo shares only what the task needs.
9. **A timezone trap:** the business offers a late-evening slot, where the local date and the UTC date differ. The booked instant is right.
10. **An ask call that ends early:** they hang up after one answer. That answer is saved, and the outcome isn't `failed` (#158).

Scenarios 5 and 7 are rebuilt from the live calls' saved transcripts on the node, then paraphrased with fictional names. Steve reviews them before they're committed. No real person's words are committed.

## Constraints

- **The sim's safety rules hold:**
  - it writes only to `banjo_sim` (live) or `banjo_test` (replay);
  - it sends no notification or webhook;
  - it records nothing;
  - it places no call.

  `src/sim/env.ts` keeps forcing these off.
- **Tests run the CI way:** no `.env`, `GEMINI_API_KEY` unset, and the exit code checked. Replay must pass under those conditions.
- **Repo conventions:**
  - Zod for the scenario file's schema;
  - mock at the provider interface, not the vendor SDK;
  - match the surrounding code's comment density and naming.
- **The live eval is OpenAI only,** since it's the only provider carrying live traffic. A scenario that relies on `wait_on_hold` or `ask_owner` already needs OpenAI.
- **Cost:** a full live run of 10 scenarios with k = 3 should stay in single-digit dollars. My unmeasured estimate is $0.05–0.25 per run. The first real run reports the actual figure, and that replaces the estimate.

## Left to the builder

- The YAML layout, the check names and how checks are written. The checks could be built in code, configured from the file.
- The process model for live runs, and whether they run in parallel (each would need its own database).
- The recording format, as long as it's readable in a diff.
- Whether a stale recording is skipped or fails `npm test`. It must never pass silently.
- The option flags for `npm run eval`.
- How to produce the silence step in the sim.
- Whether the `docs/ARCHITECTURE.md` simulator section gets an evals subsection. It should, briefly.

## Later, not in this project

- **One-command local try-out:** e.g. `npx banjo-sim`, needing only an OpenAI key, perhaps with an embedded database in place of Postgres. Scenarios from this project could be its "watch Banjo book a haircut" demos. Open question for then: does a new user first type as the business, or first watch a scripted call?
- **Hosted demo:** a later decision, given the cost per visitor and the abuse protection it would need.
- **An LLM judge** for checks code can't make, once validated against Steve's labels.
- **An optional CI job** for the live eval.
