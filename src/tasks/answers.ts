import type { CollectedAnswer, ReportedAnswer, Task, TaskAnswer } from './schema.js';

/**
 * An ask call's answers (#148), from what the voice model reported to what
 * the task records. Here rather than in voice/tools/callTools.ts because
 * tasks/modes.ts needs them too, and callTools.ts imports modes.ts.
 */

/** Checks one report: an answered question with no answer text is recorded as not answered. */
export function collectedAnswer(report: ReportedAnswer): CollectedAnswer {
  const answer = report.answer?.trim();
  return report.answered && answer
    ? { question: report.question, answered: true, answer }
    : { question: report.question, answered: false };
}

/**
 * Pairs reported answers with the task's own questions, by number: the stored
 * question text goes into the outcome, never the model's paraphrase of it.
 * The last report for a number wins, so a correction later in the list
 * replaces what came before it (#148 review). A question with no report is
 * recorded as not answered, so the result always has exactly one entry per
 * question, in order; a number with no question is ignored.
 */
export function answersFor(questions: string[], reported: ReportedAnswer[]): TaskAnswer[] {
  return questions.map((question, i) => {
    const report = reported.findLast((r) => r.question === i + 1);
    const checked = report ? collectedAnswer(report) : undefined;
    return checked?.answered ? { question, answered: true, answer: checked.answer } : { question, answered: false };
  });
}

/** What record_answer saved during the call, in question order. */
export function collectedReports(task: Pick<Task, 'collectedAnswers'>): CollectedAnswer[] {
  return Object.values(task.collectedAnswers ?? {}).sort((a, b) => a.question - b.question);
}

/** The task's questions, each paired with what record_answer saved for it, if anything. */
export function collectedAnswersFor(task: Pick<Task, 'questions' | 'collectedAnswers'>): TaskAnswer[] {
  return answersFor(task.questions ?? [], collectedReports(task));
}
