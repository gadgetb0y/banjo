import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  callAttempts,
  tasks,
  type CallAttempt,
  type Task,
  type TaskConstraints,
  type TaskOutcome,
  type TimeWindow,
} from './schema.js';

/**
 * The only module that writes Task.status/outcome — keeps orchestration code
 * from racing on updatedAt, and gives us one place to log every transition.
 */

export async function createTask(input: {
  contactId: string;
  channel: 'phone' | 'online';
  goalDescription: string;
  constraints: TaskConstraints;
  mode?: 'booking' | 'conversation';
  /** Phone path: place the call no earlier than this instant. Omit to call as soon as possible. */
  scheduledFor?: Date;
}): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({
      contactId: input.contactId,
      channel: input.channel,
      goalDescription: input.goalDescription,
      constraints: input.constraints,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    })
    .returning();
  if (!row) throw new Error('Failed to insert task');
  return row;
}

export async function getTask(id: string): Promise<Task | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}

export async function transitionTask(
  id: string,
  status: Task['status'],
  patch?: Partial<{
    candidateWindows: TimeWindow[];
    outcome: TaskOutcome;
    calendarEventId: string;
  }>,
): Promise<Task> {
  const [row] = await db
    .update(tasks)
    .set({ status, ...patch, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new Error(`Task not found: ${id}`);
  return row;
}

/** Used by the schedule-appointment skill to log a synchronous online-booking outcome. */
export async function recordTaskOutcome(input: {
  contactId: string;
  goalDescription: string;
  outcome: TaskOutcome;
  calendarEventId?: string;
}): Promise<Task> {
  const status: Task['status'] = input.outcome.kind;
  const [row] = await db
    .insert(tasks)
    .values({
      contactId: input.contactId,
      channel: 'online',
      goalDescription: input.goalDescription,
      constraints: {},
      status,
      outcome: input.outcome,
      calendarEventId: input.calendarEventId,
    })
    .returning();
  if (!row) throw new Error('Failed to insert task outcome');
  return row;
}

export async function listRecentTasks(limit = 20): Promise<Task[]> {
  return db.select().from(tasks).orderBy(desc(tasks.updatedAt)).limit(limit);
}

/** Non-terminal statuses the orchestration poller should pick up (see src/tasks/orchestrator.ts). */
export const NON_TERMINAL_STATUSES: Task['status'][] = ['pending', 'checking_availability', 'calling', 'negotiating'];

export async function listNonTerminalTasks(): Promise<Task[]> {
  const all = await db.select().from(tasks);
  return all.filter((t) => NON_TERMINAL_STATUSES.includes(t.status));
}

/**
 * Whether a task's scheduled time (place_call's scheduledFor), if any, has
 * arrived. Checked by both the in-process trigger and the orchestration
 * poller, so a scheduled call starts on the first poller tick at or after its
 * time — within POLL_INTERVAL_MS (src/tasks/orchestrator.ts) of it.
 */
export function isTaskDue(task: Pick<Task, 'scheduledFor'>, now: Date = new Date()): boolean {
  return !task.scheduledFor || task.scheduledFor.getTime() <= now.getTime();
}

// --- Call attempts (phone path only) ---

export async function createCallAttempt(taskId: string): Promise<CallAttempt> {
  const [row] = await db.insert(callAttempts).values({ taskId }).returning();
  if (!row) throw new Error('Failed to insert call attempt');
  return row;
}

export async function updateCallAttempt(
  id: string,
  patch: Partial<Pick<CallAttempt, 'status' | 'providerCallId' | 'answeredBy' | 'endedAt' | 'errorDetail'>>,
): Promise<CallAttempt> {
  const [row] = await db.update(callAttempts).set(patch).where(eq(callAttempts.id, id)).returning();
  if (!row) throw new Error(`Call attempt not found: ${id}`);
  return row;
}
