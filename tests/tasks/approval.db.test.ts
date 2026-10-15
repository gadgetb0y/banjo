import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// DB-backed (banjo_test — see vitest.config.ts): approve and expiry are
// compare-and-sets, and only Postgres can show which of them wins.
let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let service: typeof import('../../src/tasks/service.js');
let approval: typeof import('../../src/tasks/approval.js');

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  service = await import('../../src/tasks/service.js');
  approval = await import('../../src/tasks/approval.js');
});

async function clearTables() {
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}

beforeEach(clearTables);
afterAll(clearTables);

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
    expect(approval.isAwaitingApproval(t)).toBe(true);
    expect(await service.approveTask(t.id)).toBe('approved');
    expect(await service.approveTask(t.id)).toBe('already_approved');
    const after = await service.getTask(t.id);
    expect(after?.approvedAt).toBeInstanceOf(Date);
    expect(approval.isAwaitingApproval(after!)).toBe(false);
    expect(approval.approvalState(after!)).toBe('approved');
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
    expect(approval.approvalState(owner)).toBeUndefined();
    expect(approval.approvalState((await service.getTask(cancelled.id))!)).toBe('not_approved');
  });

  it('expires only unapproved, past-due, pending requests', async () => {
    const c = await contactRow();
    const past = await agentTask(c.id, new Date(Date.now() - MIN));
    const future = await agentTask(c.id, new Date(Date.now() + 30 * MIN));
    const approved = await agentTask(c.id, new Date(Date.now() + MIN));
    await service.approveTask(approved.id);
    const owner = await service.createTask({ contactId: c.id, channel: 'phone', goalDescription: 'Book', constraints: {} });
    expect(await service.expireApprovalRequests(new Date(Date.now() + 2 * MIN))).toEqual([past.id]);
    const swept = await service.getTask(past.id);
    expect(swept?.status).toBe('cancelled');
    expect(approval.approvalState(swept!)).toBe('not_approved');
    for (const t of [future, approved, owner]) expect((await service.getTask(t.id))?.status).toBe('pending');
  });

  it('refuses an approve that lands after the expiry sweep', async () => {
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
    const owner = await service.createTask({ contactId: c.id, channel: 'phone', goalDescription: 'Book', constraints: {} });
    expect(await service.countTasksAwaitingApproval()).toBe(1);
    const startable = (await service.listStartableTasks()).map((t) => t.id);
    expect(startable).toEqual(expect.arrayContaining([approved.id, owner.id]));
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

describe('withApprovalRequestLock', () => {
  it('lets only 3 of 5 simultaneous agent requests through the waiting limit', async () => {
    const c = await contactRow();
    const attempt = () =>
      service.withApprovalRequestLock(async () => {
        if ((await service.countTasksAwaitingApproval()) >= 3) return 'refused';
        // A slow insert widens the gap a check-then-create race needs.
        await new Promise((r) => setTimeout(r, 20));
        await agentTask(c.id, new Date(Date.now() + 30 * MIN));
        return 'created';
      });
    const results = await Promise.all(Array.from({ length: 5 }, attempt));
    expect(results.filter((r) => r === 'created')).toHaveLength(3);
    expect(await service.countTasksAwaitingApproval()).toBe(3);
  });
});
