# Owner approval for calls an agent asks for: design

**Status:** draft for review, 2026-10-14
**Follows:** the handoff item "a hard (Banjo-side) confirmation gate on place_call"

## Why

Hermes (and any other always-on agent) can call `place_call`, and agents read text that came from outside: webhook payloads, call transcripts, iMessages. Hermes's own "confirm before `place_call`" rule lives in its prompt (SOUL.md), so a steered or confused agent can skip it, and Hermes has no per-tool approval of its own. A real phone call to a real business is the one action here that can't be taken back.

The goal: **a call an agent asks for never dials until the owner has taken an action the agent cannot reach.** Calls the owner places from Claude Code (the `schedule-appointment` skill) are unchanged.

## What the owner sees

1. Hermes asks Banjo for a call. Banjo creates the task and sends a Pushover message (or SMS, whichever `NOTIFICATION_CHANNEL` is):
   > Hermes wants to call Luigi's (+1…) now: "Book Friday at 7." Approve within 30 min: https://banjo.example/approve/…
2. The owner taps the link. A small page shows who will be called, when, the mode, the full task description and any questions, plus an **Approve** button.
3. Tapping **Approve** lets the call go ahead (now, or at its scheduled time). Ignoring the message lets it expire after 30 minutes: it is cancelled and never dials. To call it off sooner, the owner uses `cancel_task` (from Claude Code, or by asking the agent).

The link opens a page rather than approving directly, so a link preview or prefetch can't approve anything.

## Design

### 1. Two keys, two roles

- New optional setting **`MCP_AGENT_API_KEY`** (at least 32 characters, must differ from `MCP_API_KEY`).
- `requireAuth` (`src/mcp/server.ts`) returns the caller's role instead of a boolean: `'owner'` for `MCP_API_KEY`, `'agent'` for `MCP_AGENT_API_KEY`, `null` otherwise. Both comparisons stay constant-time.
- `createMcpServer({ role })` passes the role to `place_call`'s handler. For the legacy SSE transport, the role is fixed when the stream opens, and a `POST` to that session must authenticate with the same role.
- Only `place_call` behaves differently by role. Every other tool is unchanged for both keys.
- When `MCP_AGENT_API_KEY` is unset, there is no agent role and nothing changes.

The key is the security anchor: the role comes from the credential, never from anything the caller says, so an agent can't talk its way past the gate.

### 2. The task carries the approval

Two nullable columns on `tasks` (one migration, no new status):

| Column | Meaning |
|---|---|
| `approval_expires_at` | Set only on a task an agent asked for: the request time plus 30 minutes. Null means no approval is needed. |
| `approved_at` | Set when the owner approves. |

A task **waits for approval** while `approval_expires_at` is set and `approved_at` is null. It stays in status `pending`, so nothing that reads statuses needs to learn a new one.

- `listStartableTasks` and `runTask` (`src/tasks/orchestrator.ts`) skip a task that is waiting for approval. The skip happens before the `pending → checking_availability` claim, so an unapproved task can never reach a status that resumes after a restart.
- **Approve** is a compare-and-set: set `approved_at = now()` where `status = 'pending'`, `approved_at IS NULL` and `approval_expires_at > now()`. If no row matches, the page says the request already expired, was cancelled, or was approved. On success, Banjo calls `triggerOrchestration` (which waits for `scheduledFor` as it does today).
- **Expiry** is a poller step next to `sweepStaleCalls`: move `pending → cancelled` (through `transitionTask` with `from: ['pending']`) for tasks where `approved_at IS NULL` and `approval_expires_at <= now()`. Because approve and expiry both condition on the same row, only one of them wins.
- `get_task_status` and `list_recent_tasks` gain `approval`, present only on tasks that needed it: `'waiting'` (pending, not yet approved), `'approved'` (`approved_at` set), or `'not_approved'` (cancelled before approval, whether it expired or someone cancelled it).

### 3. The signed link

- URL: `https://${PUBLIC_HOSTNAME}/approve/<taskId>?sig=<hex>`.
- `sig` is an HMAC-SHA256 of `<taskId>.<approval_expires_at as epoch ms>`, keyed by a key derived from `MCP_API_KEY` (HMAC of the fixed label `banjo-approval-v1`). The owner key never leaves the server, so an agent holding only the agent key can't forge a link. Nothing is stored, and rotating `MCP_API_KEY` voids any links still waiting (they then just expire).
- `GET /approve/:taskId` checks `sig` (constant-time) and renders the details page. It changes nothing.
- `POST /approve/:taskId` (the button, with `sig` in the form body) checks `sig` again and runs the approve compare-and-set.
- A bad or missing `sig` gets the same plain "This link isn't valid" page as an unknown task id, so the page can't be used to probe for task ids.
- The page escapes everything it shows. The task description and questions were written by the agent, so they are shown as plain text, in full: they're exactly what the owner is judging.
- The link appears only in the owner's message. It is never logged, never returned by an MCP tool, and never put in the task webhook.

### 4. `place_call` for the agent role

All existing checks run first and unchanged (input validation, `scheduledFor` rules, the call cap counting queued tasks). Then:

1. **Limit on waiting requests.** If 3 agent requests are already waiting for approval, refuse. A request the agent cancelled still counts until its 30 minutes are up, so cancelling and asking again doesn't get around it. This caps how many notifications a looping or steered agent can send.
2. Create the task with `approval_expires_at = now + 30 min`. Don't trigger orchestration.
3. Send the approval message with `sendOwnerMessage`. It is changed to return whether the message was delivered (like `sendTaskWebhook` after #168). If it wasn't, cancel the task and tell the agent: "Couldn't reach the owner for approval, so no call will be placed."
4. Return: "Asked the owner to approve this call. It will be placed once they approve, or cancelled if they haven't by 9:15 PM. Check get_task_status." The result never contains the link.

### 5. Scheduled calls and the call cap

- **Scheduled calls.** The approval window is always 30 minutes from the request, and a call dials once it is both approved and due. A call scheduled more than 30 minutes out is therefore always approved before its time. One scheduled sooner can be approved after its time and then dials right away; the page says so plainly ("Scheduled for 4:50 PM, 12 minutes ago: approving calls now"), so the owner decides knowingly. This replaces the earlier wording "a scheduled call must be approved before its time", which would leave a call scheduled 2 minutes out almost no time to approve.
- **Call cap.** Agent requests can't override it (section 6). A request waiting for approval is a `pending` task, so it counts as a queued call when the agent asks for another call to that number. The owner's own `place_call` leaves it out, so an agent can't use up the owner's calls by asking; once approved, it counts like any other queued call. The orchestrator's check right before dialing is unchanged, so an approval never lets a call past the cap.

### 6. Owner override of the call cap, for testing

The owner can let a call past `MAX_CALLS_PER_NUMBER_PER_DAY`, for test calls to themselves or to family. This replaces the rule "there's no override" in `CLAUDE.md` and `docs/ARCHITECTURE.md`. Those calls are the ones testing produces: the cap came from 5 test calls to a family member in one evening, so the override keeps its own hard limit.

- **New `place_call` input `overrideCallCap: true`.** It is honoured only with the owner's key. On the agent key, `place_call` refuses the request outright: an agent can never lift the cap, and owner approval links never do either.
- **Only for eligible contacts.** A contact is eligible if its `relationshipTier` is `family`, or its number is the owner's own (`TRANSFER_TO_PHONE_NUMBER` or `NOTIFY_TO_PHONE_NUMBER`). Neither can be changed through MCP, so a call can't make a business eligible. For anyone else, `place_call` refuses with "The call cap can only be overridden for the owner or family."
- **A hard ceiling.** Overridden calls still stop at twice the cap (6 a day with the default). Nothing lifts that ceiling, so a test loop can't run away.
- **Claude asks first.** `overrideCallCap` is described in the tool schema and the `schedule-appointment` skill as: only after the owner has said yes in this conversation to going past the cap for this contact, naming how many calls that contact has had today. That ask is a convention; the key, the eligibility rule and the ceiling are what Banjo enforces.
- **Recorded on the task.** A new boolean column `call_cap_override` is stored on the task, so the orchestrator's check right before dialing applies the same ceiling. The ack says the cap was overridden, and the call is logged at `warn` level with the contact id.
- Without `overrideCallCap`, the cap works exactly as today, for every key.

### 7. Startup checks

`src/config/index.ts` refuses to start when `MCP_AGENT_API_KEY` is set and:

- `MCP_AGENT_API_KEY` equals `MCP_API_KEY`;
- `PUBLIC_HOSTNAME` is missing (no link could be built); or
- `NOTIFICATION_CHANNEL` is `none` (no way to ask the owner).

A broken setup fails loudly at boot, so the gate can't be silently off.

## Edge cases

| Case | Behaviour |
|---|---|
| Owner taps the link twice, or two devices approve | The second compare-and-set matches nothing; the page says it's already approved. |
| Owner approves at the moment it expires | One of the two row updates wins; the page reports which. |
| Banjo restarts while a request waits | Nothing is lost: the state is in the database and the link is stateless. The expiry sweep resumes on the next tick. |
| Two Banjo processes on one database | Approval and expiry are row-level compare-and-sets; the existing `pending` claim stops a double dial. |
| Agent calls `cancel_task` on its own request | Cancelled as today; the link then reports it was cancelled. |
| Agent calls `place_call` again for the same number | A new, separate request, counted toward both the cap and the 3-waiting limit. |
| Agent reads `get_task_status` | Sees `pending` with `approval: 'waiting'`, then the call's normal statuses, or `cancelled` with `approval: 'not_approved'`. Never the link. |
| Task webhook | Unchanged: it fires when a call ends. An expired request never had a call, so it sends nothing, as with any task cancelled before dialing. |
| Someone guesses a task id | Without a valid `sig`, the page shows nothing. |
| The owner's own key (Claude Code) | No approval step, exactly as today. |

## Out of scope

- A Decline button: ignoring the message or `cancel_task` does the same thing.
- Approving inside Pushover itself (priority 2 receipts): it would drop the page, but has no way to show the full request and repeats alerts until acknowledged.
- Any override of the call cap from the agent key, or beyond the ceiling of twice the cap.
- Restricting other tools for the agent role, beyond what was added after review: the agent key can't set contact notes, and `cancel_task` and `stop_call` reach only calls it asked for.

## Setup on the node (after release)

1. Generate a key and add `MCP_AGENT_API_KEY` to `~/banjo/.env`.
2. Point both Hermes MCP servers (`banjo` and `banjo_readonly`) at the new key in `hermes-data/config.yaml`.
3. Restart both containers. Test: ask Hermes over iMessage for a call to the Live Test contact; confirm the Pushover arrives, the page shows the request, and the call dials only after Approve. Then let one request expire.
4. Update Hermes's SOUL.md so it tells the owner it's waiting for approval rather than asking for confirmation in chat.

## Docs to update

`.env.example`, `docs/AGENT_SETUP.md` (agent key, what the agent sees), `docs/RUNBOOKS.md` (rotating either key), `CLAUDE.md` (one line under the MCP surface, and the call-cap rule), `skills/schedule-appointment/` (when to use `overrideCallCap`), `docs/ARCHITECTURE.md`.

## Testing

- **Config:** each startup refusal; the same key for both rejected.
- **Auth:** role from each key; wrong key `null`; an SSE `POST` with the other key refused.
- **`place_call`:** the owner role is unchanged; the agent role creates a waiting task, doesn't trigger, sends one message whose link verifies, and never returns the link; the 3-waiting limit; a failed message cancels the task.
- **Cap override:** owner key + family contact, and owner key + the owner's own number, go past the cap; both stop at the ceiling, both when queued and right before dialing; a non-family contact is refused; the agent key with `overrideCallCap` is refused.
- **Orchestrator:** a waiting task is never claimed by the poller or by `triggerOrchestration`; an approved one is; the expiry sweep cancels only unapproved, expired, pending tasks.
- **Approve route:** bad `sig`, unknown task, expired, already approved, cancelled, success (triggers orchestration); `GET` changes nothing; output is escaped.
- **`get_task_status`:** each `approval` value, including a request cancelled while waiting.
- All DB-backed tests on `banjo_test`, following the existing clear-before-and-after rule.
