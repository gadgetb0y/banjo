import { z } from 'zod';
import { config } from '../../config/index.js';
import { zonedTimeToUtcIso } from '../../lib/timezone.js';
import { createTask } from '../../tasks/service.js';
import { triggerOrchestration } from '../../tasks/orchestrator.js';
import type { TaskConstraints } from '../../tasks/schema.js';

const timeWindowSchema = z.object({
  start: z.string().describe('ISO 8601 datetime marking the start of an acceptable window, e.g. "2026-08-03T15:00:00-07:00".'),
  end: z.string().describe('ISO 8601 datetime marking the end of an acceptable window.'),
});

export const placeCallInputSchema = z.object({
  contactId: z.string().uuid().describe('Id of the contact to call — resolve this first via find_contact.'),
  taskDescription: z
    .string()
    .min(1)
    .describe('What to accomplish on the call, e.g. "Book a haircut, any day next week after 3pm."'),
  mode: z
    .enum(['booking', 'conversation'])
    .optional()
    .describe(
      "'booking' (default) negotiates a specific outcome — a time, a voicemail, an escalation. " +
        "'conversation' is for calls with no booking/negotiation goal — deliver a message, discuss something, " +
        "react to what's said — ending naturally rather than at a specific negotiated outcome.",
    ),
  scheduledFor: z
    .string()
    .optional()
    .describe(
      `Place the call no earlier than this time instead of right away, as a local date-time WITHOUT a UTC offset ` +
        `(e.g. "2026-09-14T09:00:00"), interpreted in ${config.CALENDAR_TIMEZONE}. Omit to call immediately. ` +
        `The task stays "pending" until then; a time already in the past calls immediately.`,
    ),
  constraints: z
    .object({
      dateWindows: z
        .array(timeWindowSchema)
        .optional()
        .describe('Acceptable date/time windows to offer/accept during negotiation.'),
      durationMinutes: z.number().int().positive().optional().describe('Expected appointment duration, in minutes.'),
      notes: z.string().optional().describe('Any other free-text guidance for the call (preferences, context, etc).'),
    })
    .optional()
    .describe('Constraints guiding what times/details are acceptable. Omit if unconstrained.'),
});

export interface PlaceCallResult {
  taskId: string;
  ackMessage: string;
}

/**
 * Interpreted in CALENDAR_TIMEZONE, never the server's own zone — the same
 * rule as every other call-facing time (see src/lib/timezone.ts's
 * zonedTimeToUtcIso for the booking that once landed 4 hours off).
 */
function parseScheduledFor(value: string): Date {
  let parsed: Date;
  try {
    parsed = new Date(zonedTimeToUtcIso(value, config.CALENDAR_TIMEZONE));
  } catch (err) {
    throw new Error(`Could not parse scheduledFor "${value}" as a date-time (${err instanceof Error ? err.message : String(err)})`);
  }
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not parse scheduledFor "${value}" as a date-time`);
  }
  return parsed;
}

function formatInCalendarTimezone(date: Date): string {
  return date.toLocaleString('en-US', { timeZone: config.CALENDAR_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Creates the Task row and hands off to async call orchestration WITHOUT
 * awaiting it — a phone call can run for minutes, far longer than an MCP
 * tool call should block. The caller (the schedule-appointment skill) is
 * expected to poll get_task_status for the eventual outcome. With a future
 * scheduledFor, nothing is triggered now: the orchestration poller starts the
 * call once it's due.
 */
export async function placeCallHandler(input: z.infer<typeof placeCallInputSchema>): Promise<PlaceCallResult> {
  const constraints: TaskConstraints = input.constraints ?? {};
  const scheduledFor = input.scheduledFor ? parseScheduledFor(input.scheduledFor) : undefined;

  const task = await createTask({
    contactId: input.contactId,
    channel: 'phone',
    goalDescription: input.taskDescription,
    constraints,
    mode: input.mode,
    scheduledFor,
  });

  if (scheduledFor && scheduledFor.getTime() > Date.now()) {
    return {
      taskId: task.id,
      ackMessage: `Scheduled a call about "${input.taskDescription}" for ${formatInCalendarTimezone(scheduledFor)} (${config.CALENDAR_TIMEZONE}). I'll let you know how it goes.`,
    };
  }

  // Fire-and-forget. Deliberately not awaited — see module comment above.
  triggerOrchestration(task.id);

  return {
    taskId: task.id,
    ackMessage: `Started calling about "${input.taskDescription}". I'll let you know how it goes.`,
  };
}
