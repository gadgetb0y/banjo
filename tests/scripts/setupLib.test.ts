import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';
import {
  backupName,
  E164,
  HOSTNAME,
  renderEnvFile,
  TIMEZONE,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  validateWithAppConfig,
} from '../../scripts/setup/lib.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const template = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

/** What npm run setup writes for a minimal OpenAI + Twilio install with SMS off. */
const answers = {
  ASSISTANT_PRINCIPAL_NAME: 'Alex Rivera',
  CALENDAR_TIMEZONE: 'America/Chicago',
  VOICE_AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'sk-test-key',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'b'.repeat(32),
  TWILIO_PHONE_NUMBER: '+15551230000',
  PUBLIC_HOSTNAME: 'banjo.example.com',
  NOTIFICATION_CHANNEL: 'none',
  MCP_API_KEY: 'c'.repeat(64),
};

describe('setup validators (#39)', () => {
  it('catches the mistakes that otherwise only show up as a failed call', () => {
    expect(E164('+15551234567')).toBeUndefined();
    expect(E164('555-123-4567')).toMatch(/E\.164/);
    expect(E164('15551234567')).toMatch(/E\.164/);

    expect(HOSTNAME('banjo.example.com')).toBeUndefined();
    expect(HOSTNAME('https://banjo.example.com')).toMatch(/https:\/\//);
    expect(HOSTNAME('banjo.example.com/')).toMatch(/path/);
    expect(HOSTNAME('your-alb-or-ngrok-hostname.example.com')).toMatch(/placeholder/);
    expect(HOSTNAME('localhost')).toMatch(/valid hostname/);

    expect(TWILIO_ACCOUNT_SID(`AC${'0'.repeat(32)}`)).toBeUndefined();
    expect(TWILIO_ACCOUNT_SID(`SK${'0'.repeat(32)}`)).toMatch(/AC/);
    expect(TWILIO_AUTH_TOKEN('f'.repeat(32))).toBeUndefined();
    expect(TWILIO_AUTH_TOKEN('f'.repeat(31))).toMatch(/32/);

    expect(TIMEZONE('Europe/London')).toBeUndefined();
    expect(TIMEZONE('Eastern')).toMatch(/IANA/);
  });
});

describe('renderEnvFile (#39)', () => {
  it("fills in the template's own lines, keeps its comments, and comments out values left empty", () => {
    const out = renderEnvFile(template, answers);
    const parsed = parse(out);

    expect(parsed.ASSISTANT_PRINCIPAL_NAME).toBe('Alex Rivera');
    expect(parsed.PUBLIC_HOSTNAME).toBe('banjo.example.com');
    expect(parsed.PORT).toBe('3000'); // untouched template default
    expect(out).toContain('# --- Inbound voice booking line ---'); // comments survive
    // Each key is written once, where the template has it.
    expect(out.match(/^TWILIO_ACCOUNT_SID=/gm)).toHaveLength(1);
    // An empty template value becomes a commented line, not an empty setting.
    expect(out).toMatch(/^# NOTIFY_TO_PHONE_NUMBER=$/m);
    expect(parsed).not.toHaveProperty('NOTIFY_TO_PHONE_NUMBER');
  });

  it('uncomments a commented-out template line, quotes values dotenv would misread, and appends unknown keys', () => {
    const out = renderEnvFile(template, {
      TRANSFER_TO_PHONE_NUMBER: '+15557654321',
      DISCLOSURE_LINE: "Hi, I'm an AI assistant calling for #1 fan \"Alex\".",
      SOMETHING_NEW: 'x',
    });
    const parsed = parse(out);

    expect(out).toMatch(/^TRANSFER_TO_PHONE_NUMBER=\+15557654321$/m);
    expect(parsed.DISCLOSURE_LINE).toBe("Hi, I'm an AI assistant calling for #1 fan \"Alex\".");
    expect(out).toMatch(/# Added by npm run setup\nSOMETHING_NEW=x/);
  });
});

describe('validateWithAppConfig (#39)', () => {
  it("accepts what setup writes for a minimal install, using the app's own schema", () => {
    expect(validateWithAppConfig(renderEnvFile(template, answers), repoRoot)).toEqual([]);
  }, 30_000);

  it('reports the setting and message the app would have failed on at startup', () => {
    const { MCP_API_KEY: _, ...withoutKey } = answers;
    const problems = validateWithAppConfig(renderEnvFile(template, { ...withoutKey, MCP_API_KEY: 'too-short' }), repoRoot);
    expect(problems).toEqual([expect.objectContaining({ setting: 'MCP_API_KEY', message: expect.stringMatching(/32 characters/) })]);
  }, 30_000);
});

describe('backupName', () => {
  it('is a timestamped name git already ignores (.env.bak*)', () => {
    expect(backupName(new Date('2026-09-29T21:34:19.519Z'))).toBe('.env.bak-20260929-213419');
  });
});
