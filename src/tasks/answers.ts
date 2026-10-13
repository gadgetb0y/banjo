import { z } from 'zod';
import type { CollectedAnswer, Task, TaskAnswer } from './schema.js';

/**
 * One answer as the voice model reports it, by the question's number in the
 * list, starting at 1: record_answer's arguments, and each entry of
 * report_answers_and_end_call's. One definition for both (#148 review r2), so
 * the mid-call save and the final report can't drift apart. Not yet checked;
 * collectedAnswer() makes it a CollectedAnswer.
 */
export const reportedAnswerSchema = z.object({
  question: z.number().int().positive().describe("The question's number in your list, starting at 1."),
  answered: z.boolean().describe('Whether they gave you an answer to this question.'),
  answer: z.string().optional().describe('Their answer, in a short plain sentence. Leave out if not answered.'),
});
export type ReportedAnswer = z.infer<typeof reportedAnswerSchema>;

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

/**
 * What report_answers_and_end_call records: the answers saved during the call,
 * each replaced by an answer the closing report gives for the same question.
 * A closing "not answered" never erases a saved answer (#148 review): a lazy
 * report marking everything unanswered would otherwise throw away what
 * record_answer kept.
 */
export function finalAnswers(task: Pick<Task, 'questions' | 'collectedAnswers'>, reported: ReportedAnswer[]): TaskAnswer[] {
  const answeredAtTheEnd = reported.filter((r) => collectedAnswer(r).answered);
  return answersFor(task.questions ?? [], [...collectedReports(task), ...answeredAtTheEnd]);
}
