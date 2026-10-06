import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listRecentTasks } = vi.hoisted(() => ({ listRecentTasks: vi.fn() }));
vi.mock('../../../src/tasks/service.js', () => ({ listRecentTasks }));

const { listRecentTasksHandler } = await import('../../../src/mcp/tools/listRecentTasks.js');

// A week of half-hour slots, as the default lookahead stores for a call
// with no dateWindows (#120).
const WEEK_OF_SLOTS = Array.from({ length: 336 }, (_, i) => ({
  start: new Date(Date.UTC(2026, 9, 6) + i * 1_800_000).toISOString(),
  end: new Date(Date.UTC(2026, 9, 6) + (i + 1) * 1_800_000).toISOString(),
}));

const TASK = {
  id: '22222222-2222-2222-2222-222222222222',
  contactId: '33333333-3333-3333-3333-333333333333',
  channel: 'phone',
  mode: 'conversation',
  goalDescription: 'Thank her for the ticket.',
  constraints: {},
  status: 'voicemail_left',
  candidateWindows: WEEK_OF_SLOTS,
  outcome: { kind: 'voicemail_left', message: 'Thanks for the ticket. Bye!' },
  calendarEventId: null,
  scheduledFor: null,
  createdAt: new Date('2026-10-06T17:23:00Z'),
  updatedAt: new Date('2026-10-06T17:25:09Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcp: list_recent_tasks', () => {
  it('leaves out candidateWindows and keeps everything else', async () => {
    listRecentTasks.mockResolvedValue([TASK]);
    const [summary] = await listRecentTasksHandler({});
    expect(summary).not.toHaveProperty('candidateWindows');
    const { candidateWindows: _omitted, ...rest } = TASK;
    expect(summary).toEqual(rest);
  });

  it('asks for 20 tasks by default, or the limit given', async () => {
    listRecentTasks.mockResolvedValue([]);
    await listRecentTasksHandler({});
    expect(listRecentTasks).toHaveBeenLastCalledWith(20);
    await listRecentTasksHandler({ limit: 5 });
    expect(listRecentTasks).toHaveBeenLastCalledWith(5);
  });
});
