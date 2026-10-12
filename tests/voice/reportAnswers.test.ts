import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext } from '../../src/session/types.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

// Same persistence stub as tests/voice/callTools.test.ts.
const { transitionTask } = vi.hoisted(() => ({
  transitionTask: vi.fn(async (id: string, status: string) => ({ id, status }) as unknown as Task),
}));
vi.mock('../../src/tasks/service.js', () => ({
  transitionTask,
  isTerminalStatus: (status: string) => !['pending', 'checking_availability', 'calling', 'negotiating'].includes(status),
}));

const { answersFor, callTools, reportAnswersAndEndCallTool } = await import('../../src/voice/tools/callTools.js');

const QUESTIONS = ['What time do you close on Saturday?', 'Do you take walk-ins?', 'How much is a full groom?'];

beforeEach(() => {
  vi.clearAllMocks();
});

function ctx(hangUp: TelephonyProvider['hangUp']): CallContext {
  return {
    task: { id: 'task-1', status: 'negotiating', mode: 'ask', questions: QUESTIONS } as Task,
    callAttempt: { id: 'call-attempt-1' } as CallAttempt,
    callId: 'call-attempt-1',
    telephony: { hangUp } as unknown as TelephonyProvider,
    calendar: {} as CallContext['calendar'],
    estimatedAudioDoneAt: Date.now(),
  };
}

describe('answersFor (#148)', () => {
  it("pairs answers with the task's own question text, by number, one entry per question", () => {
    expect(
      answersFor(QUESTIONS, [
        { question: 2, answered: false },
        { question: 1, answered: true, answer: '6pm on Saturdays.' },
      ]),
    ).toEqual([
      { question: QUESTIONS[0], answered: true, answer: '6pm on Saturdays.' },
      { question: QUESTIONS[1], answered: false },
      { question: QUESTIONS[2], answered: false },
    ]);
  });

  it('records an answered question with no answer text as not answered', () => {
    expect(answersFor(['Q?'], [{ question: 1, answered: true, answer: '  ' }])).toEqual([{ question: 'Q?', answered: false }]);
    expect(answersFor(['Q?'], [{ question: 1, answered: true }])).toEqual([{ question: 'Q?', answered: false }]);
  });

  it('drops answer text for a question marked not answered, and ignores numbers with no question', () => {
    expect(
      answersFor(['Q?'], [
        { question: 1, answered: false, answer: 'a guess' },
        { question: 7, answered: true, answer: 'stray' },
      ]),
    ).toEqual([{ question: 'Q?', answered: false }]);
  });
});

describe('report_answers_and_end_call (#148)', () => {
  it('is not in the shared tool set: only ask calls get it', () => {
    expect(callTools.some((t) => t.name === 'report_answers_and_end_call')).toBe(false);
  });

  it('ends the call like the other normal endings: after a goodbye, yielding to the other party', () => {
    expect(reportAnswersAndEndCallTool.endsCall).toBe(true);
    expect(reportAnswersAndEndCallTool.requiresGoodbye).toBe(true);
    expect(reportAnswersAndEndCallTool.yieldsToCallee).toBe(true);
    expect(reportAnswersAndEndCallTool.verbatimMessage).toBeUndefined();
  });

  it('records the answered outcome before hanging up', async () => {
    const hangUp = vi.fn(async () => {});
    const result = await reportAnswersAndEndCallTool.handler(
      { answers: [{ question: 1, answered: true, answer: '6pm.' }], summary: '  They also groom cats.  ' },
      ctx(hangUp),
    );

    expect(result).toEqual({ ok: true });
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'answered', {
      outcome: {
        kind: 'answered',
        answers: [
          { question: QUESTIONS[0], answered: true, answer: '6pm.' },
          { question: QUESTIONS[1], answered: false },
          { question: QUESTIONS[2], answered: false },
        ],
        summary: 'They also groom cats.',
      },
    });
    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(transitionTask.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(hangUp).mock.invocationCallOrder[0]!);
  });

  it('leaves summary out of the outcome when there is none', async () => {
    await reportAnswersAndEndCallTool.handler({ answers: [], summary: ' ' }, ctx(vi.fn(async () => {})));
    expect((transitionTask.mock.calls[0] as unknown[])[2]).toEqual({
      outcome: { kind: 'answered', answers: QUESTIONS.map((question) => ({ question, answered: false })) },
    });
  });

  it('tells the model to record only what was said', () => {
    expect(reportAnswersAndEndCallTool.description).toContain('Record only what they actually told you on this call');
  });
});
