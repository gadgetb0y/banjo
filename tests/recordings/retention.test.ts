import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// DB-backed (banjo_test — see vitest.config.ts).
let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let retention: typeof import('../../src/recordings/retention.js');

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  retention = await import('../../src/recordings/retention.js');
});

async function clearTables() {
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}
beforeEach(clearTables);
afterAll(clearTables);

async function attemptWithRecording(recordingSid: string | null, startedAt: Date) {
  const [contact] = await db.insert(contacts).values({ displayName: 'C', phoneNumber: `+1555555${Math.floor(Math.random() * 9000 + 1000)}` }).returning();
  const [task] = await db.insert(tasks).values({ contactId: contact.id, channel: 'phone', goalDescription: 'x', constraints: {}, status: 'confirmed' }).returning();
  const [attempt] = await db.insert(callAttempts).values({ taskId: task.id, startedAt, recordingSid }).returning();
  return attempt;
}

const now = new Date('2026-10-30T12:00:00Z');

describe('deleteExpiredRecordings (#8)', () => {
  it('deletes recordings older than the window from Twilio, then forgets their ids', async () => {
    const old = await attemptWithRecording('RE-old', new Date('2026-09-29T11:00:00Z'));
    const recent = await attemptWithRecording('RE-new', new Date('2026-09-30T13:00:00Z'));
    const deleteRecording = vi.fn(async () => {});

    expect(await retention.deleteExpiredRecordings(deleteRecording, 30, now)).toBe(1);
    expect(deleteRecording).toHaveBeenCalledWith('RE-old');
    const rows = await db.select().from(callAttempts);
    expect(rows.find((r: { id: string }) => r.id === old.id).recordingSid).toBeNull();
    expect(rows.find((r: { id: string }) => r.id === recent.id).recordingSid).toBe('RE-new');
  });

  it('keeps the id when Twilio refuses, so the next sweep tries again', async () => {
    await attemptWithRecording('RE-old', new Date('2026-09-01T00:00:00Z'));
    const deleteRecording = vi.fn(async () => {
      throw new Error('twilio down');
    });
    expect(await retention.deleteExpiredRecordings(deleteRecording, 30, now)).toBe(0);
    const [row] = await db.select().from(callAttempts);
    expect(row.recordingSid).toBe('RE-old');
  });

  it('0 days keeps recordings forever', async () => {
    await attemptWithRecording('RE-ancient', new Date('2020-01-01T00:00:00Z'));
    const deleteRecording = vi.fn(async () => {});
    expect(await retention.deleteExpiredRecordings(deleteRecording, 0, now)).toBe(0);
    expect(deleteRecording).not.toHaveBeenCalled();
  });
});
