/**
 * Waiting on hold (#151): what CallSession needs that isn't CallSession state.
 *
 * A hold queue repeats itself: the same "your call is important to us" every
 * thirty seconds, the same menu reminder. Each repeat would otherwise cost a
 * judgment (VoiceAIProvider.judgeHoldLine), so a line that closely matches one
 * already heard on this hold is skipped. A person picking up says something
 * new, so they are never skipped by this.
 */

/** How much of a line's wording must match an earlier one (shared words over all words) to count as a repeat. */
const REPEAT_OVERLAP = 0.8;

function words(line: string): string[] {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Whether `line` repeats something already heard on this hold, by wording rather than exact text, since transcription varies run to run. */
export function isRepeatOnHold(line: string, heard: readonly string[]): boolean {
  const these = new Set(words(line));
  if (these.size === 0) return true;
  return heard.some((earlier) => {
    const those = new Set(words(earlier));
    const shared = [...these].filter((w) => those.has(w)).length;
    const all = new Set([...these, ...those]).size;
    return all > 0 && shared / all >= REPEAT_OVERLAP;
  });
}

/**
 * The one-time cue Banjo gets when a person picks up after a hold (#151).
 * They never heard the call's opening, so Banjo opens again: the disclosure
 * first, as on any outbound call, then why it's calling.
 */
export function personPickedUpCue(personLine: string, openingLine: string | undefined): string {
  const opener = openingLine
    ? `Your first sentence must be: ${JSON.stringify(openingLine)} Then say briefly why you're calling.`
    : "Greet them, say you're an AI assistant, and say briefly why you're calling.";
  return (
    `One-time cue for this moment only: you were waiting on hold, and a live person has just picked up. They said: ` +
    `${JSON.stringify(personLine)} They haven't heard anything you said before the hold. ${opener} ` +
    'Then carry on with the call as usual. If it turns out to be another recording after all, call wait_on_hold again ' +
    'without saying anything more. Disregard this cue on every later turn.'
  );
}

/**
 * The longest this hold may last: the call's own limit, cut short so the
 * voice session still has `reserveMs` left to talk in once a person picks up.
 * Zero or less means there isn't time to wait at all.
 */
export function holdBudgetMs(opts: {
  maxHoldMs: number;
  now: number;
  sessionStartedAt: number | undefined;
  maxSessionMs: number | undefined;
  reserveMs: number;
}): number {
  if (opts.maxSessionMs === undefined || opts.sessionStartedAt === undefined) return opts.maxHoldMs;
  const sessionLeft = opts.sessionStartedAt + opts.maxSessionMs - opts.reserveMs - opts.now;
  return Math.min(opts.maxHoldMs, sessionLeft);
}
