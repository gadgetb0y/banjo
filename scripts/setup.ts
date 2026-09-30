#!/usr/bin/env -S npx tsx
/**
 * Interactive setup (#39): writes a .env by asking for what the chosen
 * providers need, instead of hand-editing .env.example.
 *
 * - Asks only for required values; Google Calendar/Contacts stays optional.
 * - Generates MCP_API_KEY itself.
 * - Checks each answer as it's typed (E.164 numbers, a bare PUBLIC_HOSTNAME, ...).
 * - Optionally checks the Twilio credentials against Twilio's API.
 * - Runs the app's own config validation before writing anything, so a bad
 *   .env fails here, not on the first call.
 * - Never replaces an existing .env without asking, and backs it up first.
 *   Re-running offers the current values as defaults.
 *
 * Usage: npm run setup
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import {
  backupName,
  E164,
  HOSTNAME,
  renderEnvFile,
  REQUIRED,
  TIMEZONE,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  validateWithAppConfig,
  type Validator,
} from './setup/lib.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(repoRoot, '.env');
const rl = createInterface({ input: stdin, output: stdout });
// One iterator over every line typed or piped in. readline/promises'
// question() drops lines that arrive before it's called, which is all of them
// when answers are piped in.
const lines = rl[Symbol.asyncIterator]();

/** Shows `question` and returns the next line of input. */
async function prompt(question: string): Promise<string> {
  rl.setPrompt(question);
  rl.prompt();
  const next = await lines.next();
  if (next.done) throw new Error('Input ended before setup finished; nothing was written.');
  return next.value;
}

/** Masks a secret shown as a default, so re-running setup doesn't print it. */
const mask = (value: string) => (value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '…');

async function ask(question: string, opts: { current?: string; validate?: Validator; secret?: boolean } = {}): Promise<string> {
  const { current, validate, secret } = opts;
  const hint = current ? ` [${secret ? mask(current) : current}]` : '';
  for (;;) {
    const answer = (await prompt(`${question}${hint}: `)).trim() || current || '';
    const problem = validate?.(answer);
    if (!problem) return answer;
    console.log(`  ${problem}`);
  }
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await prompt(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
  return answer ? answer.startsWith('y') : defaultYes;
}

async function choose<T extends string>(question: string, options: readonly T[], current?: string): Promise<T> {
  const fallback = options.includes(current as T) ? (current as T) : options[0]!;
  for (;;) {
    const answer = (await prompt(`${question} (${options.join(' / ')}) [${fallback}]: `)).trim() || fallback;
    if (options.includes(answer as T)) return answer as T;
    console.log(`  Pick one of: ${options.join(', ')}.`);
  }
}

/** Checks the Twilio SID and token against Twilio, and that the number is on that account. */
async function checkTwilio(sid: string, token: string, phoneNumber: string): Promise<void> {
  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  try {
    const account = await fetch(`${base}.json`, { headers: { Authorization: auth } });
    if (account.status === 401) {
      console.log('  ✘ Twilio rejected the Account SID and Auth Token. Check both in the Twilio console.');
      return;
    }
    if (!account.ok) {
      console.log(`  ? Twilio answered ${account.status}; couldn't confirm the credentials.`);
      return;
    }
    const numbers = await fetch(`${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`, {
      headers: { Authorization: auth },
    });
    const body = (await numbers.json()) as { incoming_phone_numbers?: unknown[] };
    if (body.incoming_phone_numbers?.length) console.log('  ✔ Twilio credentials work, and the number is on this account.');
    else console.log(`  ✘ The credentials work, but ${phoneNumber} isn't a number on this Twilio account.`);
  } catch (err) {
    console.log(`  ? Couldn't reach Twilio (${err instanceof Error ? err.message : String(err)}); skipping the check.`);
  }
}

async function main(): Promise<void> {
  console.log('Banjo setup — writes .env. Press Enter to accept the value in [brackets].\n');

  let current: Record<string, string> = {};
  if (existsSync(envPath)) {
    if (!(await confirm('A .env already exists. Replace it? (It is backed up first.)', false))) {
      console.log('Left .env unchanged.');
      return;
    }
    current = parse(readFileSync(envPath));
  }

  const values: Record<string, string> = {};

  console.log('\n— You —');
  values.ASSISTANT_PRINCIPAL_NAME = await ask('Your name, as Banjo says it on calls', { current: current.ASSISTANT_PRINCIPAL_NAME, validate: REQUIRED });
  values.CALENDAR_TIMEZONE = await ask('Your time zone', { current: current.CALENDAR_TIMEZONE ?? 'America/New_York', validate: TIMEZONE });

  console.log('\n— Voice AI —');
  const provider = await choose('Voice AI provider', ['openai', 'openai-live', 'gemini', 'elevenlabs'] as const, current.VOICE_AI_PROVIDER);
  values.VOICE_AI_PROVIDER = provider;
  if (provider === 'openai' || provider === 'openai-live') {
    values.OPENAI_API_KEY = await ask('OpenAI API key', { current: current.OPENAI_API_KEY, validate: REQUIRED, secret: true });
  } else if (provider === 'gemini') {
    values.GEMINI_API_KEY = await ask('Gemini API key', { current: current.GEMINI_API_KEY, validate: REQUIRED, secret: true });
  } else {
    values.ELEVENLABS_API_KEY = await ask('ElevenLabs API key', { current: current.ELEVENLABS_API_KEY, validate: REQUIRED, secret: true });
    values.ELEVENLABS_AGENT_ID = await ask('ElevenLabs agent ID', { current: current.ELEVENLABS_AGENT_ID, validate: REQUIRED });
  }

  console.log('\n— Twilio (console.twilio.com, home page) —');
  values.TWILIO_ACCOUNT_SID = await ask('Account SID', { current: current.TWILIO_ACCOUNT_SID, validate: TWILIO_ACCOUNT_SID });
  values.TWILIO_AUTH_TOKEN = await ask('Auth Token', { current: current.TWILIO_AUTH_TOKEN, validate: TWILIO_AUTH_TOKEN, secret: true });
  values.TWILIO_PHONE_NUMBER = await ask("Banjo's Twilio phone number", { current: current.TWILIO_PHONE_NUMBER, validate: E164 });
  if (await confirm('Check these with Twilio now?', true)) {
    await checkTwilio(values.TWILIO_ACCOUNT_SID, values.TWILIO_AUTH_TOKEN, values.TWILIO_PHONE_NUMBER);
  }

  console.log('\n— Public address —');
  console.log('Twilio connects back to Banjo here: your tunnel or server hostname, no https://.');
  values.PUBLIC_HOSTNAME = await ask('PUBLIC_HOSTNAME', { current: current.PUBLIC_HOSTNAME, validate: HOSTNAME });

  console.log('\n— Call outcome notifications —');
  const channel = await choose('Send outcomes by', ['twilio_sms', 'none'] as const, current.NOTIFICATION_CHANNEL);
  values.NOTIFICATION_CHANNEL = channel;
  if (channel === 'twilio_sms') {
    values.NOTIFY_TO_PHONE_NUMBER = await ask('Your mobile number (texts go here)', { current: current.NOTIFY_TO_PHONE_NUMBER, validate: E164 });
    values.NOTIFY_FROM_PHONE_NUMBER = await ask('Send texts from', {
      current: current.NOTIFY_FROM_PHONE_NUMBER ?? values.TWILIO_PHONE_NUMBER,
      validate: E164,
    });
    console.log('  Texts to US numbers need A2P 10DLC registration; see docs/RUNBOOKS.md, "SMS notifications aren\'t arriving".');
  } else {
    // Otherwise a value kept from the old .env would still be written.
    values.NOTIFY_TO_PHONE_NUMBER = '';
    values.NOTIFY_FROM_PHONE_NUMBER = '';
  }

  console.log('\n— Google Calendar and Contacts (optional) —');
  const hasGoogle = !!(current.GOOGLE_OAUTH_CLIENT_ID && current.GOOGLE_OAUTH_REFRESH_TOKEN);
  if (await confirm('Set up Google now? (See docs/RUNBOOKS.md, "Minting GOOGLE_OAUTH_REFRESH_TOKEN".)', hasGoogle)) {
    values.GOOGLE_OAUTH_CLIENT_ID = await ask('OAuth client ID', { current: current.GOOGLE_OAUTH_CLIENT_ID, validate: REQUIRED });
    values.GOOGLE_OAUTH_CLIENT_SECRET = await ask('OAuth client secret', { current: current.GOOGLE_OAUTH_CLIENT_SECRET, validate: REQUIRED, secret: true });
    values.GOOGLE_OAUTH_REFRESH_TOKEN = await ask('Refresh token', { current: current.GOOGLE_OAUTH_REFRESH_TOKEN, validate: REQUIRED, secret: true });
  } else if (hasGoogle) {
    console.log('  Keeping the Google settings already in .env.');
  } else {
    console.log('  Skipped. Calendar and Contacts stay off until you add them; the rest of Banjo works without them.');
  }

  // Settings this script doesn't ask about keep their current values.
  const merged: Record<string, string> = { ...current, ...values, MCP_API_KEY: current.MCP_API_KEY || randomBytes(32).toString('hex') };
  for (const key of Object.keys(merged)) if (merged[key] === '') delete merged[key];
  const envText = renderEnvFile(readFileSync(path.join(repoRoot, '.env.example'), 'utf8'), merged);

  console.log('\nChecking the settings with the same validation Banjo runs at startup…');
  const problems = validateWithAppConfig(envText, repoRoot);
  if (problems.length) {
    const draftPath = path.join(repoRoot, '.env.bak-draft');
    writeFileSync(draftPath, envText, { mode: 0o600 });
    console.log('✘ Banjo would not start with these settings:');
    for (const p of problems) console.log(`  - ${p.setting ? `${p.setting}: ` : ''}${p.message}`);
    console.log(`\n.env was not changed. Your answers are saved in ${path.basename(draftPath)}; fix them and run npm run setup again.`);
    process.exitCode = 1;
    return;
  }

  if (existsSync(envPath)) {
    const backup = backupName();
    copyFileSync(envPath, path.join(repoRoot, backup));
    console.log(`Backed up the old .env to ${backup}.`);
  }
  writeFileSync(envPath, envText, { mode: 0o600 });
  console.log('✔ Wrote .env. Next: docker compose up (or npm run dev).');
  if (!current.MCP_API_KEY) {
    console.log('  MCP_API_KEY was generated; give it to Claude Code as the Bearer token when you add the banjo MCP server.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
