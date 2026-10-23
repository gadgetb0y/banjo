/**
 * Rescues (#188): each time one of CallSession's safety nets stepped in for
 * the model. A rescue never fails a check, since the other party still heard
 * a proper call, but a rising count shows the model getting worse while the
 * checks still pass. Found in the recorded boundary log, so nothing in the
 * call path has to report them.
 */
import { FALLBACK_GOODBYE, openingLineCue, REFUSAL_ERRORS, STILL_THERE_CUE, UNANSWERED_QUESTION_CUE } from '../session/callSession.js';
import type { LogEntry } from './recorder.js';

export type RescueKind = 'refused_ending' | 'fixed_goodbye' | 'cued_goodbye' | 'still_there_check' | 'opener_cue';

export interface Rescue {
  kind: RescueKind;
  t: number;
  detail?: string;
}

// openingLineCue's fixed opening, before the line it quotes.
const OPENER_CUE_PREFIX = openingLineCue('').split('"')[0]!;

function cueKind(text: string): RescueKind | null {
  if (text === UNANSWERED_QUESTION_CUE) return 'cued_goodbye';
  if (text === STILL_THERE_CUE) return 'still_there_check';
  if (text.startsWith(OPENER_CUE_PREFIX)) return 'opener_cue';
  return null;
}

export function findRescues(log: LogEntry[]): Rescue[] {
  const rescues: Rescue[] = [];
  for (const entry of log) {
    if (entry.dir !== 'in') continue;
    if (entry.call === 'sendToolResult' && entry.isError) {
      const error = (entry.result as { error?: unknown } | null)?.error;
      if ((REFUSAL_ERRORS as readonly unknown[]).includes(error)) rescues.push({ kind: 'refused_ending', t: entry.t, detail: error as string });
    } else if (entry.call === 'sayVerbatim' && entry.text === FALLBACK_GOODBYE) {
      rescues.push({ kind: 'fixed_goodbye', t: entry.t });
    } else if (entry.call === 'triggerResponse' && entry.cue !== undefined) {
      const kind = cueKind(entry.cue);
      if (kind) rescues.push({ kind, t: entry.t });
    } else if (entry.call === 'addContext') {
      for (const item of entry.items) {
        const kind = item.role === 'system' ? cueKind(item.text) : null;
        if (kind) rescues.push({ kind, t: entry.t });
      }
    }
  }
  return rescues;
}
