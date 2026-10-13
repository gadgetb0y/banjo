/**
 * The testable half of `npm run test:call`: turning its options into
 * place_call input. The call itself is placed by scripts/manual-test-call.ts.
 */
import type { z } from 'zod';
import { parseScheduledFor, placeCallInputSchema } from '../../src/mcp/tools/placeCall.js';

export type ManualCallInput = Omit<z.infer<typeof placeCallInputSchema>, 'contactId'>;

/** The script's options, as parseArgs gives them. */
export interface ManualCallArgs {
  mode?: string;
  goal?: string;
  question?: string[];
  notes?: string;
  duration?: string;
  windowDays?: string;
  at?: string;
}

/** A bad option: the script prints the message and exits, before any contact is made or call placed. */
export class ManualCallInputError extends Error {}

/**
 * end_call is the correct fit for "just a connectivity test, nothing to
 * book": it ends the call without mislabeling the task as an escalation
 * (which needlessly flags it for Steve's attention). Only a tool handler can
 * call TelephonyProvider.hangUp(), the model itself has no way to end a call
 * unprompted, so the goal must explicitly name a tool for the model to reach a
 * clean ending at all.
 */
const DEFAULT_GOAL =
  "This is a manual scaffold test call — please mention it's a test, confirm you can hear the caller, then call end_call to end the call. Do not attempt a real booking.";
/** An ask call has its own ending, so its default goal names no tool. */
const DEFAULT_ASK_GOAL = "This is a manual test call: mention it's a test, then find out the answers to the questions.";

/**
 * Checked with place_call's own schema, so a question the MCP tool would
 * refuse (too many, too long, more than one line) is refused here too, and
 * with the same rules placeCallHandler adds on top. An ask call books
 * nothing, so it gets no duration or date window, only any notes.
 */
export function buildPlaceCallInput(args: ManualCallArgs, now = new Date()): ManualCallInput {
  const mode = args.mode ?? 'booking';
  if (mode !== 'booking' && mode !== 'conversation' && mode !== 'ask') {
    throw new ManualCallInputError(`--mode must be "booking", "conversation" or "ask" (got "${mode}").`);
  }
  if (mode !== 'ask' && args.question) throw new ManualCallInputError('--question is only for --mode ask.');
  if (mode === 'ask' && !args.question?.length) {
    throw new ManualCallInputError('--mode ask needs at least one --question: what should Banjo find out?');
  }

  const notes = args.notes || undefined;
  let constraints: ManualCallInput['constraints'];
  if (mode === 'ask') {
    constraints = notes ? { notes } : undefined;
  } else {
    const windowDays = Number.parseInt(args.windowDays ?? '3', 10);
    // The offerable window starts when the call does, not when this script ran:
    // for a call scheduled days out, "the next N days from now" is already over.
    const windowStart = args.at ? new Date(Math.max(now.getTime(), parseScheduledFor(args.at).getTime())) : now;
    const windowEnd = new Date(windowStart.getTime() + windowDays * 24 * 60 * 60 * 1000);
    constraints = {
      durationMinutes: Number.parseInt(args.duration ?? '15', 10),
      dateWindows: [{ start: windowStart.toISOString(), end: windowEnd.toISOString() }],
      ...(notes ? { notes } : {}),
    };
  }

  const parsed = placeCallInputSchema.omit({ contactId: true }).safeParse({
    taskDescription: args.goal ?? (mode === 'ask' ? DEFAULT_ASK_GOAL : DEFAULT_GOAL),
    mode,
    questions: mode === 'ask' ? args.question : undefined,
    ...(args.at ? { scheduledFor: args.at } : {}),
    constraints,
  });
  if (!parsed.success) {
    throw new ManualCallInputError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
  }
  return parsed.data;
}
