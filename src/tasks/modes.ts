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
}

export const taskModes: Record<Task['mode'], TaskModeRules> = {
  booking: {
    books: true,
    endCallOutcome: (_task, summary) => ({
      status: 'escalated',
      outcome: { kind: 'escalated', reason: summary ?? 'Call ended without an explicit outcome being recorded.' },
    }),
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
  },
  // Books nothing and agrees to nothing. Ending with end_call is still the
  // end of an ask call, so it's recorded as one, with every question present.
  ask: {
    books: false,
    endCallOutcome: (task, summary) => ({
      status: 'answered',
      outcome: {
        kind: 'answered',
        answers: (task.questions ?? []).map((question) => ({ question, answered: false })),
        ...(summary?.trim() ? { summary: summary.trim() } : {}),
      },
    }),
  },
};

/** A task's rules. A task with no mode set is a booking, as the column's default says. */
export function modeRules(task: Pick<Task, 'mode'>): TaskModeRules {
  return taskModes[task.mode] ?? taskModes.booking;
}
