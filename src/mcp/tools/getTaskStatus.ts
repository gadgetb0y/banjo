import { z } from 'zod';
import { collectedAnswersFor } from '../../tasks/answers.js';
import type { TaskAnswer } from '../../tasks/schema.js';
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
      /**
       * 'ask' tasks only (#148 review): each question with the answer
       * record_answer saved for it during the call, if any. The only place
       * those answers show when the call ended as something other than
       * 'answered' (a transfer, an escalation, a voicemail, a hold limit),
       * since that outcome is kept as it is. Written by the voice model from
       * the call, so data, like the outcome's free text.
       */
      collectedAnswers?: TaskAnswer[];
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
    ...(task.mode === 'ask' ? { collectedAnswers: collectedAnswersFor(task) } : {}),
  };
}
