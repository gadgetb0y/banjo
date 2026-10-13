import { z } from 'zod';
import { listRecentTasks } from '../../tasks/service.js';
import type { Task } from '../../tasks/schema.js';

export const listRecentTasksInputSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Maximum number of tasks to return, most recently updated first. Defaults to 20.'),
});

/**
 * A task without its candidateWindows: the free slots the call prompt is built
 * from, internal to the call and a week of half-hour slots by default. Whole
 * rows put hundreds of them per task into the calling agent's context (#120).
 *
 * Also without collectedAnswers, the answers an ask call saved as it went: the
 * raw map is keyed by question number, without the questions. get_task_status
 * returns them paired with their questions (#148 review), so they have one
 * shape and one place to be read from.
 */
export type TaskSummary = Omit<Task, 'candidateWindows' | 'collectedAnswers'>;

export async function listRecentTasksHandler(input: z.infer<typeof listRecentTasksInputSchema>): Promise<TaskSummary[]> {
  const tasks = await listRecentTasks(input.limit ?? 20);
  return tasks.map(({ candidateWindows: _candidateWindows, collectedAnswers: _collectedAnswers, ...summary }) => summary);
}
