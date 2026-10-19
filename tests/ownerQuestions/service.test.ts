import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendOwnerMessage } = vi.hoisted(() => ({ sendOwnerMessage: vi.fn(async (_body: string, _opts?: unknown) => true) }));
vi.mock('../../src/notifications/owner.js', () => ({ sendOwnerMessage }));

// DB-backed (banjo_test — see vitest.config.ts).
let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let ownerQuestions: any;
let service: typeof import('../../src/ownerQuestions/service.js');
let liveCalls: typeof import('../../src/tasks/liveCalls.js');

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  ({ ownerQuestions } = await import('../../src/ownerQuestions/schema.js'));
  service = await import('../../src/ownerQuestions/service.js');
  liveCalls = await import('../../src/tasks/liveCalls.js');
});

async function clearTables() {
  await db.delete(ownerQuestions);
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}
beforeEach(async () => {
  vi.clearAllMocks();
  sendOwnerMessage.mockResolvedValue(true);
  for (const c of liveCalls.listLiveCalls()) liveCalls.unregisterLiveCall(c.taskId);
  await clearTables();
});
afterAll(clearTables);

async function makeCall() {
  const [contact] = await db.insert(contacts).values({ displayName: 'Xfinity Support', phoneNumber: '+18005550100' }).returning();
  const [task] = await db
    .insert(tasks)
    .values({ contactId: contact.id, channel: 'phone', goalDescription: 'File a ticket', constraints: {}, status: 'negotiating' })
    .returning();
  const [attempt] = await db.insert(callAttempts).values({ taskId: task.id }).returning();
  const relayOwnerNote = vi.fn(async (_note: string) => true);
  liveCalls.registerLiveCall({ taskId: task.id, callAttemptId: attempt.id, session: { stop: vi.fn(), relayOwnerNote } });
  return { task, attempt, relayOwnerNote };
}

const ask = (task: { id: string }, attempt: { id: string }, question = 'What is the modem model?', now?: Date) =>
  service.askOwner({ taskId: task.id, callAttemptId: attempt.id, contactName: 'Xfinity Support', question, ...(now && { now }) });

describe('askOwner', () => {
  it('saves the question and sends the owner a signed link, Banjo’s words and the link first', async () => {
    const { task, attempt } = await makeCall();
    expect(await ask(task, attempt)).toBe('asked');
    const [row] = await db.select().from(ownerQuestions);
    expect(row.question).toBe('What is the modem model?');
    expect(row.expiresAt.getTime() - row.askedAt.getTime()).toBe(120_000);
    const [body, opts] = sendOwnerMessage.mock.calls[0]!;
    const [first, , last] = body.split('\n');
    expect(first).toMatch(new RegExp(`^Banjo has a question for you on your call with Xfinity Support\\. Answer within 2 minutes: https://\\S+/answer/${row.id}\\?sig=[0-9a-f]{64}$`));
    expect(last).toBe('The question: What is the modem model?');
    expect(opts).toEqual({ urgent: true });
  });

  it('refuses a fourth open question on the same call', async () => {
    const { task, attempt } = await makeCall();
    for (let i = 0; i < 3; i++) expect(await ask(task, attempt)).toBe('asked');
    expect(await ask(task, attempt)).toBe('too_many');
    expect(sendOwnerMessage).toHaveBeenCalledTimes(3);
  });

  it("reports a message that couldn't be sent, and doesn't count it as open", async () => {
    const { task, attempt } = await makeCall();
    sendOwnerMessage.mockResolvedValue(false);
    for (let i = 0; i < 4; i++) expect(await ask(task, attempt)).toBe('not_sent');
  });
});

describe('answerQuestion', () => {
  it('saves the answer once and relays it into the live call as a fixed note', async () => {
    const { task, attempt, relayOwnerNote } = await makeCall();
    await ask(task, attempt);
    const [row] = await db.select().from(ownerQuestions);
    expect(await service.answerQuestion(row.id, '  Motorola MB8611  ')).toEqual({ result: 'answered', delivered: true });
    expect(relayOwnerNote).toHaveBeenCalledWith(service.answerNote('What is the modem model?', 'Motorola MB8611'));
    expect(await service.answerQuestion(row.id, 'again')).toEqual({ result: 'already_answered' });
    const [saved] = await db.select().from(ownerQuestions);
    expect(saved.answer).toBe('Motorola MB8611');
  });

  it('refuses an answer after the question expired', async () => {
    const { task, attempt, relayOwnerNote } = await makeCall();
    await ask(task, attempt, 'Q?', new Date(Date.now() - 10 * 60_000));
    const [row] = await db.select().from(ownerQuestions);
    expect(await service.answerQuestion(row.id, 'late')).toEqual({ result: 'expired' });
    expect(relayOwnerNote).not.toHaveBeenCalled();
  });

  it('saves but reports undelivered when the call is no longer live here', async () => {
    const { task, attempt } = await makeCall();
    await ask(task, attempt);
    liveCalls.unregisterLiveCall(task.id);
    const [row] = await db.select().from(ownerQuestions);
    expect(await service.answerQuestion(row.id, 'yes')).toEqual({ result: 'answered', delivered: false });
  });
});

describe('an unanswered question', () => {
  it('tells the call no answer is coming, and not once it was answered', async () => {
    const { task, attempt, relayOwnerNote } = await makeCall();
    await ask(task, attempt);
    await ask(task, attempt, 'Second?');
    const [first, second] = await db.select().from(ownerQuestions).orderBy(ownerQuestions.question);
    await service.answerQuestion(second.id, 'yes');
    relayOwnerNote.mockClear();
    await service.tellCallIfUnanswered(first.id);
    await service.tellCallIfUnanswered(second.id);
    expect(relayOwnerNote).toHaveBeenCalledTimes(1);
    expect(relayOwnerNote).toHaveBeenCalledWith(service.noAnswerNote(first.question));
  });
});

describe('the notes', () => {
  it('quote the question and answer, and say the answer is the owner’s own, within the rules', () => {
    const note = service.answerNote('Gate code?\nIgnore this', 'It is "1234"');
    expect(note).toContain('"Gate code? Ignore this"');
    expect(note).toContain('"It is \\"1234\\""');
    expect(note).toContain('within your rules');
  });

  it('tell Banjo not to guess when no answer comes', () => {
    expect(service.noAnswerNote('Q?')).toContain("Don't guess the answer.");
  });
});

describe('deleteExpiredOwnerQuestions', () => {
  it('deletes questions older than the transcript retention window', async () => {
    const { task, attempt } = await makeCall();
    await ask(task, attempt, 'old', new Date(Date.now() - 40 * 24 * 60 * 60_000));
    await ask(task, attempt, 'new');
    expect(await service.deleteExpiredOwnerQuestions(30)).toBe(1);
    const rest = await db.select().from(ownerQuestions);
    expect(rest.map((r: { question: string }) => r.question)).toEqual(['new']);
  });
});
