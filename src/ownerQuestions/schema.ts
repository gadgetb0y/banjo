import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { callAttempts, tasks } from '../tasks/schema.js';

/**
 * A question Banjo asked the owner during a call (ask_owner), and the answer
 * they typed on the linked page. Belongs to the call attempt it was asked on,
 * so deleting the call deletes it. Personal data: deleted with the call's
 * transcript (TRANSCRIPT_RETENTION_DAYS, transcripts/service.ts).
 */
export const ownerQuestions = pgTable(
  'owner_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    callAttemptId: uuid('call_attempt_id')
      .notNull()
      .references(() => callAttempts.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer'),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    // After this, the answer page refuses an answer and the call is told none came.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    callAttemptIdx: index('owner_questions_call_attempt_idx').on(table.callAttemptId),
    askedAtIdx: index('owner_questions_asked_at_idx').on(table.askedAt),
  }),
);

export type OwnerQuestion = typeof ownerQuestions.$inferSelect;
