import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProvider } from '../../src/calendar/types.js';
import type { CallContext } from '../../src/session/types.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';

const transitionTask = vi.fn(async (id: string, status: string) => ({ id, status }));
vi.mock('../../src/tasks/service.js', () => ({
  getTask: vi.fn(async () => undefined),
  transitionTask,
  NON_TERMINAL_STATUSES: ['pending', 'checking_availability', 'calling', 'negotiating'],
}));

const { undoConfirmedAppointmentTool } = await import('../../src/voice/tools/callTools.js');

const confirmedTask = {
  id: 'task-1',
  status: 'confirmed',
  goalDescription: 'Book a table',
  calendarEventId: 'evt-1',
} as Task;
const callAttempt = { id: 'call-attempt-1' } as CallAttempt;

function makeContext(calendar: CalendarProvider, task: Task = confirmedTask): CallContext {
  return {
    task,
    callAttempt,
    callId: callAttempt.id,
    telephony: {} as CallContext['telephony'],
    calendar,
    estimatedAudioDoneAt: Date.now(),
  };
}

function makeCalendar(overrides: Partial<CalendarProvider> = {}): CalendarProvider {
  return {
    computeCandidateWindows: vi.fn(async () => []),
    isFree: vi.fn(async () => true),
    createEventIdempotent: vi.fn(async () => ({ eventId: 'evt-1', confirmedStart: '', confirmedEnd: '' })),
    findEventByIdempotencyKey: vi.fn(async () => undefined),
    deleteEvent: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('undoConfirmedAppointmentTool', () => {
  it('deletes the calendar event and puts the task back into negotiating', async () => {
    // The live-call failure this exists for: the model confirmed 6pm while the
    // other party was still negotiating, then had nothing to undo it with and
    // told them to phone the business themselves.
    const calendar = makeCalendar();

    const result = await undoConfirmedAppointmentTool.handler(
      { reason: 'Callee asked for 5pm instead right after it was confirmed' },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: true });
    expect(calendar.deleteEvent).toHaveBeenCalledWith('evt-1');
    // Narrow compare-and-set: this is the ONLY way out of a terminal status,
    // and it must not become a general-purpose reopen.
    expect(transitionTask).toHaveBeenCalledWith(
      'task-1',
      'negotiating',
      { outcome: null, calendarEventId: null },
      { from: ['confirmed'] },
    );
  });

  it('refuses when there is no confirmed booking to undo, without touching the calendar', async () => {
    const calendar = makeCalendar();
    const negotiating = { ...confirmedTask, status: 'negotiating', calendarEventId: null } as Task;

    const result = await undoConfirmedAppointmentTool.handler({ reason: 'nothing to undo' }, makeContext(calendar, negotiating));

    expect(result).toMatchObject({ ok: false, error: 'nothing_to_undo' });
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('leaves the calendar event alone if the task moved on before the undo landed', async () => {
    // Something else took the task terminal between confirm and undo (an
    // end-of-call failure, say). Deleting the event first and then failing the
    // transition would leave Postgres claiming a booking that no longer exists
    // — the exact divergence the confirm path is careful to avoid.
    transitionTask.mockResolvedValueOnce(undefined as never);
    const calendar = makeCalendar();

    const result = await undoConfirmedAppointmentTool.handler({ reason: 'too late' }, makeContext(calendar));

    expect(result).toMatchObject({ ok: false, error: 'nothing_to_undo' });
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
  });
});
