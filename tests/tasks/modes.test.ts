import { describe, expect, it } from 'vitest';
import { modeRules } from '../../src/tasks/modes.js';
import type { Task } from '../../src/tasks/schema.js';

const QUESTIONS = ['What time do you close on Saturday?', 'Do you take walk-ins?'];

function askTask(collectedAnswers: Task['collectedAnswers'] = null): Task {
  return { id: 'task-1', mode: 'ask', status: 'negotiating', questions: QUESTIONS, collectedAnswers } as Task;
}

describe('modeRules: ask (#148 review)', () => {
  it("end_call records the answers record_answer saved during the call", () => {
    const { status, outcome } = modeRules(askTask({ '1': { question: 1, answered: true, answer: '6pm.' } })).endCallOutcome(
      askTask({ '1': { question: 1, answered: true, answer: '6pm.' } }),
      ' Thanks. ',
    );
    expect(status).toBe('answered');
    expect(outcome).toEqual({
      kind: 'answered',
      answers: [
        { question: QUESTIONS[0], answered: true, answer: '6pm.' },
        { question: QUESTIONS[1], answered: false },
      ],
      summary: 'Thanks.',
    });
  });

  it('records a call that ended early with saved answers as answered, saying so', () => {
    const task = askTask({ '2': { question: 2, answered: true, answer: 'No.' } });
    expect(modeRules(task).unfinishedCallOutcome(task)).toEqual({
      status: 'answered',
      outcome: {
        kind: 'answered',
        answers: [
          { question: QUESTIONS[0], answered: false },
          { question: QUESTIONS[1], answered: true, answer: 'No.' },
        ],
        summary: 'The call ended before Banjo could wrap it up. These are the answers it saved as it went.',
      },
    });
  });

  it('leaves a call that ended early with nothing saved to fail as before', () => {
    expect(modeRules(askTask()).unfinishedCallOutcome(askTask())).toBeUndefined();
    expect(modeRules(askTask({})).unfinishedCallOutcome(askTask({}))).toBeUndefined();
  });

  it('counts a question saved as unanswered: that was still asked', () => {
    const task = askTask({ '1': { question: 1, answered: false } });
    expect(modeRules(task).unfinishedCallOutcome(task)?.status).toBe('answered');
  });
});

describe('modeRules: booking and conversation', () => {
  it('fail a call that ended early, as before', () => {
    for (const mode of ['booking', 'conversation'] as const) {
      const task = { id: 'task-1', mode, status: 'negotiating' } as Task;
      expect(modeRules(task).unfinishedCallOutcome(task)).toBeUndefined();
    }
  });
});
