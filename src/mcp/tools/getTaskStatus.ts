import { z } from 'zod';
import { getTask } from '../../tasks/service.js';

export const getTaskStatusInputSchema = z.object({
  taskId: z.string().uuid().describe('Id of the task to check, as returned by place_call, list_recent_tasks, or record_task_outcome.'),
});

export type GetTaskStatusResult =
  | {
      found: true;
      status: string;
      outcome: unknown;
      updatedAt: string;
      /** ISO instant a scheduled call won't be placed before (place_call's scheduledFor), or null if none. */
      scheduledFor: string | null;
    }
  | {
      found: false;
      message: string;
    };

export async function getTaskStatusHandler(input: z.infer<typeof getTaskStatusInputSchema>): Promise<GetTaskStatusResult> {
  const task = await getTask(input.taskId);
  if (!task) {
    return { found: false, message: `No task found with id "${input.taskId}".` };
  }
  return {
    found: true,
    status: task.status,
    outcome: task.outcome ?? null,
    updatedAt: task.updatedAt.toISOString(),
    scheduledFor: task.scheduledFor?.toISOString() ?? null,
  };
}
