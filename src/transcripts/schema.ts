import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { inboundCalls } from '../inbound/schema.js';
import { callAttempts } from '../tasks/schema.js';

export const transcriptRoleEnum = pgEnum('transcript_role', ['user', 'assistant']);

// From session/transcriptQuality.ts. 'empty' turns are never stored, so it
// isn't a value here. 'suspect' means the transcriber may have invented the
// line (#25) — shown as such, never as plain speech.
export const transcriptQualityEnum = pgEnum('transcript_quality', ['ok', 'suspect']);

/**
 * One finalised line of a call, in the order CallSession received it (#6).
 *
 * Belongs to exactly one call: an outbound call attempt or an inbound call.
 * The two paths identify calls differently (docs/ROADMAP.md §1), so this is
 * two nullable FKs with a check rather than a polymorphic id — it keeps
 * referential integrity, and ON DELETE CASCADE means deleting a call deletes
 * what was said on it.
 *
 * Personal data: off unless PERSIST_TRANSCRIPTS=true, and deleted after
 * TRANSCRIPT_RETENTION_DAYS (transcripts/service.ts).
 */
export const callTranscriptTurns = pgTable(
  'call_transcript_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callAttemptId: uuid('call_attempt_id').references(() => callAttempts.id, { onDelete: 'cascade' }),
    inboundCallId: uuid('inbound_call_id').references(() => inboundCalls.id, { onDelete: 'cascade' }),
    // Arrival order at CallSession, from 1. Under full duplex a user line can
    // go final a moment after the assistant started replying, so this is the
    // order lines were finalised, not strictly the order they were spoken.
    seq: integer('seq').notNull(),
    role: transcriptRoleEnum('role').notNull(),
    text: text('text').notNull(),
    quality: transcriptQualityEnum('quality').notNull(),
    // Which VoiceAIProvider handled the call. Gemini transcribes only the
    // assistant's side, so a Gemini call with no user lines is partial, not
    // silent — the read path says so.
    voiceProvider: text('voice_provider').notNull(),
    spokenAt: timestamp('spoken_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneCall: check('call_transcript_turns_one_call', sql`(${table.callAttemptId} IS NULL) <> (${table.inboundCallId} IS NULL)`),
    attemptSeqUnique: uniqueIndex('call_transcript_turns_attempt_seq').on(table.callAttemptId, table.seq),
    inboundSeqUnique: uniqueIndex('call_transcript_turns_inbound_seq').on(table.inboundCallId, table.seq),
    spokenAtIdx: index('call_transcript_turns_spoken_at_idx').on(table.spokenAt),
  }),
);

export type CallTranscriptTurn = typeof callTranscriptTurns.$inferSelect;
