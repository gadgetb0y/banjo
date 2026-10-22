import { config } from '../config/index.js';
import type { Contact } from '../contacts/schema.js';
import type { Task } from './schema.js';
import { callsPlacedToContactSince, dueQueuedCallsForContact, withContactAdvisoryLock } from './service.js';

/**
 * The per-number call cap: at most MAX_CALLS_PER_NUMBER_PER_DAY outbound calls
 * to one phone number in any rolling 24 hours. Checked twice: by place_call
 * when a call is requested (mcp/tools/placeCall.ts), and by the orchestrator
 * right before it dials (./orchestrator.ts), so a call scheduled earlier can't
 * slip past it. Each call is an AI calling a real person, and five in one
 * evening to one friend is how this came about. The owner can let a test call
 * to themselves or family go past it, up to OVERRIDE_CAP_MULTIPLIER times it
 * (place_call's overrideCallCap, owner key only). A support line the operator
 * lists in CALL_CAP_BUSINESS_NUMBERS gets CALL_CAP_BUSINESS_MAX instead: an IVR
 * that took more than three tries to get through is how that came about.
 * Nothing else goes past the cap.
 *
 * A call counts once it's dialed, whether or not it connected: a busy line,
 * a call nobody answered and a call Twilio failed all count (#79). Each still
 * rang, or tried to ring, someone's phone.
 */
export const CALL_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CallCapResult {
  allowed: boolean;
  /** Calls placed to this number in the last 24 hours. */
  placed: number;
  /** Calls due and about to dial, not yet placed — counted only with includeQueued. */
  queued: number;
  /**
   * When refused: when enough placed calls have left the window for one more
   * to fit. Undefined when queued calls alone fill the cap — they haven't
   * started, so there's no time to count from.
   */
  nextAllowedAt?: Date;
  /** The most calls this check allowed in 24 hours: the cap, or the override's ceiling. */
  limit: number;
}

/** How far the owner's override can raise the cap: no further, whatever is asked. */
export const OVERRIDE_CAP_MULTIPLIER = 2;

/**
 * The limit a task's call is checked against: CALL_CAP_BUSINESS_MAX for a
 * support line the operator listed in CALL_CAP_BUSINESS_NUMBERS, otherwise the
 * cap, or twice it if the owner overrode it. The list is .env-only, so a call
 * or an MCP client can't make a number a business line.
 */
export function callCapLimit(task: Pick<Task, 'callCapOverride'>, contact: Pick<Contact, 'phoneNumber'>): number {
  if (config.CALL_CAP_BUSINESS_NUMBERS.includes(contact.phoneNumber)) return config.CALL_CAP_BUSINESS_MAX;
  return config.MAX_CALLS_PER_NUMBER_PER_DAY * (task.callCapOverride ? OVERRIDE_CAP_MULTIPLIER : 1);
}

/**
 * Who the owner may override the cap for: themselves (the number Banjo
 * transfers or texts them on) or family. Neither can be set through MCP: the
 * tier comes only from Google/CardDAV groups (#163, #170), so a call can't
 * make a business eligible.
 */
export function canOverrideCallCap(contact: Pick<Contact, 'relationshipTier' | 'phoneNumber'>): boolean {
  if (contact.relationshipTier === 'family') return true;
  const own = [config.TRANSFER_TO_PHONE_NUMBER, config.NOTIFY_TO_PHONE_NUMBER].filter(Boolean);
  return own.includes(contact.phoneNumber);
}

/**
 * `includeQueued` also counts this contact's calls that are due and about to
 * dial but haven't yet — place_call passes it, so a burst of requests can't
 * queue past the cap. The orchestrator doesn't: the task it's about to dial
 * is itself queued. `includeAwaitingApproval: false` leaves agent requests the
 * owner hasn't approved out of that count (the owner's own place_call), so an
 * agent can't use up the owner's calls to a number by asking for them.
 */
export async function checkCallCap(
  contactId: string,
  now: Date = new Date(),
  options: { includeQueued?: boolean; includeAwaitingApproval?: boolean; limit?: number } = {},
): Promise<CallCapResult> {
  const startedAts = await callsPlacedToContactSince(contactId, new Date(now.getTime() - CALL_CAP_WINDOW_MS));
  const placed = startedAts.length;
  const queued = options.includeQueued
    ? await dueQueuedCallsForContact(contactId, now, { includeAwaitingApproval: options.includeAwaitingApproval ?? true })
    : 0;
  const cap = options.limit ?? config.MAX_CALLS_PER_NUMBER_PER_DAY;
  if (placed + queued < cap) return { allowed: true, placed, queued, limit: cap };
  // One more call fits once placed + queued - (calls that left) < cap, i.e.
  // after the k-th oldest placed call leaves the window. More than `cap` can be
  // counted (the cap was lowered, or calls queued before it existed).
  const mustLeave = placed + queued - cap + 1;
  const kthOldest = startedAts[mustLeave - 1];
  const nextAllowedAt = kthOldest ? new Date(kthOldest.getTime() + CALL_CAP_WINDOW_MS) : undefined;
  return { allowed: false, placed, queued, nextAllowedAt, limit: cap };
}

const dialLocks = new Map<string, Promise<unknown>>();

/**
 * How many contacts' locked dial sections may run at once in this process.
 * Each holds one pooled connection in an open transaction (the advisory lock)
 * while its work needs another; with the pool's default of 10, ten at once
 * would leave the work nothing to run on and hang every query in the process.
 */
const MAX_CONCURRENT_DIAL_SECTIONS = 4;
let dialSectionsRunning = 0;
const dialSectionWaiters: Array<() => void> = [];

async function withDialSectionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (dialSectionsRunning >= MAX_CONCURRENT_DIAL_SECTIONS) {
    await new Promise<void>((resolve) => dialSectionWaiters.push(resolve));
  } else {
    dialSectionsRunning += 1;
  }
  try {
    return await work();
  } finally {
    // Hand the slot straight to the next waiter, or give it back.
    const next = dialSectionWaiters.shift();
    if (next) next();
    else dialSectionsRunning -= 1;
  }
}

/**
 * Runs `work` with no other dial to the same contact in progress, so two due
 * tasks can't both pass the cap check before either has recorded its call
 * attempt. Chained in-process first, so only one database connection per
 * contact waits on the advisory lock, which covers other processes on the
 * same database.
 */
export async function withContactDialLock<T>(contactId: string, work: () => Promise<T>): Promise<T> {
  const previous = dialLocks.get(contactId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => withDialSectionSlot(() => withContactAdvisoryLock(contactId, work)));
  const settled = run.catch(() => {});
  dialLocks.set(contactId, settled);
  try {
    return await run;
  } finally {
    if (dialLocks.get(contactId) === settled) dialLocks.delete(contactId);
  }
}

/** The refusal, worded for whoever reads it: place_call's error, or a failed task's outcome reason. */
export function describeCallCapRefusal(result: CallCapResult): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const counted = `${plural(result.placed, 'call')} placed in the last 24 hours${result.queued ? ` and ${result.queued} more queued` : ''}`;
  const next = result.nextAllowedAt
    ? ` Next call allowed after ${result.nextAllowedAt.toLocaleString('en-US', { timeZone: config.CALENDAR_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' })} (${config.CALENDAR_TIMEZONE}).`
    : ' The next call is allowed once the queued calls have gone out and 24 hours have passed since them.';
  return `Call limit reached for this number: ${counted} (max ${result.limit} per 24 hours).${next}`;
}
