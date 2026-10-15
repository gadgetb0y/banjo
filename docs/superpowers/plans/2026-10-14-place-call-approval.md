# Owner approval for agent calls, and the owner's call-cap override: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A call requested with the agent key dials only after the owner taps Approve on a signed link; the owner's key can push a call to themselves or family past the per-number cap, up to twice it.

**Architecture:** The bearer key decides the caller's role (`owner` / `agent`). Agent requests become `pending` tasks with `approval_expires_at` set; the orchestrator skips them until `approved_at` is set by `POST /approve/:taskId` (HMAC-signed link sent with `sendOwnerMessage`), and the poller cancels them once expired. The cap override is a `call_cap_override` column that raises the cap check's limit to 2× for eligible contacts.

**Tech Stack:** TypeScript, Hono, Drizzle/Postgres, Zod, vitest, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-10-14-place-call-approval-design.md`

## Global Constraints

- `MCP_AGENT_API_KEY`: optional, at least 32 characters, must differ from `MCP_API_KEY`; when set, `PUBLIC_HOSTNAME` is required and `NOTIFICATION_CHANNEL` must not be `none`.
- Approval window: 30 minutes from the request. At most 3 agent requests waiting at once.
- Override ceiling: `2 * MAX_CALLS_PER_NUMBER_PER_DAY`. Only with the owner key; only for `relationshipTier === 'family'` or a number equal to `TRANSFER_TO_PHONE_NUMBER` / `NOTIFY_TO_PHONE_NUMBER`.
- The approval link is never logged, never returned by an MCP tool, never in the task webhook.
- Task status is written only through `transitionTask`.
- No `Claude-Session` trailers in commits. Keep `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run vitest CI-like: `env -u GEMINI_API_KEY` with `.env` moved aside, and check the exit code.
- DB tests use `banjo_test` and clear their tables before each test and after the last.

## Review Focus

1. **The request log leaks the link.** `src/server.ts`'s request logger logs `c.req.query()`, which would write `sig` to the logs on every page view. Expect `sig` to be redacted. Test in Task 9.
2. **A long task description pushes the link out of the message.** Pushover clips at 1024 characters; the link must come before any agent-written text. Test in Task 6.
3. **An agent's task description contains HTML.** The page must show it as text. Test in Task 9.
4. **A prefetch or link preview hits the GET.** It must change nothing. Test in Task 9.
5. **An SSE session opened with one key is posted to with the other.** Must be refused, so an agent can't ride an owner session. Test in Task 8.

---

### Task 1: Config — `MCP_AGENT_API_KEY`

**Files:**
- Modify: `src/config/index.ts` (next to `MCP_API_KEY` ~line 238, refines near line 404)
- Modify: `vitest.config.ts` (pin `MCP_AGENT_API_KEY: ''`)
- Modify: `.env.example`
- Test: `tests/config.test.ts`

**Interfaces:** Produces `config.MCP_AGENT_API_KEY: string | undefined`.

- [ ] **Step 1: Failing tests** — add `'MCP_AGENT_API_KEY'` to `ALL_CONFIG_KEYS`, then:

```ts
describe('config: MCP_AGENT_API_KEY', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { process.env = { ...originalEnv }; });
  const AGENT_KEY = 'agent-key-for-tests-only-0123456789';
  const PUSHOVER = { NOTIFICATION_CHANNEL: 'pushover', PUSHOVER_APP_TOKEN: 'a'.repeat(30), PUSHOVER_USER_KEY: 'u'.repeat(30), PUBLIC_HOSTNAME: 'banjo.example.com' };

  it('is optional', async () => {
    setEnv({});
    const { config } = await import('../src/config/index.js');
    expect(config.MCP_AGENT_API_KEY).toBeUndefined();
  });
  it('accepts a separate key with a hostname and a notification channel', async () => {
    setEnv({ ...PUSHOVER, MCP_AGENT_API_KEY: AGENT_KEY });
    const { config } = await import('../src/config/index.js');
    expect(config.MCP_AGENT_API_KEY).toBe(AGENT_KEY);
  });
  it.each([
    ['shorter than 32 characters', { ...PUSHOVER, MCP_AGENT_API_KEY: 'short' }, /at least 32/],
    ['the same as MCP_API_KEY', { ...PUSHOVER, MCP_AGENT_API_KEY: BASE_ENV.MCP_API_KEY }, /differ/],
    ['set without PUBLIC_HOSTNAME', { ...PUSHOVER, PUBLIC_HOSTNAME: undefined, MCP_AGENT_API_KEY: AGENT_KEY }, /PUBLIC_HOSTNAME/],
    ['set with NOTIFICATION_CHANNEL=none', { PUBLIC_HOSTNAME: 'banjo.example.com', MCP_AGENT_API_KEY: AGENT_KEY }, /NOTIFICATION_CHANNEL/],
  ])('refuses a key %s', async (_label, env, message) => {
    setEnv(env as Record<string, string | undefined>);
    await expect(import('../src/config/index.js')).rejects.toThrow(message);
  });
});
```

(`setEnv` assigns `undefined` as the string `"undefined"` via `Object.assign`; delete keys whose value is `undefined` after assigning: `for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];` — add that line to `setEnv`.)

- [ ] **Step 2: Run** `npx vitest run tests/config.test.ts` — expect the new tests to FAIL.

- [ ] **Step 3: Implement** in `src/config/index.ts`, after `MCP_API_KEY`:

```ts
    // A second key for always-on agents (Hermes, OpenClaw). A call placed
    // with it waits for the owner to approve it from a signed link
    // (src/approvals/). Unset: there's no agent role.
    MCP_AGENT_API_KEY: optionalSetting(z.string().min(32, 'MCP_AGENT_API_KEY must be at least 32 characters')),
```

and refines after the `TASK_WEBHOOK_SECRET` one:

```ts
  .refine((v) => !v.MCP_AGENT_API_KEY || v.MCP_AGENT_API_KEY !== v.MCP_API_KEY, {
    message: 'MCP_AGENT_API_KEY must differ from MCP_API_KEY: the agent key is what makes a call wait for approval',
    path: ['MCP_AGENT_API_KEY'],
  })
  .refine((v) => !v.MCP_AGENT_API_KEY || !!v.PUBLIC_HOSTNAME, {
    message: 'PUBLIC_HOSTNAME is required when MCP_AGENT_API_KEY is set: approval links point at it',
    path: ['PUBLIC_HOSTNAME'],
  })
  .refine((v) => !v.MCP_AGENT_API_KEY || v.NOTIFICATION_CHANNEL !== 'none', {
    message: "NOTIFICATION_CHANNEL can't be none when MCP_AGENT_API_KEY is set: approval requests go to the owner through it",
    path: ['NOTIFICATION_CHANNEL'],
  })
```

`vitest.config.ts`: add `MCP_AGENT_API_KEY: '',` under `MCP_API_KEY` with the existing "pinned" comment pattern. `.env.example`: add after `MCP_API_KEY`:

```
# Optional: a second key for always-on agents (Hermes, OpenClaw). Calls placed
# with it wait for you to tap Approve on a link Banjo sends you; needs
# PUBLIC_HOSTNAME and a NOTIFICATION_CHANNEL. Generate: openssl rand -hex 32
MCP_AGENT_API_KEY=
```

- [ ] **Step 4: Run** the config tests — PASS.
- [ ] **Step 5: Commit** `feat(config): MCP_AGENT_API_KEY for agents whose calls need approval`.

---

### Task 2: Task columns, migration, and approval writes

**Files:**
- Modify: `src/tasks/schema.ts` (tasks table)
- Create: `drizzle/0007_*.sql` (generated)
- Modify: `src/tasks/service.ts`
- Test: `tests/tasks/approval.db.test.ts` (new)

**Interfaces — Produces:**
- columns `approvalExpiresAt: Date | null`, `approvedAt: Date | null`, `callCapOverride: boolean` (default false)
- `createTask({..., approvalExpiresAt?: Date, callCapOverride?: boolean})`
- `TransitionGuard = { from; ifUpdatedAt?; unapproved?: true }`
- `isAwaitingApproval(task: Pick<Task,'approvalExpiresAt'|'approvedAt'>): boolean`
- `approvalState(task: Pick<Task,'approvalExpiresAt'|'approvedAt'|'status'>): 'waiting'|'approved'|'not_approved'|undefined`
- `approveTask(id: string, now?: Date): Promise<'approved'|'already_approved'|'expired'|'not_waiting'|'not_found'>`
- `expireApprovalRequests(now?: Date): Promise<string[]>` (ids cancelled)
- `countTasksAwaitingApproval(now?: Date): Promise<number>`
- `listStartableTasks` excludes tasks awaiting approval.

- [ ] **Step 1: Schema** — in `tasks` after `scheduledFor`:

```ts
  // Set only on a call an agent asked for (MCP_AGENT_API_KEY): it isn't
  // placed until the owner approves it from the signed link (src/approvals/),
  // and the orchestrator's poller cancels it once this passes unapproved.
  approvalExpiresAt: timestamp('approval_expires_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  // The owner let this call past MAX_CALLS_PER_NUMBER_PER_DAY, up to twice it
  // (tasks/callCap.ts): their own number or family only, never from the agent key.
  callCapOverride: boolean('call_cap_override').notNull().default(false),
```

- [ ] **Step 2: Generate and migrate** — `npm run db:generate`, check the SQL only adds three columns, then `DATABASE_URL=postgresql://banjo:banjo@localhost:5432/banjo_test npm run db:migrate`.

- [ ] **Step 3: Failing DB tests** `tests/tasks/approval.db.test.ts` (header and `clearTables` copied from `tests/tasks/service.db.test.ts`):

```ts
const MIN = 60_000;
async function contactRow() {
  const [c] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230009' }).returning();
  return c;
}
async function agentTask(contactId: string, expiresAt: Date) {
  return service.createTask({ contactId, channel: 'phone', goalDescription: 'Book', constraints: {}, approvalExpiresAt: expiresAt });
}

describe('approval writes', () => {
  it('approves a waiting task once, and reports a second approve', async () => {
    const c = await contactRow();
    const t = await agentTask(c.id, new Date(Date.now() + 30 * MIN));
    expect(service.isAwaitingApproval(t)).toBe(true);
    expect(await service.approveTask(t.id)).toBe('approved');
    expect(await service.approveTask(t.id)).toBe('already_approved');
    const after = await service.getTask(t.id);
    expect(after?.approvedAt).toBeInstanceOf(Date);
    expect(service.approvalState(after!)).toBe('approved');
  });
  it('refuses an expired, a cancelled, an unknown, and an owner task', async () => {
    const c = await contactRow();
    const expired = await agentTask(c.id, new Date(Date.now() - MIN));
    const cancelled = await agentTask(c.id, new Date(Date.now() + 30 * MIN));
    await service.cancelPendingTask(cancelled.id);
    const owner = await service.createTask({ contactId: c.id, channel: 'phone', goalDescription: 'Book', constraints: {} });
    expect(await service.approveTask(expired.id)).toBe('expired');
    expect(await service.approveTask(cancelled.id)).toBe('not_waiting');
    expect(await service.approveTask(owner.id)).toBe('not_waiting');
    expect(await service.approveTask('00000000-0000-0000-0000-000000000000')).toBe('not_found');
  });
  it('expires only unapproved, past-due, pending requests', async () => {
    const c = await contactRow();
    const past = await agentTask(c.id, new Date(Date.now() - MIN));
    const future = await agentTask(c.id, new Date(Date.now() + 30 * MIN));
    const approved = await agentTask(c.id, new Date(Date.now() + MIN));
    await service.approveTask(approved.id);
    const owner = await service.createTask({ contactId: c.id, channel: 'phone', goalDescription: 'Book', constraints: {} });
    expect(await service.expireApprovalRequests(new Date(Date.now() + 2 * MIN))).toEqual([past.id]);
    expect((await service.getTask(past.id))?.status).toBe('cancelled');
    expect(service.approvalState((await service.getTask(past.id))!)).toBe('not_approved');
    for (const t of [future, approved, owner]) expect((await service.getTask(t.id))?.status).toBe('pending');
  });
  it('an approve that lands after expiry swept the task is refused', async () => {
    const c = await contactRow();
    const t = await agentTask(c.id, new Date(Date.now() - MIN));
    await service.expireApprovalRequests();
    expect(await service.approveTask(t.id)).toBe('not_waiting');
  });
  it('counts waiting requests and keeps them out of the startable list', async () => {
    const c = await contactRow();
    const waiting = await agentTask(c.id, new Date(Date.now() + 30 * MIN));
    await agentTask(c.id, new Date(Date.now() - MIN)); // expired: not counted
    const approved = await agentTask(c.id, new Date(Date.now() + 30 * MIN));
    await service.approveTask(approved.id);
    expect(await service.countTasksAwaitingApproval()).toBe(1);
    const startable = (await service.listStartableTasks()).map((t) => t.id);
    expect(startable).toContain(approved.id);
    expect(startable).not.toContain(waiting.id);
  });
  it('stores callCapOverride, false by default', async () => {
    const c = await contactRow();
    const plain = await service.createTask({ contactId: c.id, channel: 'phone', goalDescription: 'x', constraints: {} });
    const over = await service.createTask({ contactId: c.id, channel: 'phone', goalDescription: 'x', constraints: {}, callCapOverride: true });
    expect(plain.callCapOverride).toBe(false);
    expect(over.callCapOverride).toBe(true);
  });
});
```

- [ ] **Step 4: Run** — FAIL (functions missing).

- [ ] **Step 5: Implement** in `src/tasks/service.ts`:

`createTask` input gains `approvalExpiresAt?: Date; callCapOverride?: boolean;` spread like `scheduledFor`.

```ts
export type TransitionGuard = { from: Task['status'][]; ifUpdatedAt?: Date; unapproved?: true };
```
and in `transitionTask`'s `where`: `options?.unapproved ? isNull(tasks.approvedAt) : undefined,`.

```ts
/** A call an agent asked for that the owner hasn't approved yet: never dialed in this state. */
export function isAwaitingApproval(task: Pick<Task, 'approvalExpiresAt' | 'approvedAt'>): boolean {
  return task.approvalExpiresAt !== null && task.approvedAt === null;
}

/** For get_task_status / list_recent_tasks: undefined on a task that never needed approval. */
export function approvalState(
  task: Pick<Task, 'approvalExpiresAt' | 'approvedAt' | 'status'>,
): 'waiting' | 'approved' | 'not_approved' | undefined {
  if (!task.approvalExpiresAt) return undefined;
  if (task.approvedAt) return 'approved';
  return task.status === 'pending' ? 'waiting' : 'not_approved';
}

/**
 * The owner's Approve (src/approvals/routes.ts). Not a status change, so not
 * transitionTask: a compare-and-set on approved_at, which the expiry sweep's
 * own compare-and-set (unapproved, from pending) can't both win against.
 */
export async function approveTask(
  id: string,
  now: Date = new Date(),
): Promise<'approved' | 'already_approved' | 'expired' | 'not_waiting' | 'not_found'> {
  const [row] = await db
    .update(tasks)
    .set({ approvedAt: now, updatedAt: sql`greatest(${now.toISOString()}::timestamptz, ${tasks.updatedAt} + interval '1 millisecond')` })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.status, 'pending'),
        isNull(tasks.approvedAt),
        gt(tasks.approvalExpiresAt, now),
      ),
    )
    .returning({ id: tasks.id });
  if (row) return 'approved';
  const task = await getTask(id);
  if (!task) return 'not_found';
  if (task.approvedAt) return 'already_approved';
  if (task.status === 'pending' && task.approvalExpiresAt && task.approvalExpiresAt <= now) return 'expired';
  return 'not_waiting';
}

/** Cancels agent requests nobody approved in time. Returns the ids it cancelled. */
export async function expireApprovalRequests(now: Date = new Date()): Promise<string[]> {
  const due = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.status, 'pending'), isNull(tasks.approvedAt), lte(tasks.approvalExpiresAt, now)));
  const cancelled: string[] = [];
  for (const { id } of due) {
    const row = await transitionTask(id, 'cancelled', undefined, { from: ['pending'], unapproved: true });
    if (row) cancelled.push(id);
  }
  return cancelled;
}

/** Agent requests still waiting on the owner — place_call caps these at 3. */
export async function countTasksAwaitingApproval(now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(tasks)
    .where(and(eq(tasks.status, 'pending'), isNull(tasks.approvedAt), gt(tasks.approvalExpiresAt, now)));
  return row?.count ?? 0;
}
```

`listStartableTasks`: add to its `and(...)`: `or(isNull(tasks.approvalExpiresAt), isNotNull(tasks.approvedAt))`. Import `gt`, `isNotNull` from drizzle-orm.

- [ ] **Step 6: Run** the new DB test plus `tests/tasks/service.db.test.ts` and `tests/tasks/service.test.ts` — PASS.
- [ ] **Step 7: Commit** `feat(tasks): approval and cap-override columns, approve and expiry writes`.

---

### Task 3: Call cap limit and override eligibility

**Files:**
- Modify: `src/tasks/callCap.ts`
- Modify: `src/tasks/orchestrator.ts` (both `checkCallCap` calls)
- Test: `tests/tasks/callCap.test.ts`, `tests/tasks/orchestrator.test.ts`

**Interfaces — Produces:**
- `checkCallCap(contactId, now?, options?: { includeQueued?: boolean; limit?: number })`; `CallCapResult.limit: number`
- `callCapLimit(task: Pick<Task,'callCapOverride'>): number`
- `OVERRIDE_CAP_MULTIPLIER = 2`
- `canOverrideCallCap(contact: Pick<Contact,'relationshipTier'|'phoneNumber'>): boolean`

- [ ] **Step 1: Failing tests** in `tests/tasks/callCap.test.ts` (follow its existing mocks of `callsPlacedToContactSince`/`dueQueuedCallsForContact`):

```ts
describe('call cap override (owner, testing)', () => {
  it('a limit option raises the cap, and the refusal names that limit', async () => {
    callsPlacedToContactSince.mockResolvedValue([new Date(), new Date(), new Date()]);
    expect((await checkCallCap('c', new Date())).allowed).toBe(false);
    const raised = await checkCallCap('c', new Date(), { limit: 6 });
    expect(raised).toMatchObject({ allowed: true, limit: 6 });
    callsPlacedToContactSince.mockResolvedValue(Array.from({ length: 6 }, () => new Date()));
    const full = await checkCallCap('c', new Date(), { limit: 6 });
    expect(full.allowed).toBe(false);
    expect(describeCallCapRefusal(full)).toMatch(/max 6 per 24 hours/);
  });
  it('callCapLimit is twice the cap only with the override', () => {
    expect(callCapLimit({ callCapOverride: false })).toBe(config.MAX_CALLS_PER_NUMBER_PER_DAY);
    expect(callCapLimit({ callCapOverride: true })).toBe(2 * config.MAX_CALLS_PER_NUMBER_PER_DAY);
  });
  it('only the owner and family can be overridden', () => {
    expect(canOverrideCallCap({ relationshipTier: 'family', phoneNumber: '+15550000001' })).toBe(true);
    expect(canOverrideCallCap({ relationshipTier: 'friend', phoneNumber: '+15550000001' })).toBe(false);
    expect(canOverrideCallCap({ relationshipTier: null, phoneNumber: '+15550000001' })).toBe(false);
    expect(canOverrideCallCap({ relationshipTier: null, phoneNumber: config.NOTIFY_TO_PHONE_NUMBER! })).toBe(true);
  });
});
```

In `tests/tasks/orchestrator.test.ts`, `describe('per-number call cap at dial time')`, add:

```ts
  it('checks an overridden task against twice the cap, both before and at dialing', async () => {
    getTask.mockResolvedValue({ ...pendingTask(), callCapOverride: true });
    // ...same arrangement as the existing "fails the task" test, but allowed:
    checkCallCap.mockResolvedValue({ allowed: true, placed: 4, queued: 0 });
    await runToCompletion();
    for (const call of checkCallCap.mock.calls) expect(call[2]).toEqual({ limit: 6 });
  });
```

(Use the helper names the file already has for a pending task and for awaiting a run; if it inlines them, inline the same objects.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** in `callCap.ts`: replace the "There is no override" sentence of the module comment with: "The owner can let a call to themselves or family go past it, up to OVERRIDE_CAP_MULTIPLIER times it, for testing (place_call's overrideCallCap, owner key only); nothing goes past that." Then:

```ts
export const OVERRIDE_CAP_MULTIPLIER = 2;

export function callCapLimit(task: Pick<Task, 'callCapOverride'>): number {
  return config.MAX_CALLS_PER_NUMBER_PER_DAY * (task.callCapOverride ? OVERRIDE_CAP_MULTIPLIER : 1);
}

/**
 * Who the owner may override the cap for: themselves (the number Banjo
 * transfers or texts them on) or family. Neither can be set through MCP — the
 * tier comes only from Google/CardDAV groups (#163, #170) — so a call can't
 * make a business eligible.
 */
export function canOverrideCallCap(contact: Pick<Contact, 'relationshipTier' | 'phoneNumber'>): boolean {
  if (contact.relationshipTier === 'family') return true;
  const own = [config.TRANSFER_TO_PHONE_NUMBER, config.NOTIFY_TO_PHONE_NUMBER].filter(Boolean);
  return own.includes(contact.phoneNumber);
}
```

`CallCapResult` gains `limit: number`. `checkCallCap` options gain `limit?: number`; `const cap = options.limit ?? config.MAX_CALLS_PER_NUMBER_PER_DAY;` and every return includes `limit: cap`. `describeCallCapRefusal` uses `result.limit`. Update the mock return types in `tests/mcp/placeCall.test.ts` / `tests/tasks/orchestrator.test.ts` to include `limit: 3` where TypeScript requires.

In `orchestrator.ts`, both `checkCallCap(task.contactId, new Date())` become `checkCallCap(task.contactId, new Date(), { limit: callCapLimit(task) })`.

- [ ] **Step 4: Run** callCap + orchestrator tests — PASS.
- [ ] **Step 5: Commit** `feat(callCap): a raised limit for owner-overridden calls to themselves or family`.

---

### Task 4: `sendOwnerMessage` reports delivery

**Files:**
- Modify: `src/notifications/pushover.ts` (`sendPushover` → `Promise<boolean>`), `src/notifications/twilioSms.ts` (`sendOwnerSms`, `sendSms` → `Promise<boolean>`), `src/notifications/owner.ts`
- Test: `tests/notifications/pushover.test.ts`, `tests/notifications/twilioSms.test.ts`, `tests/notifications/channel.test.ts` (wherever `sendOwnerMessage` is tested; else add to pushover test)

**Interfaces — Produces:** `sendOwnerMessage(body, opts?): Promise<boolean>` — true when Pushover returned 2xx or Twilio accepted the SMS; false on failure or `NOTIFICATION_CHANNEL=none`.

- [ ] **Step 1: Failing tests** — in the Pushover test file, alongside its existing fetch mocks: `expect(await sendPushover({ message: 'x' })).toBe(true)` on 200 and `.toBe(false)` on a 400. In the SMS test: `true` when `messages.create` resolves, `false` when it rejects.
- [ ] **Step 2: Run** — FAIL (returns undefined).
- [ ] **Step 3: Implement** — `sendPushover`: `return result.ok;` after the log. `sendSms`: `return false` in the catch, `return true` after scheduling the delivery check (Twilio accepting is the most we know synchronously). `sendOwnerSms`: `if (...) return false; return sendSms(body, {});`. `sendOwnerMessage`: return type `Promise<boolean>`, `case 'none': return false;`. Update doc comments: "Resolves whether it was handed off; never throws."
- [ ] **Step 4: Run** notifications tests + `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(notifications): sendOwnerMessage resolves whether it was delivered`.

---

### Task 5: Signed approval links

**Files:**
- Create: `src/approvals/link.ts`
- Test: `tests/approvals/link.test.ts`

**Interfaces — Produces:**
- `approvalSignature(taskId: string, expiresAt: Date): string` (hex)
- `isValidApprovalSignature(taskId: string, expiresAt: Date, sig: string): boolean`
- `approvalUrl(taskId: string, expiresAt: Date): string`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { approvalSignature, approvalUrl, isValidApprovalSignature } from '../../src/approvals/link.js';

const ID = '11111111-1111-1111-1111-111111111111';
const EXPIRES = new Date('2026-10-15T01:30:00.000Z');

describe('approval links', () => {
  it('verifies its own signature and nothing else', () => {
    const sig = approvalSignature(ID, EXPIRES);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidApprovalSignature(ID, EXPIRES, sig)).toBe(true);
    expect(isValidApprovalSignature('22222222-2222-2222-2222-222222222222', EXPIRES, sig)).toBe(false);
    expect(isValidApprovalSignature(ID, new Date(EXPIRES.getTime() + 1), sig)).toBe(false);
    expect(isValidApprovalSignature(ID, EXPIRES, sig.slice(0, -1))).toBe(false);
    expect(isValidApprovalSignature(ID, EXPIRES, '')).toBe(false);
    expect(isValidApprovalSignature(ID, EXPIRES, 'zz'.repeat(32))).toBe(false);
  });
  it('is keyed from MCP_API_KEY, so rotating it voids old links', () => {
    const sig = approvalSignature(ID, EXPIRES);
    const original = config.MCP_API_KEY;
    config.MCP_API_KEY = 'a-different-owner-key-0123456789abcdef';
    try {
      expect(isValidApprovalSignature(ID, EXPIRES, sig)).toBe(false);
    } finally {
      config.MCP_API_KEY = original;
    }
  });
  it('builds the link on PUBLIC_HOSTNAME', () => {
    const original = config.PUBLIC_HOSTNAME;
    config.PUBLIC_HOSTNAME = 'banjo.example.com';
    try {
      expect(approvalUrl(ID, EXPIRES)).toBe(`https://banjo.example.com/approve/${ID}?sig=${approvalSignature(ID, EXPIRES)}`);
    } finally {
      config.PUBLIC_HOSTNAME = original;
    }
  });
});
```

- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** `src/approvals/link.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';

/**
 * Approval links (spec: docs/superpowers/specs/2026-10-14-place-call-approval-design.md).
 * The signature covers the task id and its expiry, keyed from MCP_API_KEY —
 * the owner's key, which the agent never holds — so an agent can't make a
 * link that approves its own call. Nothing is stored: the task row has both
 * inputs. The link must stay out of logs, MCP results and the task webhook.
 */
function signingKey(): Buffer {
  return createHmac('sha256', config.MCP_API_KEY).update('banjo-approval-v1').digest();
}

export function approvalSignature(taskId: string, expiresAt: Date): string {
  return createHmac('sha256', signingKey()).update(`${taskId}.${expiresAt.getTime()}`).digest('hex');
}

export function isValidApprovalSignature(taskId: string, expiresAt: Date, sig: string): boolean {
  const wanted = Buffer.from(approvalSignature(taskId, expiresAt), 'hex');
  const given = /^[0-9a-f]{64}$/.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function approvalUrl(taskId: string, expiresAt: Date): string {
  return `https://${config.PUBLIC_HOSTNAME}/approve/${taskId}?sig=${approvalSignature(taskId, expiresAt)}`;
}
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(approvals): signed approval links`.

---

### Task 6: `place_call` by role — agent approval and owner override

**Files:**
- Modify: `src/mcp/tools/placeCall.ts`
- Create: `src/approvals/request.ts` (the approval message)
- Test: `tests/mcp/placeCall.test.ts`, `tests/approvals/request.test.ts`

**Interfaces:**
- Consumes: Task 2 `createTask`, `countTasksAwaitingApproval`, `cancelPendingTask`; Task 3 `canOverrideCallCap`, `OVERRIDE_CAP_MULTIPLIER`; Task 4 `sendOwnerMessage`; Task 5 `approvalUrl`; `getContact` from `src/contacts/service.ts`.
- Produces:
  - `export type McpRole = 'owner' | 'agent'` (in `src/mcp/role.ts`)
  - `placeCallHandler(input, ctx: { role: McpRole } = { role: 'owner' })`
  - `APPROVAL_WINDOW_MS = 30 * 60_000`, `MAX_WAITING_APPROVALS = 3` (in `src/approvals/request.ts`)
  - `buildApprovalMessage(args: { contact: Pick<Contact,'displayName'|'phoneNumber'>; task: Pick<Task,'id'|'goalDescription'|'mode'|'questions'|'scheduledFor'|'approvalExpiresAt'> }): string`

- [ ] **Step 1: Failing tests** — `tests/approvals/request.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { buildApprovalMessage } from '../../src/approvals/request.js';
import { clipText, PUSHOVER_MAX_MESSAGE_CHARS } from '../../src/notifications/limits.js';

config.PUBLIC_HOSTNAME = 'banjo.example.com';
const base = {
  contact: { displayName: "Luigi's", phoneNumber: '+15550001111' },
  task: { id: '11111111-1111-1111-1111-111111111111', goalDescription: 'Book Friday at 7', mode: 'booking' as const, questions: null, scheduledFor: null, approvalExpiresAt: new Date('2026-10-15T01:30:00.000Z') },
};

describe('approval message', () => {
  it('names who, when and what, with the link', () => {
    const msg = buildApprovalMessage(base);
    expect(msg).toContain("Luigi's (+15550001111)");
    expect(msg).toContain('now');
    expect(msg).toContain('https://banjo.example.com/approve/11111111-1111-1111-1111-111111111111?sig=');
    expect(msg).toContain('Book Friday at 7');
  });
  it('keeps the link when a long description is clipped (Review Focus 2)', () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, goalDescription: 'x'.repeat(5000) } });
    expect(clipText(msg, PUSHOVER_MAX_MESSAGE_CHARS)).toContain('/approve/');
  });
  it('lists an ask call\'s questions', () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, mode: 'ask', questions: ['Open Sunday?'] } });
    expect(msg).toContain('Open Sunday?');
  });
});
```

`tests/mcp/placeCall.test.ts` — extend the hoisted service mock with `countTasksAwaitingApproval: vi.fn(async () => 0)`, `cancelPendingTask: vi.fn(async () => ({}))`; mock `../../src/contacts/service.js` with `getContact: vi.fn(async () => ({ id: CONTACT_ID, displayName: 'Salon', phoneNumber: '+15550001111', relationshipTier: null }))`; mock `../../src/notifications/owner.js` with `sendOwnerMessage: vi.fn(async () => true)`. Make `createTask` return the input it was given merged with `{ id: 'task-1', approvalExpiresAt: input.approvalExpiresAt ?? null }`. Then:

```ts
describe('place_call: agent key (approval)', () => {
  const agent = { role: 'agent' as const };
  const input = { contactId: CONTACT_ID, taskDescription: 'Book a trim' };
  beforeEach(() => { config.PUBLIC_HOSTNAME = 'banjo.example.com'; });

  it('creates a waiting task, sends one approval message, and does not dial', async () => {
    const before = Date.now();
    const result = await placeCallHandler(input, agent);
    const created = createTask.mock.calls.at(-1)![0];
    expect(created.approvalExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(created.approvalExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(triggerOrchestration).not.toHaveBeenCalled();
    expect(sendOwnerMessage).toHaveBeenCalledTimes(1);
    expect(sendOwnerMessage.mock.calls[0][0]).toContain('/approve/task-1?sig=');
    expect(result.ackMessage).toMatch(/approve/i);
    expect(JSON.stringify(result)).not.toContain('sig=');
  });
  it('refuses once 3 requests are already waiting', async () => {
    countTasksAwaitingApproval.mockResolvedValueOnce(3);
    await expect(placeCallHandler(input, agent)).rejects.toThrow(/already waiting/);
    expect(createTask).not.toHaveBeenCalled();
  });
  it('cancels the task when the owner could not be reached', async () => {
    sendOwnerMessage.mockResolvedValueOnce(false);
    await expect(placeCallHandler(input, agent)).rejects.toThrow(/Couldn't reach the owner/);
    expect(cancelPendingTask).toHaveBeenCalledWith('task-1');
  });
  it('refuses overrideCallCap', async () => {
    await expect(placeCallHandler({ ...input, overrideCallCap: true }, agent)).rejects.toThrow(/owner's own key/);
    expect(createTask).not.toHaveBeenCalled();
  });
  it('still applies the call cap', async () => {
    checkCallCap.mockResolvedValueOnce({ allowed: false, placed: 3, queued: 0, limit: 3 });
    await expect(placeCallHandler(input, agent)).rejects.toThrow(/Call limit reached/);
  });
});

describe('place_call: owner key', () => {
  const input = { contactId: CONTACT_ID, taskDescription: 'Test call' };
  it('dials with no approval, as before', async () => {
    await placeCallHandler(input);
    expect(createTask.mock.calls.at(-1)![0].approvalExpiresAt).toBeUndefined();
    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
    expect(sendOwnerMessage).not.toHaveBeenCalled();
  });
  it('overrides the cap for family, up to twice it', async () => {
    getContact.mockResolvedValueOnce({ id: CONTACT_ID, displayName: 'Mom', phoneNumber: '+15550002222', relationshipTier: 'family' });
    const result = await placeCallHandler({ ...input, overrideCallCap: true });
    expect(checkCallCap).toHaveBeenCalledWith(CONTACT_ID, expect.any(Date), { includeQueued: true, limit: 6 });
    expect(createTask.mock.calls.at(-1)![0].callCapOverride).toBe(true);
    expect(result.ackMessage).toMatch(/call cap overridden/i);
  });
  it('refuses the override for anyone but the owner or family', async () => {
    await expect(placeCallHandler({ ...input, overrideCallCap: true })).rejects.toThrow(/only be overridden for the owner or family/);
  });
  it('the ceiling still refuses', async () => {
    getContact.mockResolvedValueOnce({ id: CONTACT_ID, displayName: 'Mom', phoneNumber: '+15550002222', relationshipTier: 'family' });
    checkCallCap.mockResolvedValueOnce({ allowed: false, placed: 6, queued: 0, limit: 6 });
    await expect(placeCallHandler({ ...input, overrideCallCap: true })).rejects.toThrow(/max 6/);
  });
});
```

(Ensure the file's `beforeEach` runs `vi.clearAllMocks()`; add one if it doesn't.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** `src/mcp/role.ts`:

```ts
/** Who is calling Banjo's MCP tools, from the bearer key (mcp/server.ts's requireAuth). Never from anything the caller says. */
export type McpRole = 'owner' | 'agent';
```

`src/approvals/request.ts`:

```ts
import type { Contact } from '../contacts/schema.js';
import { config } from '../config/index.js';
import type { Task } from '../tasks/schema.js';
import { approvalUrl } from './link.js';

export const APPROVAL_WINDOW_MS = 30 * 60_000;
export const MAX_WAITING_APPROVALS = 3;

export function formatLocal(date: Date): string {
  return date.toLocaleString('en-US', { timeZone: config.CALENDAR_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The owner's approval request. The link and the time come before anything
 * the agent wrote: Pushover clips a long message, and the link must survive.
 */
export function buildApprovalMessage({
  contact,
  task,
}: {
  contact: Pick<Contact, 'displayName' | 'phoneNumber'>;
  task: Pick<Task, 'id' | 'goalDescription' | 'mode' | 'questions' | 'scheduledFor' | 'approvalExpiresAt'>;
}): string {
  const expiresAt = task.approvalExpiresAt!;
  const when = task.scheduledFor && task.scheduledFor.getTime() > Date.now() ? `at ${formatLocal(task.scheduledFor)}` : 'now';
  const lines = [
    `An agent asked Banjo to call ${contact.displayName} (${contact.phoneNumber}) ${when}.`,
    `Approve by ${formatLocal(expiresAt)}, or it won't be placed: ${approvalUrl(task.id, expiresAt)}`,
    '',
    `Task (${task.mode}): ${task.goalDescription}`,
    ...(task.questions?.length ? ['Questions:', ...task.questions.map((q, i) => `${i + 1}. ${q}`)] : []),
  ];
  return lines.join('\n');
}
```

`placeCall.ts`:
- Schema: add
```ts
  overrideCallCap: z
    .boolean()
    .optional()
    .describe(
      `Owner only, for testing: let this call go past the limit of ${config.MAX_CALLS_PER_NUMBER_PER_DAY} calls per number ` +
        `per 24 hours, up to twice it. Only for a family contact or the owner's own number. Set it only after the owner has ` +
        'said yes in this conversation to going past the limit for this contact, told how many calls it has had today.',
    ),
```
- Signature `placeCallHandler(input, ctx: { role: McpRole } = { role: 'owner' })`.
- After the existing mode/`scheduledFor` validation, before the cap check:
```ts
  const agent = ctx.role === 'agent';
  if (agent && input.overrideCallCap) {
    throw new Error("overrideCallCap needs the owner's own key: an agent can't lift the call limit.");
  }
  if (agent && (await countTasksAwaitingApproval()) >= MAX_WAITING_APPROVALS) {
    throw new Error(`${MAX_WAITING_APPROVALS} calls are already waiting for the owner's approval. Wait for those first.`);
  }
  const contact = agent || input.overrideCallCap ? await getContact(input.contactId) : undefined;
  if ((agent || input.overrideCallCap) && !contact) throw new Error(`Contact not found: ${input.contactId}`);
  if (input.overrideCallCap && !canOverrideCallCap(contact!)) {
    throw new Error('The call cap can only be overridden for the owner or family.');
  }
  const limit = config.MAX_CALLS_PER_NUMBER_PER_DAY * (input.overrideCallCap ? OVERRIDE_CAP_MULTIPLIER : 1);
```
- Cap check passes `{ includeQueued: true, limit }`.
- `createTask` gets `...(agent ? { approvalExpiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS) } : {})` and `...(input.overrideCallCap ? { callCapOverride: true } : {})`.
- After `createTask`, if `input.overrideCallCap`: `logger.warn({ taskId: task.id, contactId: input.contactId }, 'owner overrode the call cap for this call')`.
- Agent branch, right after `createTask`:
```ts
  if (agent) {
    const delivered = await sendOwnerMessage(buildApprovalMessage({ contact: contact!, task }));
    if (!delivered) {
      await cancelPendingTask(task.id);
      throw new Error("Couldn't reach the owner for approval, so no call will be placed.");
    }
    return {
      taskId: task.id,
      ackMessage:
        `Asked the owner to approve a call about "${input.taskDescription}". It will be placed once they approve, or ` +
        `cancelled if they haven't by ${formatLocal(task.approvalExpiresAt!)} (${config.CALENDAR_TIMEZONE}). Check get_task_status.`,
    };
  }
```
- Owner override: prefix both ack messages with `Call cap overridden (up to ${limit} calls in 24 hours). ` when `input.overrideCallCap`.

Note `sendOwnerMessage` is called with the default title; also pass a title: extend `sendOwnerMessage(body, { urgent, title })` only if trivial — otherwise leave the default "Banjo".

- [ ] **Step 4: Run** `npx vitest run tests/mcp/placeCall.test.ts tests/approvals` — PASS.
- [ ] **Step 5: Commit** `feat(place_call): agent calls wait for owner approval; owner can override the cap for family`.

---

### Task 7: Orchestrator gate and expiry sweep

**Files:**
- Modify: `src/tasks/orchestrator.ts`
- Test: `tests/tasks/orchestrator.test.ts`

**Interfaces:** Consumes `isAwaitingApproval`, `expireApprovalRequests` (Task 2).

- [ ] **Step 1: Failing test** — add `isAwaitingApproval: (t: { approvalExpiresAt?: Date | null; approvedAt?: Date | null }) => !!t.approvalExpiresAt && !t.approvedAt` and `expireApprovalRequests: vi.fn(async () => [])` to the service mock, then:

```ts
describe('a call waiting for the owner to approve it', () => {
  it('is not claimed or dialed until approved', async () => {
    getTask.mockResolvedValue({ id: 't1', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {}, mode: 'booking', approvalExpiresAt: new Date(Date.now() + 60_000), approvedAt: null });
    triggerOrchestration('t1');
    await vi.waitFor(() => expect(getTask).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(transitionTask).not.toHaveBeenCalled();
    expect(createCallAttempt).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** — FAIL (it claims the task).
- [ ] **Step 3: Implement** — in `runTask`, after the `isTaskDue` check:

```ts
  if (isAwaitingApproval(task)) {
    // An agent's request (MCP_AGENT_API_KEY): placed only once the owner
    // approves it (src/approvals/), which triggers this run again.
    return;
  }
```

In `startOrchestrationPoller`'s interval, add:

```ts
    expireApprovalRequests()
      .then((ids) => { if (ids.length) logger.info({ taskIds: ids }, 'cancelled call requests the owner did not approve in time'); })
      .catch((err) => logger.error({ err }, 'Approval expiry sweep failed'));
```

Update the poller's doc comment with one sentence about the sweep.

- [ ] **Step 4: Run** orchestrator tests — PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): hold agent calls until approved, cancel them when the window passes`.

---

### Task 8: MCP roles, and approval state in task reads

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools/getTaskStatus.ts`, `src/mcp/tools/listRecentTasks.ts`
- Test: `tests/mcp/server.test.ts`, `tests/mcp/tools/*` (get_task_status / list_recent_tasks tests if present; else add to `tests/mcp/server.test.ts`)

**Interfaces:**
- Produces: `requireAuth(c): McpRole | null` (internal); `createMcpServer({ role }: { role: McpRole } = { role: 'owner' })`; `GetTaskStatusResult` found-branch gains `approval?: 'waiting' | 'approved' | 'not_approved'`; `TaskSummary` gains the same.

- [ ] **Step 1: Failing tests** in `tests/mcp/server.test.ts`:

```ts
describe('mcp server: agent key', () => {
  const AGENT = 'agent-key-for-tests-only-0123456789';
  beforeEach(() => { config.MCP_AGENT_API_KEY = AGENT; });
  afterEach(() => { config.MCP_AGENT_API_KEY = undefined; });

  it('accepts the agent key', async () => {
    const res = await buildApp().request('/mcp/messages', { method: 'POST', headers: { Authorization: `Bearer ${AGENT}` } });
    expect(res.status).toBe(400); // past auth
  });
  it('rejects the agent key when none is configured', async () => {
    config.MCP_AGENT_API_KEY = undefined;
    const res = await buildApp().request('/mcp/messages', { method: 'POST', headers: { Authorization: `Bearer ${AGENT}` } });
    expect(res.status).toBe(401);
  });
});
```

For the role-binding of SSE sessions and the place_call role pass-through, test with the in-memory transport the existing `serverStreamableHttp.test.ts` uses: POST a `tools/call` for `place_call` to `/mcp` with the agent key, with `placeCallHandler` mocked via `vi.mock('../../src/mcp/tools/placeCall.js', async (orig) => ({ ...(await orig()), placeCallHandler: vi.fn(async () => ({ taskId: 't', ackMessage: 'ok' })) }))`, and assert `placeCallHandler` was called with `expect.anything(), { role: 'agent' }`; same with the owner key → `{ role: 'owner' }`. Copy the request shape (initialize + tools/call headers) from `tests/mcp/serverStreamableHttp.test.ts`.

SSE session cross-key test (Review Focus 5): unit-test the helper instead of opening a raw-Node stream — extract `sessionRoleMatches(sessions: Map<string, { role: McpRole }>, sessionId: string, role: McpRole): boolean` from `registerMcpRoutes` and test it: same role true, other role false, unknown id false.

get_task_status: in its test file (create `tests/mcp/tools/getTaskStatus.test.ts` if none exists, mocking `getTask`) assert `approval` is absent for an owner task, `'waiting'` for pending-unapproved, `'approved'`, and `'not_approved'` for cancelled-unapproved.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in `server.ts`:

```ts
function keyMatches(authHeader: string, key: string | undefined): boolean {
  if (!key) return false;
  const provided = Buffer.from(authHeader);
  const wanted = Buffer.from(`Bearer ${key}`);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

/** The caller's role, from which key it presented — never from anything it says. Null: neither key. */
function requireAuth(c: Context): McpRole | null {
  const authHeader = c.req.header('Authorization') ?? '';
  // Both compared every time, so timing doesn't tell which key was close.
  const owner = keyMatches(authHeader, config.MCP_API_KEY);
  const agent = keyMatches(authHeader, config.MCP_AGENT_API_KEY);
  return owner ? 'owner' : agent ? 'agent' : null;
}
```

(keep the existing timing-safe comment). Each route: `const role = requireAuth(c); if (!role) return c.text('Unauthorized', 401);`. `createMcpServer({ role })` and `place_call` registers `adapt((input: z.infer<typeof placeCallInputSchema>) => placeCallHandler(input, { role }))`. Extend the `place_call` description: "With an agent key, the call waits for the owner to approve it and get_task_status shows approval: 'waiting' until then." SSE: `const transports = new Map<string, { transport: SSEServerTransport; role: McpRole }>();` set on connect; in the messages route, after looking it up, `if (!sessionRoleMatches(transports, sessionId, role)) return c.text('Unauthorized', 401);` before using it. Update the "Builds the MCP server" and "Every route under /mcp requires" comments to mention the agent key.

`getTaskStatus.ts`: add `approval?: ...` to the type with a doc comment, and `...(approvalState(task) ? { approval: approvalState(task) } : {})`. `listRecentTasks.ts`: map to `{ ...summary, ...(state ? { approval: state } : {}) }`; `TaskSummary = Omit<...> & { approval?: ReturnType<typeof approvalState> }`.

- [ ] **Step 4: Run** `npx vitest run tests/mcp` — PASS.
- [ ] **Step 5: Commit** `feat(mcp): owner and agent roles from the bearer key; approval state in task reads`.

---

### Task 9: Approval page and route

**Files:**
- Create: `src/approvals/routes.ts`, `src/approvals/page.ts`
- Modify: `src/server.ts` (mount; redact `sig` in the request log)
- Test: `tests/approvals/routes.test.ts`, `tests/server.test.ts` (log redaction)

**Interfaces:**
- Consumes: `getTask`, `approveTask` (Task 2), `getContact`, `isValidApprovalSignature` (Task 5), `triggerOrchestration`, `formatLocal` (Task 6).
- Produces: `approvalRoutes: Hono`; `redactQuery(query: Record<string,string>): Record<string,string>` exported from `src/approvals/routes.ts`.

- [ ] **Step 1: Failing tests** `tests/approvals/routes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { getTask, approveTask, getContact, triggerOrchestration } = vi.hoisted(() => ({
  getTask: vi.fn(), approveTask: vi.fn(), getContact: vi.fn(), triggerOrchestration: vi.fn(),
}));
vi.mock('../../src/tasks/service.js', () => ({ getTask, approveTask }));
vi.mock('../../src/contacts/service.js', () => ({ getContact }));
vi.mock('../../src/tasks/orchestrator.js', () => ({ triggerOrchestration }));
const { approvalRoutes, redactQuery } = await import('../../src/approvals/routes.js');
const { approvalSignature } = await import('../../src/approvals/link.js');

const ID = '11111111-1111-1111-1111-111111111111';
const EXPIRES = new Date(Date.now() + 20 * 60_000);
const SIG = approvalSignature(ID, EXPIRES);
const task = (over = {}) => ({ id: ID, contactId: 'c1', status: 'pending', goalDescription: 'Book <b>Friday</b>', mode: 'booking', questions: null, scheduledFor: null, approvalExpiresAt: EXPIRES, approvedAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  getTask.mockResolvedValue(task());
  getContact.mockResolvedValue({ displayName: 'Salon <i>', phoneNumber: '+15550001111' });
});

describe('GET /approve/:taskId', () => {
  it('shows the request, escaped, and changes nothing (Review Focus 3, 4)', async () => {
    const res = await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Book &lt;b&gt;Friday&lt;/b&gt;');
    expect(html).toContain('Salon &lt;i&gt;');
    expect(html).toContain(`name="sig" value="${SIG}"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(approveTask).not.toHaveBeenCalled();
  });
  it.each([
    ['a wrong sig', `/approve/${ID}?sig=${'0'.repeat(64)}`],
    ['no sig', `/approve/${ID}`],
    ['a task that never needed approval', `/approve/${ID}?sig=${SIG}`],
  ])('shows the same invalid-link page for %s', async (label, path) => {
    if (label.startsWith('a task')) getTask.mockResolvedValue(task({ approvalExpiresAt: null }));
    const res = await approvalRoutes.request(path);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link isn't valid");
  });
  it('shows the invalid page for an unknown task', async () => {
    getTask.mockResolvedValue(undefined);
    expect((await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).status).toBe(404);
  });
  it('says when a scheduled time has already passed', async () => {
    getTask.mockResolvedValue(task({ scheduledFor: new Date(Date.now() - 12 * 60_000) }));
    expect(await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text()).toMatch(/approving calls now/i);
  });
});

describe('POST /approve/:taskId', () => {
  const post = (sig: string) => approvalRoutes.request(`/approve/${ID}`, { method: 'POST', body: new URLSearchParams({ sig }) });
  it('approves and starts the run', async () => {
    approveTask.mockResolvedValue('approved');
    const res = await post(SIG);
    expect(res.status).toBe(200);
    expect(approveTask).toHaveBeenCalledWith(ID);
    expect(triggerOrchestration).toHaveBeenCalledWith(ID);
    expect(await res.text()).toMatch(/Approved/);
  });
  it.each([
    ['already_approved', /already approved/i],
    ['expired', /expired/i],
    ['not_waiting', /cancelled|no longer waiting/i],
  ])('reports %s without starting a run', async (outcome, text) => {
    approveTask.mockResolvedValue(outcome);
    const res = await post(SIG);
    expect(await res.text()).toMatch(text);
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });
  it('refuses a bad sig without touching the task', async () => {
    const res = await post('0'.repeat(64));
    expect(res.status).toBe(404);
    expect(approveTask).not.toHaveBeenCalled();
  });
});

describe('redactQuery (Review Focus 1)', () => {
  it('drops sig and keeps the rest', () => {
    expect(redactQuery({ sig: SIG, callId: 'x' })).toEqual({ sig: '[redacted]', callId: 'x' });
  });
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `src/approvals/page.ts`:

```ts
/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px;color:#1a1a1a;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}}dt{font-weight:600;margin-top:.75rem}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;font-weight:600;padding:.75rem 1.5rem;margin-top:1.5rem;border:0;border-radius:.5rem;background:#1d6b3a;color:#fff}.warn{color:#b45309}</style></head><body>${bodyHtml}</body></html>`;
}
```

`src/approvals/routes.ts`:

```ts
import { Hono, type Context } from 'hono';
import { config } from '../config/index.js';
import { getContact } from '../contacts/service.js';
import { triggerOrchestration } from '../tasks/orchestrator.js';
import { approveTask, getTask } from '../tasks/service.js';
import type { Task } from '../tasks/schema.js';
import { isValidApprovalSignature } from './link.js';
import { escapeHtml, page } from './page.js';
import { formatLocal } from './request.js';

/**
 * The owner's approval page for a call an agent asked for. GET only shows
 * it, so a link preview or prefetch can't approve; the button POSTs. Every
 * failure — bad sig, unknown task, a task that never needed approval — gets
 * the same page, so it can't be used to find task ids.
 */
export const approvalRoutes = new Hono();

const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

function invalid(c: Context) {
  return c.html(page('Banjo', "<h1>This link isn't valid</h1><p>Ask for the call again if you still want it.</p>"), 404, HEADERS);
}

async function signedTask(taskId: string, sig: string | undefined): Promise<Task | undefined> {
  if (!sig || !/^[0-9a-f-]{36}$/.test(taskId)) return undefined;
  const task = await getTask(taskId);
  if (!task?.approvalExpiresAt) return undefined;
  return isValidApprovalSignature(task.id, task.approvalExpiresAt, sig) ? task : undefined;
}

approvalRoutes.get('/approve/:taskId', async (c) => {
  const sig = c.req.query('sig');
  const task = await signedTask(c.req.param('taskId'), sig);
  if (!task) return invalid(c);
  const contact = await getContact(task.contactId);
  const now = Date.now();
  const when = !task.scheduledFor
    ? 'Now'
    : task.scheduledFor.getTime() > now
      ? formatLocal(task.scheduledFor)
      : `<span class="warn">Scheduled for ${escapeHtml(formatLocal(task.scheduledFor))}, ${Math.round((now - task.scheduledFor.getTime()) / 60_000)} minutes ago: approving calls now</span>`;
  const rows: Array<[string, string]> = [
    ['Who', escapeHtml(`${contact?.displayName ?? 'Unknown contact'} (${contact?.phoneNumber ?? '?'})`)],
    ['When', task.scheduledFor && task.scheduledFor.getTime() <= now ? when : escapeHtml(when)],
    ['Kind', escapeHtml(task.mode)],
    ['Task', escapeHtml(task.goalDescription)],
    ...(task.questions?.length ? [['Questions', escapeHtml(task.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'))] as [string, string]] : []),
    ['Approve by', escapeHtml(`${formatLocal(task.approvalExpiresAt!)} (${config.CALENDAR_TIMEZONE})`)],
  ];
  const state = task.approvedAt
    ? '<p>Already approved.</p>'
    : task.status !== 'pending'
      ? '<p>This request was cancelled.</p>'
      : task.approvalExpiresAt!.getTime() <= now
        ? '<p>This request expired.</p>'
        : `<form method="post" action="/approve/${task.id}"><input type="hidden" name="sig" value="${escapeHtml(sig!)}"><button type="submit">Approve this call</button></form>`;
  const dl = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  return c.html(page('Approve a call?', `<h1>An agent wants Banjo to call</h1><dl>${dl}</dl>${state}`), 200, HEADERS);
});

const RESULTS = {
  approved: 'Approved. Banjo will place the call.',
  already_approved: 'This call was already approved.',
  expired: 'This request expired, so the call won\'t be placed.',
  not_waiting: 'This request was cancelled or is no longer waiting, so nothing changed.',
  not_found: "This link isn't valid",
} as const;

approvalRoutes.post('/approve/:taskId', async (c) => {
  const body = await c.req.parseBody();
  const sig = typeof body.sig === 'string' ? body.sig : undefined;
  const task = await signedTask(c.req.param('taskId'), sig);
  if (!task) return invalid(c);
  const result = await approveTask(task.id);
  if (result === 'approved') triggerOrchestration(task.id);
  return c.html(page('Banjo', `<h1>${escapeHtml(RESULTS[result])}</h1>`), 200, HEADERS);
});

/** For the request log: the approval signature is a credential. */
export function redactQuery(query: Record<string, string>): Record<string, string> {
  return 'sig' in query ? { ...query, sig: '[redacted]' } : query;
}
```

`src/server.ts`: import `{ approvalRoutes, redactQuery }`; in the logging middleware `query: redactQuery(c.req.query())`; mount `app.route('/', approvalRoutes);` after `healthRoutes`.

- [ ] **Step 4: Run** `npx vitest run tests/approvals tests/server.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(approvals): the owner's approve page`.

---

### Task 10: Docs and the skill

**Files:** `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/AGENT_SETUP.md`, `docs/RUNBOOKS.md`, `skills/schedule-appointment/SKILL.md`

- [ ] **Step 1:** `CLAUDE.md` orchestrator bullet: replace "There's no override, and don't add one." with "The owner can override it only for themselves or `family`, up to twice the cap (`place_call`'s `overrideCallCap`, owner key only); never widen that." MCP bullet: add "A second key, `MCP_AGENT_API_KEY`, gives the agent role: its `place_call` waits for the owner to tap Approve on a signed link (`src/approvals/`), and expires unapproved after 30 minutes. The role comes only from the key."
- [ ] **Step 2:** `docs/ARCHITECTURE.md` ~line 93: state the override and its ceiling where it says "with no override"; add a short "Agent calls need approval" section (why, how, the link's properties).
- [ ] **Step 3:** `docs/AGENT_SETUP.md`: the agent key, what the agent sees (`approval: 'waiting'`, the ack text), what to tell the owner, and that the link never reaches the agent. `docs/RUNBOOKS.md`: rotating `MCP_AGENT_API_KEY`; rotating `MCP_API_KEY` voids waiting approval links.
- [ ] **Step 4:** `SKILL.md`: a short "Call limit" note: `overrideCallCap` only after the owner says yes in this conversation, for family or themselves, naming the count today; never on your own initiative.
- [ ] **Step 5: Commit** `docs: agent approval and the owner's cap override`.

---

### Task 11: Full verification

- [ ] `npx tsc --noEmit` — exit 0.
- [ ] `npm run build` — exit 0, `dist/approvals/*.js` present.
- [ ] CI-like suite: move `.env` aside, `env -u GEMINI_API_KEY npx vitest run; echo exit=$?`, restore `.env`. Exit 0, no "Unhandled" or "Errors" lines.
- [ ] `npm run lint` if the repo has it.
- [ ] Push the branch and open one PR (no session links in the body).
