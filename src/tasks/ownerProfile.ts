import { readFileSync } from 'node:fs';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

/**
 * Every outbound call pays for this text in the prompt, and a profile long
 * enough to need cutting is one where the cut could drop the line that
 * mattered — so it is refused, not truncated.
 */
export const OWNER_PROFILE_MAX_CHARS = 4000;

/**
 * The owner's own standing notes for every call (PROMPT_PROFILE_FILE): facts
 * about them ("Banjo is a doodle, nervous with clippers"), and how they want
 * calls to sound. The customizable layer of the prompt — it sits below the
 * rules in voice/systemPrompt.ts and promptBuilder.ts, which it cannot
 * override (see ownerProfileSection there).
 *
 * Throws. Used at boot so a wrong path or an oversized file stops the deploy
 * instead of being discovered on a live call.
 */
export function loadOwnerProfile(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `PROMPT_PROFILE_FILE: could not read "${path}" (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const trimmed = text.trim();
  if (trimmed.length > OWNER_PROFILE_MAX_CHARS) {
    throw new Error(
      `PROMPT_PROFILE_FILE: "${path}" is ${trimmed.length} characters; the limit is ${OWNER_PROFILE_MAX_CHARS}. Keep it to what a call actually needs.`,
    );
  }
  return trimmed;
}

/**
 * Per-call read: re-read every time so edits apply without a restart, and
 * never fail a call over it — a profile that broke after boot is logged and
 * the call goes ahead on the fixed rules alone.
 */
export function readOwnerProfile(path: string | undefined = config.PROMPT_PROFILE_FILE): string | undefined {
  if (!path) return undefined;
  try {
    return loadOwnerProfile(path) || undefined;
  } catch (err) {
    logger.error({ err }, 'owner profile unreadable — placing this call without it');
    return undefined;
  }
}
