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

/** Agent-written text on one line, so it can't add lines that look like Banjo's own. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The owner's approval request. The link and the deadline come before
 * anything the agent wrote: Pushover and SMS clip a long message, and the
 * link has to survive that. Everything after them that an agent could have
 * written is on its own labelled single line, so it can't pose as Banjo's
 * lines (a second "Approve by" with another link). It includes the notes that
 * go into the call's prompt; the page (./routes.ts) shows the rest.
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
  const callNotes = oneLine(task.constraints?.notes ?? '');
  const contactNotes = oneLine(contact.notes ?? '');
  return [
    `An agent asked Banjo to call ${oneLine(contact.displayName)} (${contact.phoneNumber}) ${when}.`,
    `Approve by ${formatLocal(expiresAt)}, or it won't be placed: ${approvalUrl(task.id, expiresAt)}`,
    '',
    `The agent wrote (${task.mode} call): ${oneLine(task.goalDescription)}`,
    ...(task.questions?.length ? ['Questions from the agent:', ...task.questions.map((q, i) => `${i + 1}. ${oneLine(q)}`)] : []),
    ...(callNotes ? [`Notes for the call, from the agent: ${callNotes}`] : []),
    ...(contactNotes ? [`Notes on this contact: ${contactNotes}`] : []),
  ].join('\n');
}
