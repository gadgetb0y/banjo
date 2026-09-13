import { GoogleCalendarProvider } from '../calendar/googleCalendarProvider.js';
import { getContact } from '../contacts/service.js';
import { logger } from '../lib/logger.js';
import { CallSession } from '../session/callSession.js';
import { createTelephonyProvider } from '../telephony/factory.js';
import { buildOutboundCallSessionOptions } from './callSessionAdapter.js';
import { buildCallFrontendPrompt, buildCallSystemPrompt } from './promptBuilder.js';
import { createCallAttempt, getTask, isTaskDue, listNonTerminalTasks, transitionTask } from './service.js';
import type { TimeWindow } from './schema.js';

const calendar = new GoogleCalendarProvider();

// Tracks tasks currently being driven, so a duplicate poller tick (or a
// duplicate MCP place_call for the same task) can't kick off two orchestration
// runs for the same task concurrently.
const inFlightTaskIds = new Set<string>();

/**
 * Fire-and-forget entrypoint called by the MCP place_call tool right after
 * creating a Task row. Deliberately not awaited by the caller — a phone call
 * can run for real wall-clock minutes, and the MCP tool must return
 * immediately with an ack.
 */
export function triggerOrchestration(taskId: string): void {
  if (inFlightTaskIds.has(taskId)) return;
  inFlightTaskIds.add(taskId);
  runTask(taskId)
    .catch((err) => logger.error({ err, taskId }, 'Task orchestration failed'))
    .finally(() => inFlightTaskIds.delete(taskId));
}

async function runTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) {
    logger.warn({ taskId }, 'triggerOrchestration called for a task that does not exist');
    return;
  }
  if (task.channel !== 'phone') {
    // Online-path tasks are handled entirely by the schedule-appointment
    // skill and logged via record_task_outcome — nothing for the backend to
    // drive here.
    return;
  }
  if (!isTaskDue(task)) {
    // Scheduled for later (place_call's scheduledFor). Left 'pending' — the
    // poller below starts it once it's due.
    return;
  }

  const contact = await getContact(task.contactId);
  if (!contact) {
    await transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason: 'Contact not found' } });
    return;
  }

  // transitionTask leaves a terminal task unchanged and returns it as-is, so
  // each step checks it actually moved: a cancel_task landing between the
  // read above and these writes must stop the run before it dials.
  //
  // A pending task is claimed with a compare-and-set (only from 'pending'):
  // with scheduled calls, every process polling this database finds the same
  // due task on the same tick, and without an exclusive claim each one would
  // place the call. A task already in 'checking_availability' is a restart
  // resume and keeps the plain transition.
  const checking =
    task.status === 'pending'
      ? await transitionTask(task.id, 'checking_availability', undefined, { from: ['pending'] })
      : await transitionTask(task.id, 'checking_availability');
  if (checking?.status !== 'checking_availability') {
    logger.info(
      { taskId, status: checking?.status ?? 'claimed by another process or cancelled' },
      'task can no longer be started — not placing the call',
    );
    return;
  }
  const candidateWindows = await calendar.computeCandidateWindows({
    dateWindows: task.constraints.dateWindows?.length ? clipWindowsToFuture(task.constraints.dateWindows) : defaultLookaheadWindow(),
    durationMinutes: task.constraints.durationMinutes ?? 30,
  });
  const calling = await transitionTask(task.id, 'calling', { candidateWindows });
  if (calling.status !== 'calling') {
    logger.info({ taskId, status: calling.status }, 'task can no longer be started — not placing the call');
    return;
  }

  const callAttempt = await createCallAttempt(task.id);
  const telephony = createTelephonyProvider();
  const systemPrompt = buildCallSystemPrompt(task, contact, candidateWindows);
  const frontendSystemPrompt = buildCallFrontendPrompt(task, contact);

  const session = new CallSession(
    buildOutboundCallSessionOptions({ task, callAttempt, contact, telephony, calendar, systemPrompt, frontendSystemPrompt }),
  );
  await session.start();
}

/**
 * Drops whatever part of each window is already over by the time the call
 * runs. A scheduled call's windows are usually written relative to when it
 * was scheduled, and computeCandidateWindows doesn't filter out past
 * intervals — so without this the model could offer a time that has passed.
 */
export function clipWindowsToFuture(windows: TimeWindow[], now: Date = new Date()): TimeWindow[] {
  const nowMs = now.getTime();
  return windows
    .filter((window) => Date.parse(window.end) > nowMs)
    .map((window) => (Date.parse(window.start) < nowMs ? { start: now.toISOString(), end: window.end } : window));
}

function defaultLookaheadWindow(): TimeWindow[] {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return [{ start: now.toISOString(), end: end.toISOString() }];
}

const POLL_INTERVAL_MS = 15_000;

/**
 * Restart-safety net: an in-process trigger is the primary hand-off
 * mechanism (see triggerOrchestration above), but a container restart could
 * leave a task stuck in a pre-calling status with no in-memory trigger left
 * to resume it. This poller re-picks-up anything not yet on a live call —
 * tasks already 'calling'/'negotiating' at restart time are NOT auto-resumed
 * (their call is already gone; v1 just leaves them for Steve to notice via
 * list_recent_tasks rather than guessing at a retry).
 *
 * It's also what starts a scheduled call (place_call's scheduledFor): a task
 * isn't picked up until isTaskDue, so it starts within POLL_INTERVAL_MS of
 * its scheduled time.
 */
export function startOrchestrationPoller(): void {
  setInterval(() => {
    listNonTerminalTasks()
      .then((pending) => {
        for (const t of pending) {
          if ((t.status === 'pending' || t.status === 'checking_availability') && isTaskDue(t)) {
            triggerOrchestration(t.id);
          }
        }
      })
      .catch((err) => logger.error({ err }, 'Orchestration poller failed'));
  }, POLL_INTERVAL_MS);
}
