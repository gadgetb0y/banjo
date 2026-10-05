import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../src/contacts/schema.js';
import type { Task } from '../../src/tasks/schema.js';

// notifyTaskOutcome is where a finished call fans out: the owner's
// notification and, if configured, the task webhook (docs/ROADMAP.md, 4.4).
// Stubbed at the module boundaries it calls through.
const { getTask, getContact, notify, sendTaskWebhook } = vi.hoisted(() => ({
  getTask: vi.fn(async () => undefined as Task | undefined),
  getContact: vi.fn(async () => undefined as Contact | undefined),
  notify: vi.fn(async () => {}),
  sendTaskWebhook: vi.fn(async () => {}),
}));
vi.mock('../../src/tasks/service.js', () => ({
  getTask,
  transitionTask: vi.fn(),
  updateCallAttempt: vi.fn(),
  isTerminalStatus: (status: string) => !['pending', 'checking_availability', 'calling', 'negotiating'].includes(status),
}));
vi.mock('../../src/contacts/service.js', () => ({ getContact }));
vi.mock('../../src/notifications/owner.js', () => ({ createNotificationChannel: () => ({ notify }) }));
vi.mock('../../src/notifications/webhook.js', () => ({ sendTaskWebhook }));

const { notifyTaskOutcome } = await import('../../src/tasks/callSessionAdapter.js');

const finished = {
  id: 'task-1',
  contactId: 'contact-1',
  status: 'confirmed',
  outcome: { kind: 'confirmed', start: '2026-10-09T18:00:00.000Z', durationMinutes: 30 },
  updatedAt: new Date('2026-10-05T20:00:00.000Z'),
} as Task;
const contact = { id: 'contact-1', displayName: "Luigi's", phoneNumber: '+15555550100' } as Contact;

beforeEach(() => {
  vi.clearAllMocks();
  getTask.mockResolvedValue(finished);
  getContact.mockResolvedValue(contact);
});

describe('notifyTaskOutcome', () => {
  it('sends the task webhook with the outcome, the owner summary as text, and no phone number', async () => {
    await notifyTaskOutcome('task-1', 'disclosed');

    expect(sendTaskWebhook).toHaveBeenCalledTimes(1);
    const [event] = sendTaskWebhook.mock.calls[0]! as unknown as [Record<string, unknown>];
    const [, , summary] = notify.mock.calls[0]! as unknown as [string, unknown, string];
    expect(event).toEqual({
      event: 'task.finished',
      taskId: 'task-1',
      status: 'confirmed',
      outcome: finished.outcome,
      contact: { id: 'contact-1', name: "Luigi's" },
      text: summary,
      finishedAt: '2026-10-05T20:00:00.000Z',
    });
    expect(JSON.stringify(event)).not.toContain('5555550100');
  });

  it('still notifies the owner when the webhook rejects', async () => {
    sendTaskWebhook.mockRejectedValueOnce(new Error('should never throw, but if it did'));

    await expect(notifyTaskOutcome('task-1')).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('sends neither for a task that has not finished', async () => {
    getTask.mockResolvedValue({ ...finished, status: 'negotiating' } as Task);

    await notifyTaskOutcome('task-1');

    expect(notify).not.toHaveBeenCalled();
    expect(sendTaskWebhook).not.toHaveBeenCalled();
  });
});
