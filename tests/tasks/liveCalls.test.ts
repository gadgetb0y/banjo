import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLiveCall, listLiveCalls, registerLiveCall, unregisterLiveCall } from '../../src/tasks/liveCalls.js';

function fakeSession() {
  return { stop: vi.fn(async () => {}) } as never;
}

beforeEach(() => {
  for (const entry of listLiveCalls()) unregisterLiveCall(entry.taskId);
});

describe('live call registry', () => {
  it('hands back a call that is currently running', () => {
    const session = fakeSession();
    registerLiveCall({ taskId: 'task-1', callAttemptId: 'attempt-1', session });

    expect(getLiveCall('task-1')).toMatchObject({ taskId: 'task-1', callAttemptId: 'attempt-1' });
    expect(listLiveCalls().map((c) => c.taskId)).toEqual(['task-1']);
  });

  it('forgets a call once it has been unregistered', () => {
    registerLiveCall({ taskId: 'task-1', callAttemptId: 'attempt-1', session: fakeSession() });
    unregisterLiveCall('task-1');

    expect(getLiveCall('task-1')).toBeUndefined();
    expect(listLiveCalls()).toEqual([]);
  });

  it('knows nothing about a task it was never told about', () => {
    expect(getLiveCall('never-seen')).toBeUndefined();
  });
});
