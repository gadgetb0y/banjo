import { and, count, eq, gt, isNull, lt } from 'drizzle-orm';
import { oneLine } from '../approvals/request.js';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { sendOwnerMessage } from '../notifications/owner.js';
import { getLiveCall } from '../tasks/liveCalls.js';
import { answerUrl } from './link.js';
import { ownerQuestions, type OwnerQuestion } from './schema.js';

/**
 * ask_owner: Banjo asks the owner something the task doesn't cover, during
 * the call. The question goes out through NOTIFICATION_CHANNEL with a signed
 * link (link.ts) to a page where the owner types the answer (routes.ts); the
 * answer is relayed into the live call as a fixed note (CallSession's
 * relayOwnerNote). If none comes within ASK_OWNER_TIMEOUT_SECONDS, the call is
 * told so instead, so Banjo never waits on an answer that isn't coming.
 */

/** Questions one call may have waiting at once, so a looping model can't flood the owner's phone. */
export const MAX_OPEN_QUESTIONS_PER_CALL = 3;

/** The longest answer the page accepts: it's said on the call, so a few sentences at most. */
export const MAX_ANSWER_CHARS = 500;

/** The longest question the tool accepts. */
export const MAX_QUESTION_CHARS = 300;

export type AskResult = 'asked' | 'too_many' | 'not_sent';

export async function askOwner(input: {
  taskId: string;
  callAttemptId: string;
  contactName: string;
  question: string;
  now?: Date;
}): Promise<AskResult> {
  const now = input.now ?? new Date();
  const [open] = await db
    .select({ n: count() })
    .from(ownerQuestions)
    .where(and(eq(ownerQuestions.callAttemptId, input.callAttemptId), isNull(ownerQuestions.answeredAt), gt(ownerQuestions.expiresAt, now)));
  if ((open?.n ?? 0) >= MAX_OPEN_QUESTIONS_PER_CALL) return 'too_many';

  const expiresAt = new Date(now.getTime() + config.ASK_OWNER_TIMEOUT_SECONDS * 1000);
  const [row] = await db
    .insert(ownerQuestions)
    .values({ taskId: input.taskId, callAttemptId: input.callAttemptId, question: input.question, askedAt: now, expiresAt })
    .returning();
  const sent = await sendOwnerMessage(questionMessage(row!, input.contactName), { urgent: true }).catch((err: unknown) => {
    logger.error({ err, taskId: input.taskId }, 'could not send an ask_owner question');
    return false;
  });
  if (!sent) {
    // Nobody will answer it: expire it now, so it doesn't count as open.
    await db.update(ownerQuestions).set({ expiresAt: now }).where(eq(ownerQuestions.id, row!.id));
    return 'not_sent';
  }
  setTimeout(() => void tellCallIfUnanswered(row!.id), expiresAt.getTime() - now.getTime()).unref();
  return 'asked';
}

/** The message to the owner. Banjo's words and the link come first: the question is model-written. */
export function questionMessage(question: Pick<OwnerQuestion, 'id' | 'question' | 'expiresAt'>, contactName: string): string {
  const minutes = Math.max(1, Math.round(config.ASK_OWNER_TIMEOUT_SECONDS / 60));
  return [
    `Banjo has a question for you on your call with ${oneLine(contactName)}. Answer within ${minutes} minute${minutes === 1 ? '' : 's'}: ${answerUrl(question.id, question.expiresAt)}`,
    '',
    `The question: ${oneLine(question.question)}`,
  ].join('\n');
}

export type AnswerResult = { result: 'answered'; delivered: boolean } | { result: 'already_answered' | 'expired' | 'not_found' };

/** Saves the owner's answer once, before the question expires, and relays it into the call if it's still live in this process. */
export async function answerQuestion(id: string, answer: string, now: Date = new Date()): Promise<AnswerResult> {
  const text = answer.trim().slice(0, MAX_ANSWER_CHARS);
  const [row] = await db
    .update(ownerQuestions)
    .set({ answer: text, answeredAt: now })
    .where(and(eq(ownerQuestions.id, id), isNull(ownerQuestions.answeredAt), gt(ownerQuestions.expiresAt, now)))
    .returning();
  if (!row) {
    const existing = await getOwnerQuestion(id);
    if (!existing) return { result: 'not_found' };
    return { result: existing.answeredAt ? 'already_answered' : 'expired' };
  }
  const delivered = await relay(row, answerNote(row.question, text));
  return { result: 'answered', delivered };
}

export async function getOwnerQuestion(id: string): Promise<OwnerQuestion | undefined> {
  const [row] = await db.select().from(ownerQuestions).where(eq(ownerQuestions.id, id));
  return row;
}

export async function tellCallIfUnanswered(id: string): Promise<void> {
  try {
    const row = await getOwnerQuestion(id);
    if (!row || row.answeredAt) return;
    await relay(row, noAnswerNote(row.question));
  } catch (err) {
    logger.error({ err, questionId: id }, 'could not tell the call an ask_owner question went unanswered');
  }
}

async function relay(row: OwnerQuestion, note: string): Promise<boolean> {
  const live = getLiveCall(row.taskId);
  if (!live || live.callAttemptId !== row.callAttemptId || !live.session.relayOwnerNote) return false;
  return live.session.relayOwnerNote(note);
}

/**
 * The note that brings the owner's answer into the call. Fixed text with the
 * question and answer quoted. The answer is the owner's own, so it's followed
 * like their instructions, within the call's fixed rules.
 */
export function answerNote(question: string, answer: string): string {
  const principal = config.ASSISTANT_PRINCIPAL_NAME;
  return (
    `${principal} has answered the question you asked them, ${JSON.stringify(oneLine(question))}. Their answer: ${JSON.stringify(answer)}. ` +
    `It comes from ${principal} directly: use it as they mean it, within your rules. Tell the other party what they need from it, in your own words, and carry on with the call.`
  );
}

/** The note when no answer came in time. Banjo must not guess it. */
export function noAnswerNote(question: string): string {
  const principal = config.ASSISTANT_PRINCIPAL_NAME;
  const transfer = config.TRANSFER_ENABLED ? ` If they need ${principal} for it, you can offer to connect them.` : '';
  return (
    `${principal} hasn't answered the question you asked them, ${JSON.stringify(oneLine(question))}, and won't in time. Don't guess the answer. ` +
    `Tell the other party you couldn't reach ${principal} for that yet, and carry on with what you can settle without it.${transfer} If the call can't go on without it, escalate.`
  );
}

/** Deletes questions asked more than `retentionDays` ago, alongside transcripts; 0 keeps everything. */
export async function deleteExpiredOwnerQuestions(retentionDays: number = config.TRANSCRIPT_RETENTION_DAYS, now: Date = new Date()): Promise<number> {
  if (retentionDays === 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(ownerQuestions).where(lt(ownerQuestions.askedAt, cutoff)).returning({ id: ownerQuestions.id });
  return deleted.length;
}
