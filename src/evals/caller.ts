/** What the evals take from the caller's machine (#188): only the OpenAI key, the Postgres server and the git commit. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';

/** OPENAI_API_KEY and DATABASE_URL, from the environment or .env, without applying the rest of .env. */
export function callerBase(): { OPENAI_API_KEY?: string; DATABASE_URL?: string } {
  const path = process.env.DOTENV_CONFIG_PATH ?? '.env';
  const file = path !== '/dev/null' && existsSync(path) ? dotenv.parse(readFileSync(path)) : {};
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || file.OPENAI_API_KEY || undefined,
    DATABASE_URL: process.env.DATABASE_URL || file.DATABASE_URL || undefined,
  };
}

export function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
