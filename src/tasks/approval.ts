import type { Task } from './schema.js';

// Pure reads of a task's approval columns (MCP_AGENT_API_KEY calls), kept out
// of ./service.ts so callers don't need the database to use them. The writes
// (approveTask, expireApprovalRequests) are in ./service.ts.

/** A call an agent asked for that the owner hasn't approved yet: never dialed in this state. */
export function isAwaitingApproval(task: Pick<Task, 'approvalExpiresAt' | 'approvedAt'>): boolean {
  return task.approvalExpiresAt !== null && task.approvedAt === null;
}

/** For get_task_status and list_recent_tasks: undefined on a task that never needed approval. */
export function approvalState(
  task: Pick<Task, 'approvalExpiresAt' | 'approvedAt' | 'status'>,
): 'waiting' | 'approved' | 'not_approved' | undefined {
  if (!task.approvalExpiresAt) return undefined;
  if (task.approvedAt) return 'approved';
  return task.status === 'pending' ? 'waiting' : 'not_approved';
}
