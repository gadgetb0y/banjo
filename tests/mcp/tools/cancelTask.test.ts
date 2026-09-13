import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelPendingTask } = vi.hoisted(() => ({ cancelPendingTask: vi.fn() }));
vi.mock('../../../src/tasks/service.js', () => ({ cancelPendingTask }));

const { cancelTaskHandler, cancelTaskInputSchema } = await import('../../../src/mcp/tools/cancelTask.js');

const TASK_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcp: cancel_task', () => {
  it('requires a uuid taskId', () => {
    expect(cancelTaskInputSchema.safeParse({ taskId: 'not-a-uuid' }).success).toBe(false);
    expect(cancelTaskInputSchema.safeParse({ taskId: TASK_ID }).success).toBe(true);
  });

  it('reports a pending task as cancelled', async () => {
    cancelPendingTask.mockResolvedValue({ id: TASK_ID, status: 'cancelled' });
    await expect(cancelTaskHandler({ taskId: TASK_ID })).resolves.toMatchObject({ cancelled: true, status: 'cancelled' });
    expect(cancelPendingTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('reports a task already on a call or finished as not cancelled, with its status', async () => {
    cancelPendingTask.mockResolvedValue({ id: TASK_ID, status: 'calling' });
    const result = await cancelTaskHandler({ taskId: TASK_ID });
    expect(result).toMatchObject({ cancelled: false, status: 'calling' });
    expect(result.message).toContain('calling');
  });

  it('throws for a task that does not exist', async () => {
    cancelPendingTask.mockResolvedValue(undefined);
    await expect(cancelTaskHandler({ taskId: TASK_ID })).rejects.toThrow(/Task not found/);
  });
});
