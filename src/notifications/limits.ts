/**
 * The longest message each owner channel delivers. Kept apart from the
 * channels so channel.ts can size summaries from them without importing a
 * channel module that imports channel.ts back.
 */

/** Pushover's documented limit; pushover.ts clips anything longer. */
export const PUSHOVER_MAX_MESSAGE_CHARS = 1024;

/**
 * Twilio's limit for one message body. Longer is rejected outright (error
 * 21617), not split, so the owner gets nothing.
 */
export const SMS_MAX_CHARS = 1600;

/**
 * Cuts text to at most `max` characters, ending in an ellipsis when it cut
 * anything, and never between the two halves of a surrogate pair.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 1) return '';
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}
