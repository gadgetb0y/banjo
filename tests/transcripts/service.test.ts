import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// DB-backed (banjo_test — see vitest.config.ts).
let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let inboundCalls: any;
let callTranscriptTurns: any;
let service: typeof import('../../src/transcripts/service.js');

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  ({ inboundCalls } = await import('../../src/inbound/schema.js'));
  ({ callTranscriptTurns } = await import('../../src/transcripts/schema.js'));
  service = await import('../../src/transcripts/service.js');
});

async function clearTables() {
  await db.delete(callTranscriptTurns);
  await db.delete(callAttempts);
  await db.delete(inboundCalls);
  await db.delete(tasks);
  await db.delete(contacts);
}
beforeEach(clearTables);
afterAll(clearTables);

async function makeAttempt(startedAt = new Date('2026-09-23T23:27:00Z')) {
  const [contact] = await db.insert(contacts).values({ displayName: 'Claudia', phoneNumber: '+15555550100' }).returning();
  const [task] = await db
    .insert(tasks)
    .values({ contactId: contact.id, channel: 'phone', goalDescription: 'Book a groom', constraints: {}, status: 'confirmed' })
    .returning();
  const [attempt] = await db.insert(callAttempts).values({ taskId: task.id, startedAt }).returning();
  return { task, attempt };
}

const turn = (seq: number, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) => ({
  seq,
  role,
  text,
  quality: 'ok' as const,
  voiceProvider: 'openai',
  spokenAt: new Date(Date.UTC(2026, 8, 23, 23, 27, seq)),
  ...extra,
});

describe('saveTranscriptTurn', () => {
  it('stores nothing while PERSIST_TRANSCRIPTS is off — the default', async () => {
    const { attempt } = await makeAttempt();
    await service.saveTranscriptTurn({ callAttemptId: attempt.id }, turn(1, 'user', 'Hello?'), false);
    expect(await db.select().from(callTranscriptTurns)).toHaveLength(0);
  });

  it('stores the line against the call attempt when on', async () => {
    const { attempt } = await makeAttempt();
    await service.saveTranscriptTurn({ callAttemptId: attempt.id }, turn(1, 'user', 'Hello?', { quality: 'suspect' }), true);
    const rows = await db.select().from(callTranscriptTurns);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ callAttemptId: attempt.id, inboundCallId: null, seq: 1, role: 'user', text: 'Hello?', quality: 'suspect', voiceProvider: 'openai' });
  });

  it('stores inbound lines against the inbound call', async () => {
    const [call] = await db.insert(inboundCalls).values({ twilioCallSid: 'CA-in-1', callerPhoneNumber: '+15555550111' }).returning();
    await service.saveTranscriptTurn({ inboundCallId: call.id }, turn(1, 'assistant', 'Hi, this is Banjo.'), true);
    const [row] = await db.select().from(callTranscriptTurns);
    expect(row).toMatchObject({ inboundCallId: call.id, callAttemptId: null });
  });

  it('the database refuses a line that belongs to no call, or to two', async () => {
    const { attempt } = await makeAttempt();
    const [call] = await db.insert(inboundCalls).values({ twilioCallSid: 'CA-in-2', callerPhoneNumber: '+15555550112' }).returning();
    await expect(db.insert(callTranscriptTurns).values({ ...turn(1, 'user', 'x') })).rejects.toThrow();
    await expect(
      db.insert(callTranscriptTurns).values({ ...turn(1, 'user', 'x'), callAttemptId: attempt.id, inboundCallId: call.id }),
    ).rejects.toThrow();
  });

  it('deleting the call deletes what was said on it', async () => {
    const { attempt } = await makeAttempt();
    await service.saveTranscriptTurn({ callAttemptId: attempt.id }, turn(1, 'user', 'Hello?'), true);
    await db.delete(callAttempts);
    expect(await db.select().from(callTranscriptTurns)).toHaveLength(0);
  });
});

describe('listTranscriptForTask', () => {
  it('returns each attempt, oldest first, with its lines in seq order', async () => {
    const { task, attempt: first } = await makeAttempt(new Date('2026-09-23T23:00:00Z'));
    const [second] = await db.insert(callAttempts).values({ taskId: task.id, startedAt: new Date('2026-09-24T00:29:00Z') }).returning();
    await service.saveTranscriptTurn({ callAttemptId: second.id }, turn(2, 'assistant', 'Hi Claudia.'), true);
    await service.saveTranscriptTurn({ callAttemptId: second.id }, turn(1, 'user', "Claudia's, how can I help?"), true);
    await service.saveTranscriptTurn({ callAttemptId: first.id }, turn(1, 'user', 'Hello?'), true);

    const result = await service.listTranscriptForTask(task.id);
    expect(result.map((a) => a.attempt.id)).toEqual([first.id, second.id]);
    expect(result[1]!.turns.map((t) => t.seq)).toEqual([1, 2]);
  });

  it('includes an attempt with no saved lines, so "no transcript" is visible rather than the attempt vanishing', async () => {
    const { task, attempt } = await makeAttempt();
    const result = await service.listTranscriptForTask(task.id);
    expect(result).toEqual([{ attempt: expect.objectContaining({ id: attempt.id }), turns: [] }]);
  });
});

describe('deleteExpiredTranscripts', () => {
  it('deletes lines older than the retention window and keeps newer ones', async () => {
    const { attempt } = await makeAttempt();
    const now = new Date('2026-10-30T12:00:00Z');
    await service.saveTranscriptTurn({ callAttemptId: attempt.id }, turn(1, 'user', 'old', { spokenAt: new Date('2026-09-29T11:00:00Z') }), true);
    await service.saveTranscriptTurn({ callAttemptId: attempt.id }, turn(2, 'user', 'new', { spokenAt: new Date('2026-09-30T13:00:00Z') }), true);

    expect(await service.deleteExpiredTranscripts(30, now)).toBe(1);
    const rows = await db.select().from(callTranscriptTurns);
    expect(rows.map((r: { text: string }) => r.text)).toEqual(['new']);
  });

  it('0 days means keep forever', async () => {
    const { attempt } = await makeAttempt();
    await service.saveTranscriptTurn({ callAttemptId: attempt.id }, turn(1, 'user', 'ancient', { spokenAt: new Date('2020-01-01T00:00:00Z') }), true);
    expect(await service.deleteExpiredTranscripts(0)).toBe(0);
    expect(await db.select().from(callTranscriptTurns)).toHaveLength(1);
  });
});
