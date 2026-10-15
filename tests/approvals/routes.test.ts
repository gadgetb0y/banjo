import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTask, approveTask, getContact, triggerOrchestration } = vi.hoisted(() => ({
  getTask: vi.fn(),
  approveTask: vi.fn(),
  getContact: vi.fn(),
  triggerOrchestration: vi.fn(),
}));
vi.mock('../../src/tasks/service.js', () => ({ getTask, approveTask }));
vi.mock('../../src/contacts/service.js', () => ({ getContact }));
vi.mock('../../src/tasks/orchestrator.js', () => ({ triggerOrchestration }));

const { approvalRoutes } = await import('../../src/approvals/routes.js');
const { approvalSignature } = await import('../../src/approvals/link.js');

const ID = '11111111-1111-1111-1111-111111111111';
const EXPIRES = new Date(Date.now() + 20 * 60_000);
const SIG = approvalSignature(ID, EXPIRES);

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    contactId: 'c1',
    status: 'pending',
    goalDescription: 'Book <b>Friday</b> "at 7"',
    mode: 'booking',
    questions: null,
    scheduledFor: null,
    approvalExpiresAt: EXPIRES,
    approvedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getTask.mockResolvedValue(task());
  getContact.mockResolvedValue({ displayName: 'Salon <i>', phoneNumber: '+15550001111' });
});

describe('GET /approve/:taskId', () => {
  it('shows the request with what the agent wrote escaped, and changes nothing', async () => {
    const res = await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Book &lt;b&gt;Friday&lt;/b&gt; &quot;at 7&quot;');
    expect(html).not.toContain('<b>Friday');
    expect(html).toContain('Salon &lt;i&gt; (+15550001111)');
    expect(html).toContain(`name="sig" value="${SIG}"`);
    expect(html).toContain(`action="/approve/${ID}"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(approveTask).not.toHaveBeenCalled();
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });

  it("lists an ask call's questions", async () => {
    getTask.mockResolvedValue(task({ mode: 'ask', questions: ['Open <Sunday>?'] }));
    expect(await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text()).toContain('1. Open &lt;Sunday&gt;?');
  });

  it.each([
    ['a wrong sig', `/approve/${ID}?sig=${'0'.repeat(64)}`, task()],
    ['no sig', `/approve/${ID}`, task()],
    ['a task that never needed approval', `/approve/${ID}?sig=${SIG}`, task({ approvalExpiresAt: null })],
    ['an unknown task', `/approve/${ID}?sig=${SIG}`, undefined],
    ['a malformed id', `/approve/not-a-uuid?sig=${SIG}`, task()],
  ])('shows the same invalid-link page for %s', async (_label, path, row) => {
    getTask.mockResolvedValue(row);
    const res = await approvalRoutes.request(path);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('This link isn’t valid');
  });

  it('says plainly when the scheduled time has passed', async () => {
    getTask.mockResolvedValue(task({ scheduledFor: new Date(Date.now() - 12 * 60_000) }));
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toMatch(/12 minutes ago: approving calls now/);
  });

  it.each([
    ['already approved', task({ approvedAt: new Date() }), /already approved/i],
    ['cancelled', task({ status: 'cancelled' }), /cancelled/i],
    ['expired', task({ approvalExpiresAt: new Date(Date.now() - 1000) }), /expired/i],
  ])('offers no button once %s', async (_label, row, text) => {
    getTask.mockResolvedValue(row);
    const sig = approvalSignature(ID, row.approvalExpiresAt as Date);
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${sig}`)).text();
    expect(html).toMatch(text);
    expect(html).not.toContain('<button');
  });
});

describe('POST /approve/:taskId', () => {
  const post = (sig: string) =>
    approvalRoutes.request(`/approve/${ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sig }).toString(),
    });

  it('approves and starts the call', async () => {
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
    ['not_waiting', /cancelled/i],
  ])('reports %s without starting a call', async (outcome, text) => {
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
