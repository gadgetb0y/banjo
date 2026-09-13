import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTask, transitionTask, createCallAttempt, getContact, CallSession, logger } = vi.hoisted(() => ({
  getTask: vi.fn(),
  transitionTask: vi.fn(),
  createCallAttempt: vi.fn(),
  getContact: vi.fn(),
  CallSession: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/tasks/service.js', () => ({
  getTask,
  transitionTask,
  createCallAttempt,
  isTaskDue: () => true,
  listNonTerminalTasks: vi.fn(async () => []),
}));
vi.mock('../../src/contacts/service.js', () => ({ getContact }));
vi.mock('../../src/session/callSession.js', () => ({ CallSession }));
vi.mock('../../src/lib/logger.js', () => ({ logger }));
vi.mock('../../src/calendar/googleCalendarProvider.js', () => ({
  GoogleCalendarProvider: class {
    computeCandidateWindows = vi.fn(async () => []);
  },
}));
vi.mock('../../src/telephony/factory.js', () => ({ createTelephonyProvider: vi.fn() }));
vi.mock('../../src/tasks/callSessionAdapter.js', () => ({ buildOutboundCallSessionOptions: vi.fn() }));
vi.mock('../../src/tasks/promptBuilder.js', () => ({ buildCallSystemPrompt: vi.fn(), buildCallFrontendPrompt: vi.fn() }));

const { clipWindowsToFuture, triggerOrchestration } = await import('../../src/tasks/orchestrator.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clipWindowsToFuture', () => {
  const now = new Date('2026-09-20T13:00:00.000Z');

  it('drops windows that are entirely over and starts a partly-past window at now', () => {
    expect(
      clipWindowsToFuture(
        [
          { start: '2026-09-13T13:00:00.000Z', end: '2026-09-16T13:00:00.000Z' },
          { start: '2026-09-19T13:00:00.000Z', end: '2026-09-21T13:00:00.000Z' },
          { start: '2026-09-22T13:00:00.000Z', end: '2026-09-23T13:00:00.000Z' },
        ],
        now,
      ),
    ).toEqual([
      { start: '2026-09-20T13:00:00.000Z', end: '2026-09-21T13:00:00.000Z' },
      { start: '2026-09-22T13:00:00.000Z', end: '2026-09-23T13:00:00.000Z' },
    ]);
  });
});

describe('triggerOrchestration: a cancel racing the start of a run', () => {
  it('does not place the call when the task was cancelled between the read and the first transition', async () => {
    getTask.mockResolvedValue({ id: 'task-1', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {} });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockResolvedValue({ id: 'task-1', status: 'cancelled' });

    triggerOrchestration('task-1');
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }), expect.any(String)));

    expect(transitionTask).toHaveBeenCalledTimes(1);
    expect(createCallAttempt).not.toHaveBeenCalled();
    expect(CallSession).not.toHaveBeenCalled();
  });
});
