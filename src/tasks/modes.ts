import { collectedAnswersFor, collectedReports } from './answers.js';
import type { Task, TaskOutcome } from './schema.js';

/**
 * What differs between task modes, in one place (#148 review). Ask mode
 * first spread its differences across string checks in the orchestrator, the
 * tool list, the prompt and end_call, and missed three of them: end_call
 * recorded ask calls as 'escalated' and dropped their answers, booking text
 * leaked into ask prompts, and an ask call could fail over date windows it
 * never uses. A new mode now has to answer each question here, and
 * Record<Task['mode'], …> makes leaving one out a type error.
 *
 * Tools are not listed here: tasks/callSessionAdapter.ts picks them from
 * `books` and its own per-mode ending tool, since voice/tools/callTools.ts
 * imports from this module.
 */
export interface TaskModeRules {
  /**
   * Whether the call may book a time: a calendar lookup and the date-window
   * check before dialing, the booking tools, and the booking lines of the prompt.
   */
  books: boolean;
  /**
   * What end_call records when nothing was recorded before it (its safety
   * net). The model reaches for the generic end_call on every kind of call.
   */
  endCallOutcome(task: Task, summary: string | undefined): { status: Task['status']; outcome: TaskOutcome };
  /**
   * What a call that ended on its own with the task still unfinished is
   * recorded as (the far end hung up, the process died mid-call), or
   * undefined to record it 'failed' as before. Not used when the owner
   * stopped the call or the session failed: those keep their reason (r2). `task` is the row as it
   * stands once the call is over.
   */
  unfinishedCallOutcome(task: Task): { status: Task['status']; outcome: TaskOutcome } | undefined;
}

/** The summary of an ask call recorded from answers saved mid-call. Banjo's own words, never the model's. */
export const UNFINISHED_ASK_SUMMARY = 'The call ended before Banjo could wrap it up. These are the answers it saved as it went.';

export const taskModes: Record<Task['mode'], TaskModeRules> = {
  booking: {
    books: true,
    endCallOutcome: (_task, summary) => ({
      status: 'escalated',
      outcome: { kind: 'escalated', reason: summary ?? 'Call ended without an explicit outcome being recorded.' },
    }),
    unfinishedCallOutcome: () => undefined,
  },
  // Can still book if a time comes up (promptBuilder's conversation guidance).
  // A live call's end_call summary was a plain recap, not an escalation
  // reason: landing it in 'escalated' flagged a normal call for follow-up.
  conversation: {
    books: true,
    endCallOutcome: (_task, summary) => ({
      status: 'conversation_completed',
      outcome: { kind: 'conversation_completed', summary: summary ?? 'Call ended without an explicit summary being recorded.' },
    }),
    unfinishedCallOutcome: () => undefined,
  },
  // Books nothing and agrees to nothing. Ending with end_call is still the
  // end of an ask call, so it's recorded as one, with every question present
  // and the answers record_answer saved along the way.
  //
  // A call that ended before any ending tool ran keeps what record_answer
  // saved (#148 review): a business saying "yep, bye" and hanging up used to
  // fail the task and lose every answer. With nothing saved there's nothing
  // to report, so it fails as any other call would.
  ask: {
    books: false,
    // With no answer saved, end_call is escalated with its summary instead:
    // the model can put answers there without saving them, and 'answered'
    // with none answered sent the owner an urgent "no answers" (r2).
    endCallOutcome: (task, summary) => {
      const answers = collectedAnswersFor(task);
      const note = summary?.trim();
      if (!answers.some((a) => a.answered)) {
        return {
          status: 'escalated',
          outcome: {
            kind: 'escalated',
            reason: note ? `Ended without saving answers. Banjo noted: ${note}` : 'Ended without saving any answers.',
          },
        };
      }
      return { status: 'answered', outcome: { kind: 'answered', answers, ...(note ? { summary: note } : {}) } };
    },
    // Only a real answer counts: a call that broke after one "no idea" isn't
    // an answered call (r2).
    unfinishedCallOutcome: (task) => {
      const answers = collectedAnswersFor(task);
      return answers.some((a) => a.answered)
        ? { status: 'answered', outcome: { kind: 'answered', answers, summary: UNFINISHED_ASK_SUMMARY } }
        : undefined;
    },
  },
};

/** A task's rules. A task with no mode set is a booking, as the column's default says. */
export function modeRules(task: Pick<Task, 'mode'>): TaskModeRules {
  return taskModes[task.mode] ?? taskModes.booking;
}
