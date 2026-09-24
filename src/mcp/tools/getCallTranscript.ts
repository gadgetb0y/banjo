import { z } from 'zod';
import { config } from '../../config/index.js';
import { formatInZone } from '../../lib/timezone.js';
import { getTask } from '../../tasks/service.js';
import { listTranscriptForTask } from '../../transcripts/service.js';

export const getCallTranscriptInputSchema = z.object({
  taskId: z.string().uuid().describe('Id of the task whose calls to read, as returned by place_call or list_recent_tasks.'),
});

export interface TranscriptLine {
  seq: number;
  /** Local time (CALENDAR_TIMEZONE), no UTC offset — the convention every call-facing time uses. */
  at: string;
  speaker: 'banjo' | 'other_party';
  text: string;
  /** The transcriber may have invented this line from line noise (#25). */
  suspect?: true;
}

export type GetCallTranscriptResult =
  | {
      found: true;
      taskId: string;
      calls: { callAttemptId: string; startedAt: string; lines: TranscriptLine[]; note?: string }[];
      notes: string[];
    }
  | { found: false; message: string };

/**
 * What was said on a task's calls (#6), for "what did they actually say?".
 * Every gap in the record is said out loud in `note`/`notes` — a one-sided
 * Gemini call, saving switched off, suspect lines — so an incomplete
 * transcript can't pass for a complete one.
 */
export async function getCallTranscriptHandler(
  input: z.infer<typeof getCallTranscriptInputSchema>,
  settings: { enabled: boolean; retentionDays: number } = {
    enabled: config.PERSIST_TRANSCRIPTS,
    retentionDays: config.TRANSCRIPT_RETENTION_DAYS,
  },
): Promise<GetCallTranscriptResult> {
  const task = await getTask(input.taskId);
  if (!task) return { found: false, message: `No task found with id "${input.taskId}".` };

  const tz = config.CALENDAR_TIMEZONE;
  const attempts = await listTranscriptForTask(input.taskId);
  let anySuspect = false;

  const calls = attempts.map(({ attempt, turns }) => {
    const lines: TranscriptLine[] = turns.map((t) => {
      if (t.quality === 'suspect') anySuspect = true;
      return {
        seq: t.seq,
        at: formatInZone(t.spokenAt.toISOString(), tz),
        speaker: t.role === 'assistant' ? 'banjo' : 'other_party',
        text: t.text,
        ...(t.quality === 'suspect' && { suspect: true as const }),
      };
    });
    let note: string | undefined;
    if (turns.length === 0) {
      note = 'No lines were saved for this call — saving was off, the call never connected, or its transcript has passed the retention window.';
    } else if (turns.every((t) => t.voiceProvider === 'gemini') && !turns.some((t) => t.role === 'user')) {
      note = "Only Banjo's side was transcribed: the Gemini provider doesn't transcribe the other party.";
    }
    return {
      callAttemptId: attempt.id,
      startedAt: formatInZone(attempt.startedAt.toISOString(), tz),
      lines,
      ...(note && { note }),
    };
  });

  const notes: string[] = [];
  if (!settings.enabled) notes.push("Transcripts aren't being saved on this install (PERSIST_TRANSCRIPTS is off).");
  notes.push(
    settings.retentionDays === 0
      ? 'Saved transcripts are kept indefinitely (TRANSCRIPT_RETENTION_DAYS=0).'
      : `Saved transcripts are deleted after ${settings.retentionDays} days.`,
  );
  if (anySuspect) {
    notes.push('Lines marked suspect may not be what was actually said: the transcriber sometimes invents text from line noise.');
  }
  if (calls.some((c) => c.lines.length > 0)) {
    notes.push("Lines are in the order they were transcribed; the other party's words can land just after Banjo starts replying.");
  }
  return { found: true, taskId: input.taskId, calls, notes };
}
