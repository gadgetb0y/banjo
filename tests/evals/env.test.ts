import { describe, expect, it } from 'vitest';
import { evalEnv } from '../../src/evals/env.js';

const flags = { transfer: false, warm: false, owner: 'accept' as const };

describe('evalEnv', () => {
  it("ignores the owner's real name and profile from .env", () => {
    const env = evalEnv({ ASSISTANT_PRINCIPAL_NAME: 'Steve Real', PROMPT_PROFILE_FILE: '/home/me/profile.md' }, flags);
    expect(env.ASSISTANT_PRINCIPAL_NAME).toBe('Alex');
    expect(env.PROMPT_PROFILE_FILE).toMatch(/evals\/fixtures\/owner-profile\.md$/);
  });

  it('keeps OPENAI_API_KEY and points at banjo_sim', () => {
    const env = evalEnv({ OPENAI_API_KEY: 'sk-real', DATABASE_URL: 'postgresql://u:p@db:5432/banjo' }, flags);
    expect(env.OPENAI_API_KEY).toBe('sk-real');
    expect(env.DATABASE_URL).toMatch(/\/banjo_sim$/);
  });

  it("never takes the disclosure line, timezone or model from .env", () => {
    const env = evalEnv({ DISCLOSURE_LINE: 'Hi, AI here for Steve.', CALENDAR_TIMEZONE: 'Europe/Paris', OPENAI_REALTIME_MODEL: 'gpt-x' }, flags);
    expect(env.DISCLOSURE_LINE).toBe("Hi, I'm an AI assistant calling on behalf of {name}.");
    expect(env.CALENDAR_TIMEZONE).toBe('America/New_York');
    expect(env.OPENAI_REALTIME_MODEL).toBe('gpt-realtime');
  });

  it("a scenario's env override wins", () => {
    const env = evalEnv({}, { ...flags, env: { CALENDAR_TIMEZONE: 'America/Los_Angeles' } });
    expect(env.CALENDAR_TIMEZONE).toBe('America/Los_Angeles');
  });

  it('ask_owner flag turns ask_owner on', () => {
    expect(evalEnv({}, { ...flags, askOwner: 'Yes, that works.' }).ASK_OWNER_ENABLED).toBe('true');
    expect(evalEnv({}, { ...flags, askOwner: null }).ASK_OWNER_ENABLED).toBe('true');
    expect(evalEnv({}, flags).ASK_OWNER_ENABLED).toBe('false');
  });
});
