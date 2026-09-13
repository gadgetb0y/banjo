import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// placeCallHandler writes a Task row and triggers orchestration — stub both so
// the scheduling behavior can be exercised without a DB or a real call.
const { createTask, triggerOrchestration } = vi.hoisted(() => ({
  createTask: vi.fn(async () => ({ id: 'task-1' })),
  triggerOrchestration: vi.fn(),
}));
vi.mock('../../src/tasks/service.js', () => ({ createTask }));
vi.mock('../../src/tasks/orchestrator.js', () => ({ triggerOrchestration }));

const { placeCallHandler, placeCallInputSchema } = await import('../../src/mcp/tools/placeCall.js');

const CONTACT_ID = '11111111-1111-1111-1111-111111111111';

describe('mcp: place_call schema', () => {
  it('accepts mode omitted, "booking", and "conversation"', () => {
    const base = { contactId: CONTACT_ID, taskDescription: 'Call and chat' };
    expect(placeCallInputSchema.safeParse(base).success).toBe(true);
    expect(placeCallInputSchema.safeParse({ ...base, mode: 'booking' }).success).toBe(true);
    expect(placeCallInputSchema.safeParse({ ...base, mode: 'conversation' }).success).toBe(true);
  });

  it('rejects an invalid mode value', () => {
    const result = placeCallInputSchema.safeParse({
      contactId: CONTACT_ID,
      taskDescription: 'Call and chat',
      mode: 'something_else',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional scheduledFor local date-time', () => {
    expect(
      placeCallInputSchema.safeParse({ contactId: CONTACT_ID, taskDescription: 'Call later', scheduledFor: '2026-09-13T09:00:00' }).success,
    ).toBe(true);
  });
});

describe('mcp: place_call scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T04:30:00.000Z')); // 12:30am in America/New_York (the vitest default zone)
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls right away when scheduledFor is omitted', async () => {
    const result = await placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call and chat' });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ scheduledFor: undefined }));
    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
    expect(result.ackMessage).toContain('Started calling');
  });

  it('stores a future scheduledFor interpreted in CALENDAR_TIMEZONE, and does not start the call yet', async () => {
    const result = await placeCallHandler({
      contactId: CONTACT_ID,
      taskDescription: 'Ask about breakfast',
      scheduledFor: '2026-09-13T09:00:00',
    });

    // 9:00am America/New_York in September is EDT (UTC-4) — never the server's own zone.
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ scheduledFor: new Date('2026-09-13T13:00:00.000Z') }));
    expect(triggerOrchestration).not.toHaveBeenCalled();
    expect(result.ackMessage).toContain('Scheduled a call');
    expect(result.ackMessage).toContain('9:00');
  });

  it('calls right away when scheduledFor is already in the past', async () => {
    await placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call now', scheduledFor: '2026-09-12T20:00:00' });

    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
  });

  it('rejects a date-only scheduledFor, which would otherwise place the call at midnight, without creating a task', async () => {
    await expect(placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call tomorrow', scheduledFor: '2026-09-14' })).rejects.toThrow(
      /must include a time of day/,
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });

  it('rejects an unparseable scheduledFor without creating a task', async () => {
    await expect(placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call later', scheduledFor: '2026-02-30Tnoon:00' })).rejects.toThrow(
      /scheduledFor/,
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });
});
