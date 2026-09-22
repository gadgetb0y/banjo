import { z } from 'zod';
import { getLiveCall } from '../../tasks/liveCalls.js';
import { getTask } from '../../tasks/service.js';

export const stopCallInputSchema = z.object({
  taskId: z.string().uuid().describe('Id of the task whose call should be stopped, as returned by place_call.'),
  reason: z
    .string()
    .optional()
    .describe('Why the call is being stopped. Recorded as the task outcome and included in the notification.'),
});

export interface StopCallResult {
  taskId: string;
  stopped: boolean;
  status?: string;
  message: string;
}

const DEFAULT_REASON = 'Call stopped by the user';

/**
 * Hangs up a call that is already in progress — the thing cancel_task
 * deliberately cannot do (it only matches tasks whose call hasn't been placed
 * yet).
 *
 * Routes through CallSession.stop so an operator-stopped call is torn down and
 * persisted exactly like any other ending, rather than hanging up Twilio behind
 * the session's back and leaving it to notice.
 *
 * The registry is per-process by necessity (a CallSession owns live WebSocket
 * state), so "no live call" here means "not running in THIS process" — which
 * for a single-instance deployment is the same thing, and the message says so
 * rather than overclaiming.
 */
export async function stopCallHandler(input: z.infer<typeof stopCallInputSchema>): Promise<StopCallResult> {
  const live = getLiveCall(input.taskId);
  if (live) {
    const reason = input.reason ?? DEFAULT_REASON;
    await live.session.stop(reason);
    return {
      taskId: input.taskId,
      stopped: true,
      message: `Call stopped — ${reason}. The task is recorded as failed with that reason.`,
    };
  }

  const task = await getTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);
  return {
    taskId: task.id,
    stopped: false,
    status: task.status,
    message: `Not stopped — there is no live call for this task on this instance (its status is "${task.status}"). It has either finished already or was never placed.`,
  };
}
