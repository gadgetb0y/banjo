import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlotUnavailableError } from '../../src/calendar/types.js';
import type { CalendarProvider } from '../../src/calendar/types.js';
import type { CallContext } from '../../src/session/types.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';

// confirm_appointment's handler calls transitionTask on success — stub the
// whole persistence layer rather than hitting a real DB, matching the
// pattern already used in tests/session/callSession.test.ts.
const transitionTask = vi.fn(async (id: string, status: string) => ({ id, status }));
vi.mock('../../src/tasks/service.js', () => ({
  getTask: vi.fn(async () => undefined),
  transitionTask,
  NON_TERMINAL_STATUSES: ['negotiating'],
}));

const { confirmAppointmentTool } = await import('../../src/voice/tools/callTools.js');

const task = { id: 'task-1', goalDescription: 'Book a haircut' } as Task;
const callAttempt = { id: 'call-attempt-1' } as CallAttempt;

function makeContext(calendar: CalendarProvider): CallContext {
  return {
    task,
    callAttempt,
    callId: callAttempt.id,
    telephony: {} as CallContext['telephony'],
    calendar,
    estimatedAudioDoneAt: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confirmAppointmentTool.handler', () => {
  it('returns a slot_unavailable failure — not a generic upstream_error — when the calendar refuses a double-booked slot', async () => {
    // Regression coverage: createEventIdempotent now guards against
    // double-booking by throwing SlotUnavailableError (see
    // tests/calendar/googleCalendarProvider.test.ts). This test locks in
    // that runToolSafely (callTools.ts) classifies that specific error as
    // "slot_unavailable" rather than lumping it in with any other thrown
    // error as "upstream_error" — the model needs to be able to tell "the
    // time you asked for got taken, negotiate a new one" apart from "the
    // calendar API is broken, maybe retry."
    const calendar: CalendarProvider = {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => false),
      createEventIdempotent: vi.fn(async () => {
        throw new SlotUnavailableError();
      }),
      findEventByIdempotencyKey: vi.fn(async () => undefined),
      deleteEvent: vi.fn(async () => {}),
    };

    const result = await confirmAppointmentTool.handler(
      { confirmedStart: '2026-08-05T14:00:00', durationMinutes: 30 },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: false, error: 'slot_unavailable' });
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('confirms and transitions the task when the calendar accepts the booking', async () => {
    const calendar: CalendarProvider = {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => true),
      createEventIdempotent: vi.fn(async () => ({
        eventId: 'evt-1',
        confirmedStart: '2026-08-05T18:00:00.000Z',
        confirmedEnd: '2026-08-05T18:30:00.000Z',
      })),
      findEventByIdempotencyKey: vi.fn(async () => undefined),
      deleteEvent: vi.fn(async () => {}),
    };

    const result = await confirmAppointmentTool.handler(
      { confirmedStart: '2026-08-05T14:00:00', durationMinutes: 30 },
      makeContext(calendar),
    );

    // 18:00 UTC is 2:00 PM in America/New_York. The model is told every time is
    // local, so a UTC string here is the 4-hours-off failure waiting to be read
    // back aloud (#44) — and a spoken form spares it working out the weekday.
    expect(result).toMatchObject({
      ok: true,
      confirmedStart: '2026-08-05T14:00:00',
      spokenStart: 'Wednesday, August 5 at 2:00 PM',
    });
    expect(transitionTask).toHaveBeenCalledTimes(1);
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'confirmed', expect.objectContaining({ calendarEventId: 'evt-1' }));
  });

  it('records the time the CALENDAR actually holds, not the time we asked for', async () => {
    // The idempotency key is derived from the call attempt, so a confirm that
    // fails *after* Google created the event (timeout, dropped response) and
    // is then retried at a renegotiated time gets the ORIGINAL event back from
    // the guard. Recording the requested time here would leave Postgres saying
    // 19:00 while the calendar holds 18:00 — and Postgres is meant to be the
    // source of truth for whether an appointment was booked, and when.
    const calendar: CalendarProvider = {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => true),
      createEventIdempotent: vi.fn(async () => ({
        eventId: 'evt-1',
        confirmedStart: '2026-08-05T18:00:00.000Z',
        confirmedEnd: '2026-08-05T18:30:00.000Z',
      })),
      findEventByIdempotencyKey: vi.fn(async () => undefined),
      deleteEvent: vi.fn(async () => {}),
    };

    // Asking for 15:00 local / 19:00Z and a 60-minute slot, but the calendar
    // comes back holding the earlier 18:00Z / 30-minute event.
    await confirmAppointmentTool.handler(
      { confirmedStart: '2026-08-05T15:00:00', durationMinutes: 60 },
      makeContext(calendar),
    );

    expect(transitionTask).toHaveBeenCalledWith(
      'task-1',
      'confirmed',
      expect.objectContaining({
        outcome: expect.objectContaining({
          kind: 'confirmed',
          start: '2026-08-05T18:00:00.000Z',
          durationMinutes: 30,
        }),
      }),
    );
  });

  it('gives the calendar event a short title instead of the raw task prompt', async () => {
    // goalDescription is a prompt written for the model ("Book a dinner table
    // for two at Luigi's. Any evening in the next five days works; ask what
    // they have available..."), and it was going straight into the event
    // summary — i.e. into Steve's actual calendar.
    const createEventIdempotent = vi.fn(async () => ({
      eventId: 'evt-1',
      confirmedStart: '2026-08-05T18:00:00.000Z',
      confirmedEnd: '2026-08-05T18:30:00.000Z',
    }));
    const calendar: CalendarProvider = {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => true),
      createEventIdempotent,
      findEventByIdempotencyKey: vi.fn(async () => undefined),
      deleteEvent: vi.fn(async () => {}),
    };

    await confirmAppointmentTool.handler(
      { confirmedStart: '2026-08-05T14:00:00', durationMinutes: 30, summary: 'Dinner at Luigi\'s' },
      makeContext(calendar),
    );

    expect(createEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Dinner at Luigi\'s' }),
    );
  });

  it('falls back to the first sentence of the goal description when the model omits a title', async () => {
    const longGoal = {
      ...task,
      goalDescription:
        "Book a dinner table for two at Luigi's. Any evening in the next five days works; ask what they have available and take the earliest that fits.",
    } as Task;
    const createEventIdempotent = vi.fn(async () => ({
      eventId: 'evt-1',
      confirmedStart: '2026-08-05T18:00:00.000Z',
      confirmedEnd: '2026-08-05T18:30:00.000Z',
    }));
    const calendar: CalendarProvider = {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => true),
      createEventIdempotent,
      findEventByIdempotencyKey: vi.fn(async () => undefined),
      deleteEvent: vi.fn(async () => {}),
    };

    await confirmAppointmentTool.handler(
      { confirmedStart: '2026-08-05T14:00:00', durationMinutes: 30 },
      { ...makeContext(calendar), task: longGoal },
    );

    expect(createEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Book a dinner table for two at Luigi's" }),
    );
  });

  it('truncates a fallback title that has no sentence break to keep it calendar-sized', async () => {
    const ramblingGoal = {
      ...task,
      goalDescription: `Book something ${'very '.repeat(40)}long`,
    } as Task;
    const createEventIdempotent = vi.fn(async () => ({
      eventId: 'evt-1',
      confirmedStart: '2026-08-05T18:00:00.000Z',
      confirmedEnd: '2026-08-05T18:30:00.000Z',
    }));
    const calendar: CalendarProvider = {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => true),
      createEventIdempotent,
      findEventByIdempotencyKey: vi.fn(async () => undefined),
      deleteEvent: vi.fn(async () => {}),
    };

    await confirmAppointmentTool.handler(
      { confirmedStart: '2026-08-05T14:00:00', durationMinutes: 30 },
      { ...makeContext(calendar), task: ramblingGoal },
    );

    // At most 80 characters, and visibly cut rather than silently clipped.
    expect(createEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringMatching(/^.{1,79}…$/s) }),
    );
  });
});

describe('what the model is told to do after a booking goes through (#47)', () => {
  // Live call, 2026-09-23, after #44 added a read-back rule to the system
  // prompt: right after confirm_appointment succeeded the model said "Great,
  // thanks for confirming—let me wrap this up." and hung up. No read-back, no
  // goodbye. At that moment the tool result is what it follows, so the result
  // carries the next step.
  function bookingCalendar(): CalendarProvider {
    return {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => true),
      createEventIdempotent: vi.fn(async () => ({
        eventId: 'evt-1',
        confirmedStart: '2026-09-25T14:00:00.000Z',
        confirmedEnd: '2026-09-25T15:30:00.000Z',
      })),
      findEventByIdempotencyKey: vi.fn(async () => undefined),
      deleteEvent: vi.fn(async () => {}),
    };
  }

  async function confirm(mode?: Task['mode']) {
    const ctx = makeContext(bookingCalendar());
    ctx.task = { ...task, mode } as Task;
    return (await confirmAppointmentTool.handler(
      { confirmedStart: '2026-09-25T10:00:00', durationMinutes: 90, summary: 'Full groom for Banjo' },
      ctx,
    )) as { ok: true; nextStep: string };
  }

  it('booking call: read the booking back with the real day and time, say an actual goodbye, then end_call', async () => {
    const { nextStep } = await confirm('booking');
    expect(nextStep).toContain('Friday, September 25 at 10:00 AM');
    expect(nextStep).toMatch(/goodbye/i);
    expect(nextStep).toContain('end_call');
  });

  it('booking call: forbids describing the ending instead of doing it', async () => {
    const { nextStep } = await confirm('booking');
    expect(nextStep).toMatch(/never say you are wrapping up/i);
  });

  it('a task with no mode is a booking call', async () => {
    expect((await confirm(undefined)).nextStep).toContain('end_call');
  });

  it('conversation call: read it back, then carry on — a booking there is not the end of the call', async () => {
    const { nextStep } = await confirm('conversation');
    expect(nextStep).toContain('Friday, September 25 at 10:00 AM');
    expect(nextStep).not.toContain('end_call');
    expect(nextStep).toMatch(/carry on/i);
  });
});
