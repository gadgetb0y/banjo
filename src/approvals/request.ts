import { config } from '../config/index.js';
import type { Contact } from '../contacts/schema.js';
import type { Task } from '../tasks/schema.js';
import { approvalUrl } from './link.js';

/** How long the owner has to approve a call an agent asked for. Unapproved by then, it's cancelled. */
export const APPROVAL_WINDOW_MS = 30 * 60_000;

/** Agent requests that may wait for approval at once, so a looping or steered agent can't flood the owner's phone. */
export const MAX_WAITING_APPROVALS = 3;

export function formatLocal(date: Date): string {
  return date.toLocaleString('en-US', { timeZone: config.CALENDAR_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The owner's approval request. The link and the deadline come before
 * anything the agent wrote: Pushover and SMS clip a long message, and the
 * link has to survive that. It includes the notes that go into the call's
 * prompt; the page (./routes.ts) shows the rest of what the call will use.
 */
export function buildApprovalMessage({
  contact,
  task,
}: {
  contact: Pick<Contact, 'displayName' | 'phoneNumber'> & { notes?: string | null };
  task: Pick<Task, 'id' | 'goalDescription' | 'mode' | 'questions' | 'scheduledFor' | 'approvalExpiresAt'> & {
    constraints?: Task['constraints'];
  };
}): string {
  const expiresAt = task.approvalExpiresAt!;
  const when = task.scheduledFor && task.scheduledFor.getTime() > Date.now() ? `at ${formatLocal(task.scheduledFor)}` : 'now';
  return [
    `An agent asked Banjo to call ${contact.displayName} (${contact.phoneNumber}) ${when}.`,
    `Approve by ${formatLocal(expiresAt)}, or it won't be placed: ${approvalUrl(task.id, expiresAt)}`,
    '',
    `Task (${task.mode}): ${task.goalDescription}`,
    ...(task.questions?.length ? ['Questions:', ...task.questions.map((q, i) => `${i + 1}. ${q}`)] : []),
    ...(task.constraints?.notes?.trim() ? [`Notes for the call: ${task.constraints.notes.trim()}`] : []),
    ...(contact.notes?.trim() ? [`Notes on this contact: ${contact.notes.trim()}`] : []),
  ].join('\n');
}
