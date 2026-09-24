/**
 * How much to trust a finalised transcript turn (#25).
 *
 * The transcriber sometimes finalises turns nobody spoke: empty strings, and
 * text invented from line noise, in scripts the call was never in — Santali
 * ("ᱤᱠ") and Korean ("아...") on two calls on 2026-09-22. They used to arm the
 * silence watchdog like real speech, and they would be stored as a record of
 * what the other party said once transcripts are persisted (#6), where a
 * confident fabrication is worse than a gap. #6 should store this label.
 *
 * - empty:   no text at all. Nothing was said; ignore it.
 * - suspect: punctuation/symbols only, or letters with none in Latin script.
 *            Banjo's prompts and calls are English-only today; revisit this
 *            rule if a call-language setting is added. Flagged, not dropped,
 *            so a wrong guess costs little.
 * - ok:      anything else. Short fillers ("Uh.") and plausible-but-wrong
 *            English ("literally with every") pass — no cheap heuristic
 *            catches those without also catching real speech.
 */
export type TranscriptQuality = 'empty' | 'suspect' | 'ok';

export function classifyTranscript(text: string): TranscriptQuality {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return 'suspect';
  if (/\p{L}/u.test(trimmed) && !/\p{Script=Latin}/u.test(trimmed) && !/\p{N}/u.test(trimmed)) return 'suspect';
  return 'ok';
}
