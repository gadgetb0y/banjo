import { describe, expect, it, vi } from 'vitest';

const insertValues = vi.fn();
const insertReturning = vi.fn();
insertValues.mockImplementation(() => ({ returning: insertReturning }));
const insertMock = vi.fn(() => ({ values: insertValues }));

const updateSet = vi.fn();
const updateWhere = vi.fn();
const updateReturning = vi.fn();
updateSet.mockImplementation(() => ({ where: updateWhere }));
updateWhere.mockImplementation(() => ({ returning: updateReturning }));
const updateMock = vi.fn(() => ({ set: updateSet }));

const selectWhere = vi.fn();
const selectMock = vi.fn(() => ({ from: () => ({ where: selectWhere }) }));

vi.mock('../../src/db/index.js', () => ({
  db: { insert: insertMock, update: updateMock, select: selectMock },
}));

const { createTask, isTaskDue, transitionTask } = await import('../../src/tasks/service.js');

describe('transitionTask', () => {
  it('returns the updated row when the task was still in progress', async () => {
    updateReturning.mockResolvedValue([{ id: 'task-1', status: 'confirmed' }]);

    const result = await transitionTask('task-1', 'confirmed');

    expect(result).toEqual({ id: 'task-1', status: 'confirmed' });
    expect(updateSet).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'confirmed' }));
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('leaves a terminal task unchanged and returns it as-is', async () => {
    updateReturning.mockResolvedValue([]); // the non-terminal guard in the WHERE matched nothing
    selectWhere.mockResolvedValue([{ id: 'task-1', status: 'confirmed' }]);

    const result = await transitionTask('task-1', 'conversation_completed', {
      outcome: { kind: 'conversation_completed', summary: 'late summary' },
    });

    expect(result).toEqual({ id: 'task-1', status: 'confirmed' });
  });

  it('throws when the task does not exist', async () => {
    updateReturning.mockResolvedValue([]);
    selectWhere.mockResolvedValue([]);

    await expect(transitionTask('missing', 'failed')).rejects.toThrow('Task not found: missing');
  });
});

describe('isTaskDue', () => {
  const now = new Date('2026-09-13T13:00:00.000Z');

  it('is due when the task has no scheduled time', () => {
    expect(isTaskDue({ scheduledFor: null }, now)).toBe(true);
  });

  it('is not due before its scheduled time', () => {
    expect(isTaskDue({ scheduledFor: new Date('2026-09-13T13:00:01.000Z') }, now)).toBe(false);
  });

  it('is due at and after its scheduled time', () => {
    expect(isTaskDue({ scheduledFor: new Date('2026-09-13T13:00:00.000Z') }, now)).toBe(true);
    expect(isTaskDue({ scheduledFor: new Date('2026-09-13T12:00:00.000Z') }, now)).toBe(true);
  });
});

describe('createTask: scheduledFor', () => {
  it('passes scheduledFor through to the insert when given', async () => {
    insertReturning.mockResolvedValue([{ id: 'task-3' }]);
    const scheduledFor = new Date('2026-09-13T13:00:00.000Z');

    await createTask({ contactId: 'contact-1', channel: 'phone', goalDescription: 'Call later', constraints: {}, scheduledFor });

    expect(insertValues).toHaveBeenLastCalledWith(expect.objectContaining({ scheduledFor }));
  });
});

describe('createTask', () => {
  it('defaults mode to "booking" when omitted', async () => {
    insertReturning.mockResolvedValue([{ id: 'task-1', mode: 'booking' }]);

    await createTask({
      contactId: 'contact-1',
      channel: 'phone',
      goalDescription: 'Book a haircut',
      constraints: {},
    });

    expect(insertValues).toHaveBeenCalledWith(expect.not.objectContaining({ mode: expect.anything() }));
  });

  it('passes mode: "conversation" through to the insert when given explicitly', async () => {
    insertReturning.mockResolvedValue([{ id: 'task-2', mode: 'conversation' }]);

    await createTask({
      contactId: 'contact-1',
      channel: 'phone',
      goalDescription: 'Call and say thanks',
      constraints: {},
      mode: 'conversation',
    });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ mode: 'conversation' }));
  });
});
