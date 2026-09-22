import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listLiveCalls, registerLiveCall, unregisterLiveCall } from '../../src/tasks/liveCalls.js';

const transitionTask = vi.fn(async () => ({ status: 'failed' }));
const listNonTerminalTasks = vi.fn();
const latestCallAttemptFor = vi.fn();
vi.mock('../../src/tasks/service.js', () => ({
  transitionTask,
  listNonTerminalTasks,
  latestCallAttemptFor,
  NON_TERMINAL_STATUSES: ['pending', 'checking_availability', 'calling', 'negotiating'],
}));

const findEventByIdempotencyKey = vi.fn();
vi.mock('../../src/calendar/googleCalendarProvider.js', () => ({
  GoogleCalendarProvider: class {
    findEventByIdempotencyKey = findEventByIdempotencyKey;
  },
}));

const notifyIfTerminal = vi.fn(async () => {});
vi.mock('../../src/tasks/callSessionAdapter.js', () => ({
  buildOutboundCallSessionOptions: vi.fn(),
  notifyTaskOutcome: notifyIfTerminal,
}));

const { sweepStaleCalls } = await import('../../src/tasks/orchestrator.js');

const LONG_AGO = new Date(Date.now() - 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  for (const c of listLiveCalls()) unregisterLiveCall(c.taskId);
  findEventByIdempotencyKey.mockResolvedValue(undefined);
});

describe('sweepStaleCalls', () => {
  it('fails a call whose process died, so the user actually hears about it', async () => {
    listNonTerminalTasks.mockResolvedValue([{ id: 'task-1', status: 'negotiating' }]);
    latestCallAttemptFor.mockResolvedValue({ id: 'attempt-1', startedAt: LONG_AGO, endedAt: null });

    await sweepStaleCalls();

    expect(transitionTask).toHaveBeenCalledWith(
      'task-1',
      'failed',
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed' }) }),
      { from: ['calling', 'negotiating'] },
    );
    expect(notifyIfTerminal).toHaveBeenCalledWith('task-1');
  });

  it('leaves alone a call this process is still driving, however long it has run', async () => {
    listNonTerminalTasks.mockResolvedValue([{ id: 'task-1', status: 'negotiating' }]);
    latestCallAttemptFor.mockResolvedValue({ id: 'attempt-1', startedAt: LONG_AGO, endedAt: null });
    registerLiveCall({ taskId: 'task-1', callAttemptId: 'attempt-1', session: { stop: vi.fn() } });

    await sweepStaleCalls();

    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('leaves a recently-started call alone', async () => {
    listNonTerminalTasks.mockResolvedValue([{ id: 'task-1', status: 'calling' }]);
    latestCallAttemptFor.mockResolvedValue({ id: 'attempt-1', startedAt: new Date(), endedAt: null });

    await sweepStaleCalls();

    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('ignores tasks that never reached the phone', async () => {
    listNonTerminalTasks.mockResolvedValue([{ id: 'task-1', status: 'pending' }]);

    await sweepStaleCalls();

    expect(latestCallAttemptFor).not.toHaveBeenCalled();
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('reports the booking when the calendar shows the call DID confirm before dying', async () => {
    // The dangerous case: an event exists, so telling the user "failed,
    // nothing happened" would be a lie they'd act on.
    listNonTerminalTasks.mockResolvedValue([{ id: 'task-1', status: 'negotiating' }]);
    latestCallAttemptFor.mockResolvedValue({ id: 'attempt-1', startedAt: LONG_AGO, endedAt: null });
    findEventByIdempotencyKey.mockResolvedValue({
      eventId: 'evt-1',
      confirmedStart: '2026-09-25T22:00:00.000Z',
      confirmedEnd: '2026-09-25T23:30:00.000Z',
    });

    await sweepStaleCalls();

    expect(findEventByIdempotencyKey).toHaveBeenCalledWith('confirm:attempt-1');
    expect(transitionTask).toHaveBeenCalledWith(
      'task-1',
      'confirmed',
      expect.objectContaining({
        calendarEventId: 'evt-1',
        outcome: expect.objectContaining({ kind: 'confirmed', start: '2026-09-25T22:00:00.000Z', durationMinutes: 90 }),
      }),
      { from: ['calling', 'negotiating'] },
    );
  });

  it('still fails the task when the calendar lookup itself is broken', async () => {
    // A Calendar outage must not stall the sweep — better an honest "we don't
    // know" than a task silently left in limbo, which is the bug being fixed.
    listNonTerminalTasks.mockResolvedValue([{ id: 'task-1', status: 'negotiating' }]);
    latestCallAttemptFor.mockResolvedValue({ id: 'attempt-1', startedAt: LONG_AGO, endedAt: null });
    findEventByIdempotencyKey.mockRejectedValue(new Error('calendar down'));

    await sweepStaleCalls();

    expect(transitionTask).toHaveBeenCalledWith('task-1', 'failed', expect.anything(), expect.anything());
  });
});
