import { eq } from 'drizzle-orm';
import { overrideCalendarProvider } from '../calendar/factory.js';
import { config } from '../config/index.js';
import { addContact } from '../contacts/service.js';
import type { NewContact } from '../contacts/schema.js';
import { db } from '../db/index.js';
import { placeCallHandler, placeCallInputSchema } from '../mcp/tools/placeCall.js';
import { overrideTelephonyProvider } from '../telephony/factory.js';
import type { LoopInResult } from '../telephony/providers/types.js';
import { callAttempts, type Task } from '../tasks/schema.js';
import { getTask, isTerminalStatus } from '../tasks/service.js';
import { overrideVoiceAIProvider } from '../voice/factory.js';
import type { VoiceAIProvider } from '../voice/types.js';
import { SIM_BUSINESS_NUMBER } from './env.js';
import { SimCalendarProvider } from './simCalendar.js';
import { SimTelephonyProvider } from './simTelephony.js';
import { modeRules } from '../tasks/modes.js';

/** A voice session the other party types into: OpenAIRealtimeProvider in text-only mode, or a test's fake. */
export interface TextVoiceAIProvider extends VoiceAIProvider {
  sendUserText(text: string): void;
}

export interface SimCallOptions {
  business: string;
  category: NonNullable<NewContact['category']>;
  goal: string;
  mode: 'booking' | 'conversation' | 'ask';
  /** mode 'ask' only (#148): what Banjo should find out. */
  questions?: string[];
  /** Booking and conversation only: an 'ask' call books nothing, so it gets neither. */
  durationMinutes: number;
  windowDays: number;
  createVoiceAI: () => TextVoiceAIProvider;
  /** What the owner does if Banjo tries a warm transfer (#149). Defaults to accepting. */
  owner?: LoopInResult;
  /** Everything the sim shows, other than what the person types. */
  print: (line: string) => void;
}

export interface SimCall {
  taskId: string;
  telephony: SimTelephonyProvider;
  calendar: SimCalendarProvider;
  /** Resolves with the session once the call is connected and Banjo is listening; with null if the task ended without one (e.g. refused by the call cap). */
  ready: Promise<TextVoiceAIProvider | null>;
  /** Resolves once the task is terminal and its call attempt has ended. */
  finished: Promise<Task>;
}

const POLL_MS = 250;

/** The sim's options don't make a call place_call would accept. Its message is the schema's. */
export class SimInputError extends Error {
  override name = 'SimInputError';
}

/**
 * Places one simulated outbound call (ROADMAP 4.5) through the same path a
 * real one takes: the place_call MCP handler, the orchestrator, the outbound
 * CallSession adapter, the real prompt and tools, real rows in the sim
 * database. Only the phone line, the calendar and the voice transport are
 * swapped, through the factories' override seams.
 */
export async function startSimCall(opts: SimCallOptions): Promise<SimCall> {
  // Through place_call's own schema, as the MCP server does before calling the
  // handler, so the sim can't start a call place_call would refuse (#148
  // review). First, so a refusal leaves nothing behind: no contact, no overrides.
  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + opts.windowDays * 24 * 60 * 60 * 1000);
  const input = placeCallInputSchema.omit({ contactId: true }).safeParse({
    taskDescription: opts.goal,
    mode: opts.mode,
    questions: opts.questions,
    constraints:
      !modeRules({ mode: opts.mode }).books
        ? undefined
        : {
            durationMinutes: opts.durationMinutes,
            dateWindows: [{ start: windowStart.toISOString(), end: windowEnd.toISOString() }],
          },
  });
  if (!input.success) {
    throw new SimInputError(input.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
  }

  const telephony = new SimTelephonyProvider(opts.print, opts.owner);
  const calendar = new SimCalendarProvider(config.CALENDAR_TIMEZONE, opts.print);
  overrideTelephonyProvider(telephony);
  overrideCalendarProvider(calendar);

  let resolveReady!: (voice: TextVoiceAIProvider | null) => void;
  const ready = new Promise<TextVoiceAIProvider | null>((resolve) => (resolveReady = resolve));
  overrideVoiceAIProvider(() => {
    const voice = opts.createVoiceAI();
    showBanjo(voice, opts.print);
    voice.on('event', (event) => {
      if (event.type === 'connected') resolveReady(voice);
    });
    return voice;
  });

  const contact = await addContact({ displayName: opts.business, phoneNumber: SIM_BUSINESS_NUMBER, category: opts.category });
  const { taskId } = await placeCallHandler({ ...input.data, contactId: contact.id });

  const finished = waitUntilFinished(taskId);
  // A task that ends before Banjo ever connects (refused, failed to start) has no call to wait for.
  void finished.then(() => resolveReady(null));
  return { taskId, telephony, calendar, ready, finished };
}

/** Clears the overrides startSimCall set, so nothing after it gets the sim's providers. */
export function endSimOverrides(): void {
  overrideTelephonyProvider(null);
  overrideCalendarProvider(null);
  overrideVoiceAIProvider(null);
}

/** Prints Banjo's lines, and each tool call with its result, as they happen. */
function showBanjo(voice: TextVoiceAIProvider, print: (line: string) => void): void {
  voice.on('event', (event) => {
    if (event.type === 'transcript' && event.role === 'assistant' && event.isFinal && event.text.trim()) {
      print(`Banjo: ${event.text.trim().replace(/\s+/g, ' ')}`);
    } else if (event.type === 'tool_call') {
      print(`  → ${event.call.name} ${JSON.stringify(event.call.arguments)}`);
    }
  });
  const sendToolResult = voice.sendToolResult.bind(voice);
  voice.sendToolResult = (toolCallId, result, isError, options) => {
    print(`  ← ${isError ? 'error ' : ''}${JSON.stringify(result)}`);
    sendToolResult(toolCallId, result, isError, options);
  };
}

async function waitUntilFinished(taskId: string): Promise<Task> {
  for (;;) {
    const task = await getTask(taskId);
    if (!task) throw new Error(`sim: task ${taskId} disappeared`);
    if (isTerminalStatus(task.status)) {
      const attempts = await db.select({ endedAt: callAttempts.endedAt }).from(callAttempts).where(eq(callAttempts.taskId, taskId));
      if (attempts.every((attempt) => attempt.endedAt)) return task;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
