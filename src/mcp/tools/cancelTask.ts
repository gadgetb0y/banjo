import { z } from 'zod';
import { cancelPendingTask } from '../../tasks/service.js';

export const cancelTaskInputSchema = z.object({
  taskId: z.string().uuid().describe('Id of the task to cancel, as returned by place_call.'),
});

export interface CancelTaskResult {
  taskId: string;
  cancelled: boolean;
  status: string;
  message: string;
}

/**
 * Calls off a phone call that hasn't been placed yet — typically one
 * scheduled for later via place_call's scheduledFor. A call already in
 * progress or finished is left alone and reported as not cancelled.
 */
export async function cancelTaskHandler(input: z.infer<typeof cancelTaskInputSchema>): Promise<CancelTaskResult> {
  const task = await cancelPendingTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);
  if (task.status === 'cancelled') {
    return { taskId: task.id, cancelled: true, status: task.status, message: 'Cancelled — this call will not be placed.' };
  }
  return {
    taskId: task.id,
    cancelled: false,
    status: task.status,
    message: `Not cancelled — the task is already "${task.status}", so the call has started or finished.`,
  };
}
