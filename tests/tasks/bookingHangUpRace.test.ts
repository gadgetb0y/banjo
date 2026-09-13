import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProvider, CreateEventResult } from '../../src/calendar/types.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

// DB-backed (banjo_test — see vitest.config.ts): the race below is about what
// Postgres ends up saying, so it runs the real transitionTask guard, the real
// end-of-call adapter, and the real confirm_appointment handler together.
let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let service: typeof import('../../src/tasks/service.js');
let buildOutboundCallSessionOptions: typeof import('../../src/tasks/callSessionAdapter.js').buildOutboundCallSessionOptions;
let confirmAppointmentTool: typeof import('../../src/voice/tools/callTools.js').confirmAppointmentTool;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  service = await import('../../src/tasks/service.js');
  ({ buildOutboundCallSessionOptions } = await import('../../src/tasks/callSessionAdapter.js'));
  ({ confirmAppointmentTool } = await import('../../src/voice/tools/callTools.js'));
});

beforeEach(async () => {
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
});

const telephony: TelephonyProvider = {
  name: 'fake-telephony',
  nativeAudioFormat: 'g711_ulaw_8k',
  originateCall: vi.fn(async () => ({ providerCallId: 'CA-fake-sid' })),
  sendAudio: vi.fn(),
  sendDigits: vi.fn(async () => {}),
  interrupt: vi.fn(),
  hangUp: vi.fn(async () => {}),
  on: vi.fn(),
  off: vi.fn(),
};

/** A calendar whose event write stays in flight until the test finishes it. */
function calendarWithPendingWrite() {
  let finishWrite!: () => void;
  const calendar: CalendarProvider = {
    computeCandidateWindows: vi.fn(async () => []),
    isFree: vi.fn(async () => true),
    createEventIdempotent: vi.fn(
      () =>
        new Promise<CreateEventResult>((resolve) => {
          finishWrite = () =>
            resolve({ eventId: 'evt-race', confirmedStart: '2026-09-15T18:00:00.000Z', confirmedEnd: '2026-09-15T18:30:00.000Z' });
        }),
    ),
    deleteEvent: vi.fn(async () => {}),
  };
  return { calendar, finishWrite: () => finishWrite() };
}

async function startNegotiatingCall(calendar: CalendarProvider) {
  const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230000' }).returning();
  const created = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Book a haircut', constraints: {} });
  const task = await service.transitionTask(created.id, 'negotiating');
  const callAttempt = await service.createCallAttempt(task.id);
  const options = buildOutboundCallSessionOptions({ task, callAttempt, contact, telephony, calendar, systemPrompt: 'irrelevant' });
  return { task, options };
}

describe('booking vs. hang-up race', () => {
  it('a callee hanging up while confirm_appointment writes the calendar event still ends with the task confirmed', async () => {
    const { calendar, finishWrite } = calendarWithPendingWrite();
    const { task, options } = await startNegotiatingCall(calendar);

    const confirming = confirmAppointmentTool.handler(
      { confirmedStart: '2026-09-15T14:00:00', durationMinutes: 30 },
      await options.buildToolContext(Date.now()),
    );
    await vi.waitFor(() => expect(calendar.createEventIdempotent).toHaveBeenCalled());

    // The callee hangs up mid-write: the end-of-call path fails the still-in-progress task first.
    await options.onStatusChange({ kind: 'ended', reason: 'callee hung up' });
    expect((await service.getTask(task.id))?.status).toBe('failed');

    finishWrite();
    await expect(confirming).resolves.toMatchObject({ ok: true });
    expect(await service.getTask(task.id)).toMatchObject({
      status: 'confirmed',
      calendarEventId: 'evt-race',
      outcome: { kind: 'confirmed', durationMinutes: 30 },
    });
  });

  it('once confirmed, a later call end or conversation outcome leaves the booking untouched', async () => {
    const { calendar, finishWrite } = calendarWithPendingWrite();
    const { task, options } = await startNegotiatingCall(calendar);
    const confirming = confirmAppointmentTool.handler(
      { confirmedStart: '2026-09-15T14:00:00', durationMinutes: 30 },
      await options.buildToolContext(Date.now()),
    );
    await vi.waitFor(() => expect(calendar.createEventIdempotent).toHaveBeenCalled());
    finishWrite();
    await confirming;

    await options.onStatusChange({ kind: 'ended', reason: 'callee hung up' });
    await service.transitionTask(task.id, 'conversation_completed', { outcome: { kind: 'conversation_completed', summary: 'late' } });
    await service.transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason: 'late' } });

    expect(await service.getTask(task.id)).toMatchObject({ status: 'confirmed', outcome: { kind: 'confirmed' } });
  });
});

describe('cancelPendingTask', () => {
  it('cancels a task that has not started, and leaves one already on a call alone', async () => {
    const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230001' }).returning();
    const scheduled = await service.createTask({
      contactId: contact.id,
      channel: 'phone',
      goalDescription: 'Call later',
      constraints: {},
      scheduledFor: new Date('2099-01-01T14:00:00.000Z'),
    });
    const live = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Call now', constraints: {} });
    await service.transitionTask(live.id, 'calling');

    expect((await service.cancelPendingTask(scheduled.id))?.status).toBe('cancelled');
    expect((await service.cancelPendingTask(live.id))?.status).toBe('calling');
    expect(await service.cancelPendingTask('00000000-0000-0000-0000-000000000000')).toBeUndefined();

    // A cancelled task is terminal: the orchestrator's first transition can't revive it.
    expect((await service.transitionTask(scheduled.id, 'checking_availability')).status).toBe('cancelled');
    expect((await service.listNonTerminalTasks()).map((t) => t.id)).toEqual([live.id]);
  });
});
