/**
 * The one environment every eval run uses, live or replayed (#188). Like
 * src/sim/env.ts, it imports nothing from the app: it's applied before
 * src/config is imported.
 *
 * Fixed and fictional, whatever .env says: who Banjo calls for, what it opens
 * with, the timezone, the model and the owner profile. That keeps a real name
 * or profile out of committed recordings, makes a recording's prompt the same
 * on every machine and in CI, and makes runs comparable. Only OPENAI_API_KEY
 * and the Postgres server come from the caller's environment.
 */
import { fileURLToPath } from 'node:url';
import type { LoopInResult } from '../telephony/providers/types.js';
import { simEnv } from '../sim/env.js';

export const EVAL_PROFILE_FILE = fileURLToPath(new URL('../../evals/fixtures/owner-profile.md', import.meta.url));

export const EVAL_FIXED_ENV: Readonly<Record<string, string>> = {
  ASSISTANT_PRINCIPAL_NAME: 'Alex',
  // Config's default, spelled out: config rejects an empty value.
  DISCLOSURE_LINE: "Hi, I'm an AI assistant calling on behalf of {name}.",
  CALENDAR_TIMEZONE: 'America/New_York',
  OPENAI_REALTIME_MODEL: 'gpt-realtime',
  PROMPT_PROFILE_FILE: EVAL_PROFILE_FILE,
  MCP_AGENT_API_KEY: '',
};

/** What a scenario turns on, in the sim CLI's terms (--transfer, --warm, --owner, --ask-owner). */
export interface ScenarioFlags {
  transfer: boolean;
  warm: boolean;
  owner: 'accept' | 'decline' | 'no-answer';
  /** What the owner answers any ask_owner question with; null never answers. Unset: ask_owner is off. */
  askOwner?: string | null;
}

/** --owner's answers, as the sim's phone line reports a warm transfer's outcome. */
export const OWNER_ANSWERS: Record<ScenarioFlags['owner'], LoopInResult> = { accept: 'accepted', decline: 'declined', 'no-answer': 'no_answer' };

export function evalEnv(
  base: Record<string, string | undefined>,
  flags: ScenarioFlags & { env?: Record<string, string> },
): Record<string, string> {
  const sim = simEnv(
    { OPENAI_API_KEY: base.OPENAI_API_KEY, DATABASE_URL: base.DATABASE_URL },
    { transfer: flags.transfer || flags.warm, warm: flags.warm, askOwner: flags.askOwner !== undefined, verbose: false },
  );
  return {
    ...sim,
    ...(base.OPENAI_API_KEY ? { OPENAI_API_KEY: base.OPENAI_API_KEY } : {}),
    ...EVAL_FIXED_ENV,
    ...flags.env,
  };
}
