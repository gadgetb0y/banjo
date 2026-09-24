import { asc, eq, inArray, lt } from 'drizzle-orm';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { callAttempts, type CallAttempt } from '../tasks/schema.js';
import { callTranscriptTurns, type CallTranscriptTurn } from './schema.js';

/** Which call a line belongs to — exactly one of the two (schema check). */
export type TranscriptCall = { callAttemptId: string; inboundCallId?: never } | { inboundCallId: string; callAttemptId?: never };

export interface TranscriptTurnInput {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  quality: 'ok' | 'suspect';
  voiceProvider: string;
  spokenAt: Date;
}

/**
 * Stores one finalised line (#6). A no-op unless PERSIST_TRANSCRIPTS is on.
 * Throws on a failed insert; CallSession calls this fire-and-forget and logs
 * the failure, so a database problem never reaches the call itself.
 */
export async function saveTranscriptTurn(
  call: TranscriptCall,
  turn: TranscriptTurnInput,
  enabled: boolean = config.PERSIST_TRANSCRIPTS,
): Promise<void> {
  if (!enabled) return;
  await db.insert(callTranscriptTurns).values({
    callAttemptId: call.callAttemptId ?? null,
    inboundCallId: call.inboundCallId ?? null,
    ...turn,
  });
}

/**
 * Every call attempt for a task, oldest first, each with its lines in seq
 * order. An attempt with no saved lines is still listed, so a missing
 * transcript shows as missing rather than the attempt disappearing.
 */
export async function listTranscriptForTask(taskId: string): Promise<{ attempt: CallAttempt; turns: CallTranscriptTurn[] }[]> {
  const attempts = await db.select().from(callAttempts).where(eq(callAttempts.taskId, taskId)).orderBy(asc(callAttempts.startedAt));
  if (attempts.length === 0) return [];
  const turns = await db
    .select()
    .from(callTranscriptTurns)
    .where(
      inArray(
        callTranscriptTurns.callAttemptId,
        attempts.map((a) => a.id),
      ),
    )
    .orderBy(asc(callTranscriptTurns.seq));
  return attempts.map((attempt) => ({ attempt, turns: turns.filter((t) => t.callAttemptId === attempt.id) }));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Deletes lines spoken more than `retentionDays` ago; 0 keeps everything. Returns how many were deleted. */
export async function deleteExpiredTranscripts(
  retentionDays: number = config.TRANSCRIPT_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  if (retentionDays === 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
  const deleted = await db.delete(callTranscriptTurns).where(lt(callTranscriptTurns.spokenAt, cutoff)).returning({ id: callTranscriptTurns.id });
  return deleted.length;
}

/**
 * Retention runs at boot and then daily — even with PERSIST_TRANSCRIPTS off,
 * so switching saving off doesn't leave what was already saved forever.
 */
export function startTranscriptRetentionSweeper(): void {
  const sweep = () =>
    deleteExpiredTranscripts()
      .then((count) => {
        if (count > 0) logger.info({ count, retentionDays: config.TRANSCRIPT_RETENTION_DAYS }, 'deleted expired transcript lines');
      })
      .catch((err) => logger.error({ err }, 'transcript retention sweep failed'));
  void sweep();
  setInterval(sweep, MS_PER_DAY).unref();
}
