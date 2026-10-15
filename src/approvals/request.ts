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

/** Invisible marks that can reorder or hide what's shown: bidi controls, zero-width characters, the BOM. */
const INVISIBLE_MARKS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Agent-written text without invisible marks, so it reads as it will be used. */
export function withoutInvisibleMarks(text: string): string {
  return text.replace(INVISIBLE_MARKS, '');
}

/** Agent-written text on one line, so it can't add lines that look like Banjo's own. */
function oneLine(text: string): string {
  return withoutInvisibleMarks(text).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

type ContactShown = Pick<Contact, 'displayName' | 'phoneNumber'> & {
  notes?: string | null;
  googleResourceName?: string | null;
  relationshipTier?: Contact['relationshipTier'];
};

/**
 * A contact synced from the owner's address book has a googleResourceName; any
 * other name was typed in, possibly by an agent (add_contact), so the owner
 * shouldn't trust "Mom" over the number.
 */
export function fromAddressBook(contact: ContactShown): boolean {
  return Boolean(contact.googleResourceName);
}

/** What a family or friend contact may hear on the call (src/tasks/promptBuilder.ts's profileSharingRule), or undefined. */
export function tierNote(contact: ContactShown): string | undefined {
  if (contact.relationshipTier !== 'family' && contact.relationshipTier !== 'friend') return undefined;
  return `Tagged ${contact.relationshipTier}: on this call Banjo may answer their questions about you from your profile.`;
}

/**
 * The owner's approval request. The link and the deadline come before
 * anything the agent wrote: Pushover and SMS clip a long message, and the
 * link has to survive that. Nothing an agent could have written (the contact's
 * name included) comes before them. Everything after them that an agent could have
 * written is on its own labelled single line, so it can't pose as Banjo's
 * lines (a second "Approve by" with another link). It says whether the name
 * came from the owner's address book and what a family or friend contact may
 * hear about the owner. It includes the notes that
 * go into the call's prompt; the page (./routes.ts) shows the rest.
 */
export function buildApprovalMessage({
  contact,
  task,
}: {
  contact: ContactShown;
  task: Pick<Task, 'id' | 'goalDescription' | 'mode' | 'questions' | 'scheduledFor' | 'approvalExpiresAt'> & {
    constraints?: Task['constraints'];
  };
}): string {
  const expiresAt = task.approvalExpiresAt!;
  const when = task.scheduledFor && task.scheduledFor.getTime() > Date.now() ? `at ${formatLocal(task.scheduledFor)}` : 'now';
  const callNotes = oneLine(task.constraints?.notes ?? '');
  const contactNotes = oneLine(contact.notes ?? '');
  return [
    `An agent asked Banjo to call ${contact.phoneNumber} ${when}.`,
    `Approve by ${formatLocal(expiresAt)}, or it won't be placed: ${approvalUrl(task.id, expiresAt)}`,
    '',
    // The name is agent-writable too (add_contact), so it comes after the link.
    // Labelled both ways, and before the name: the label after an agent-written name could be imitated.
    `Contact name, ${fromAddressBook(contact) ? 'from your address book' : 'typed in (not from your address book)'}: ${oneLine(contact.displayName)}`,
    ...(tierNote(contact) ? [tierNote(contact)!] : []),
    `The agent wrote (${task.mode} call): ${oneLine(task.goalDescription)}`,
    ...(task.questions?.length ? ['Questions from the agent:', ...task.questions.map((q, i) => `${i + 1}. ${oneLine(q)}`)] : []),
    ...(callNotes ? [`Notes for the call, from the agent: ${callNotes}`] : []),
    ...(contactNotes ? [`Notes on this contact: ${contactNotes}`] : []),
  ].join('\n');
}
