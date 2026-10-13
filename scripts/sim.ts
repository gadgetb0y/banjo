#!/usr/bin/env -S npx tsx
/**
 * The text-mode simulator (ROADMAP 4.5): Banjo places a "call" and you type as
 * the business that answers. Everything runs for real — the place_call
 * handler, the orchestrator, the system prompt, the tools, CallSession, rows in
 * Postgres — except the phone line (src/sim/simTelephony.ts), the calendar
 * (src/sim/simCalendar.ts, in memory) and the voice transport (OpenAI Realtime
 * in text-only mode). No phone call is placed, nothing is booked, no one is
 * notified.
 *
 * Needs OPENAI_API_KEY (in .env or the environment) and Postgres:
 * `docker compose up -d postgres`. The sim uses its own `banjo_sim` database on
 * that server, creates and migrates it, and empties it at the start of every
 * run. It never touches the database DATABASE_URL names.
 *
 * Options: see USAGE below, or `npm run sim -- --help`.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { SIM_DATABASE, simEnv } from '../src/sim/env.js';
// Type-only, so erased: nothing here may load src/config before simEnv is applied.
import type { TextVoiceAIProvider } from '../src/sim/simCall.js';
import type { SimTelephonyProvider } from '../src/sim/simTelephony.js';

const USAGE = `Usage: npm run sim -- [options]

Banjo calls a business and you type as whoever answers. No phone call is
placed, no real calendar is written, nobody is notified.

Options:
  --business <name>      Who Banjo is calling. Default: "Claudia's Dog Grooming".
  --category <string>    salon|medical|restaurant|home_services|other. Default: salon.
  --goal <string>        What the call is for. Default: book a grooming appointment.
  --mode <mode>          booking|conversation. Default: booking.
  --duration <minutes>   Appointment length to negotiate. Default: 60.
  --window-days <n>      How many days out Banjo may book. Default: 3.
  --transfer             Offer transfer_to_owner, as with TRANSFER_ENABLED=true.
  --warm                 Make it a warm transfer (TRANSFER_MODE=warm). Implies --transfer.
  --owner <answer>       With --warm: what the owner does. accept|decline|no-answer. Default: accept.
  --script <file>        Read your lines from a file, one per line (# for comments). A line starting
                         with ~ plays 3 seconds after the one before it, without waiting for
                         Banjo: a phone menu or hold queue, which doesn't wait for anyone.
  --verbose              Show the app's info-level logs.
  -h, --help             Show this.

While the call runs: type a line and press Enter to say it. /hangup hangs up
on Banjo; Ctrl+C does the same.`;

const OWNER_ANSWERS = { accept: 'accepted', decline: 'declined', 'no-answer': 'no_answer' } as const;

const CATEGORIES = ['salon', 'medical', 'restaurant', 'home_services', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

/** How long Banjo must stay quiet before a --script run says its next line. */
const SCRIPT_TURN_QUIET_MS = 1500;
/** How long after the line before it a ~ line (a recording: menu, hold queue) plays. */
const SCRIPT_RECORDING_GAP_MS = 3000;
/** After the last scripted line: how long to wait for Banjo to end the call before hanging up on it. */
const SCRIPT_END_QUIET_MS = 15_000;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      business: { type: 'string', default: "Claudia's Dog Grooming" },
      category: { type: 'string', default: 'salon' },
      goal: { type: 'string', default: 'Book a full grooming appointment for my dog, Banjo, a golden retriever.' },
      mode: { type: 'string', default: 'booking' },
      duration: { type: 'string', default: '60' },
      'window-days': { type: 'string', default: '3' },
      transfer: { type: 'boolean', default: false },
      warm: { type: 'boolean', default: false },
      owner: { type: 'string', default: 'accept' },
      script: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const mode = values.mode;
  if (mode !== 'booking' && mode !== 'conversation') fail(`--mode must be "booking" or "conversation" (got "${mode}").`);
  const category = values.category as Category;
  if (!CATEGORIES.includes(category)) fail(`--category must be one of ${CATEGORIES.join(', ')} (got "${values.category}").`);
  const durationMinutes = positiveInt(values.duration, '--duration');
  const windowDays = positiveInt(values['window-days'], '--window-days');
  const scriptLines = values.script ? readScript(values.script) : undefined;

  // .env first, then the sim's own values over it: config reads process.env at
  // import, and dotenv never overwrites what is already set.
  dotenv.config({ path: process.env.DOTENV_CONFIG_PATH, quiet: true });
  const owner = OWNER_ANSWERS[values.owner as keyof typeof OWNER_ANSWERS];
  if (!owner) fail(`--owner must be accept, decline or no-answer (got "${values.owner}").`);
  const transfer = values.transfer || values.warm;
  Object.assign(process.env, simEnv(process.env, { transfer, warm: values.warm, verbose: values.verbose }));
  if (!process.env.OPENAI_API_KEY) fail('OPENAI_API_KEY is not set. Add it to .env or the environment: the sim talks to OpenAI Realtime.');

  await ensureSimDatabase(process.env.DATABASE_URL!);
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  await emptySimDatabase();

  const { config } = await import('../src/config/index.js');
  const { OpenAIRealtimeProvider } = await import('../src/voice/providers/openai.js');
  const { startSimCall } = await import('../src/sim/simCall.js');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'You: ' });
  // Clears the half-typed "You: " line first, then redraws it, so Banjo's lines don't land mid-prompt.
  const interactive = !scriptLines && process.stdout.isTTY;
  const print = (line: string) => {
    if (interactive) process.stdout.write('\r\x1b[2K');
    console.log(line);
    if (interactive) rl.prompt(true);
  };

  console.log(`\nBanjo is calling ${values.business} for ${config.ASSISTANT_PRINCIPAL_NAME}.`);
  console.log(`Goal: ${values.goal}`);
  console.log(`You're answering the phone at ${values.business}. Nothing real is called, booked or sent.`);
  console.log(scriptLines ? `Reading your lines from ${values.script}.\n` : 'Type what you say and press Enter. /hangup hangs up.\n');

  const call = await startSimCall({
    business: values.business,
    category,
    goal: values.goal,
    mode,
    durationMinutes,
    windowDays,
    createVoiceAI: () => new OpenAIRealtimeProvider({ textOnly: true }),
    owner,
    print,
  });
  process.on('SIGINT', () => call.telephony.calleeHangsUp());

  const voice = await call.ready;
  if (voice) {
    console.log('[The phone rings. You pick up.]');
    if (scriptLines) {
      runScript(scriptLines, voice, call.telephony, print);
    } else {
      rl.on('line', (line) => {
        const text = line.trim();
        if (text === '/hangup') call.telephony.calleeHangsUp();
        else if (text) voice.sendUserText(text);
        else rl.prompt();
      });
      rl.prompt();
    }
  }

  const task = await call.finished;
  rl.close();
  console.log('\n--- outcome ---');
  console.log(`Task status: ${task.status}`);
  console.log(JSON.stringify(task.outcome, null, 2));
  console.log(call.calendar.events.length ? `Calendar (dry run): ${call.calendar.events.map((e) => e.summary).join('; ')}` : 'Calendar: nothing booked.');
  console.log(`The transcript and task are in the ${SIM_DATABASE} database until the next run.`);
  process.exit(0);
}

/**
 * Says each scripted line once Banjo has spoken and gone quiet, then hangs up
 * if Banjo hasn't ended the call itself soon after the last one.
 */
function runScript(
  lines: string[],
  voice: TextVoiceAIProvider,
  telephony: SimTelephonyProvider,
  print: (line: string) => void,
): void {
  let next = 0;
  let banjoSpoke = false;
  let timer: NodeJS.Timeout | undefined;
  const isRecording = (line: string) => line.startsWith('~');
  const say = () => {
    const raw = lines[next++]!;
    const line = isRecording(raw) ? raw.slice(1).trim() : raw;
    print(`You: ${line}`);
    banjoSpoke = false;
    voice.sendUserText(line);
  };
  const schedule = () => {
    clearTimeout(timer);
    if (next < lines.length && isRecording(lines[next]!)) {
      // A recording plays on regardless of Banjo, on its own clock.
      timer = setTimeout(() => {
        if (over) return;
        say();
        schedule();
      }, SCRIPT_RECORDING_GAP_MS);
    } else if (next < lines.length) {
      timer = setTimeout(() => banjoSpoke && say(), SCRIPT_TURN_QUIET_MS);
    } else {
      timer = setTimeout(() => {
        print('[End of script.]');
        telephony.calleeHangsUp();
      }, SCRIPT_END_QUIET_MS);
    }
  };
  let over = false;
  voice.on('event', (event) => {
    if (event.type === 'transcript' && event.role === 'assistant') banjoSpoke = true;
    if (!over) schedule();
  });
  // Nothing more to say once the line is dead, whoever hung up.
  telephony.on('event', (event) => {
    if (event.type !== 'ended') return;
    over = true;
    clearTimeout(timer);
  });
  // The callee speaks first on an outbound call.
  say();
  schedule();
}

/** Creates banjo_sim on the configured server if it isn't there yet. */
async function ensureSimDatabase(simUrl: string): Promise<void> {
  const url = new URL(simUrl);
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await admin`select 1 as ok from pg_database where datname = ${SIM_DATABASE}`;
    if (!row) await admin.unsafe(`create database ${SIM_DATABASE}`);
  } catch (err) {
    const where = `${url.hostname}:${url.port || 5432}`;
    fail(`Can't reach Postgres at ${where} (${(err as Error).message}). Start it with: docker compose up -d postgres`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Every table in banjo_sim, emptied — after checking it really is banjo_sim. */
async function emptySimDatabase(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../src/db/index.js');
  const [{ name }] = (await db.execute(sql`select current_database() as name`)) as unknown as [{ name: string }];
  if (name !== SIM_DATABASE) fail(`Refusing to empty "${name}": the sim only ever clears ${SIM_DATABASE}.`);
  const tables = (await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { tablename: string }[];
  if (!tables.length) return;
  const list = tables.map(({ tablename }) => `"${tablename.replace(/"/g, '""')}"`).join(', ');
  await db.execute(sql.raw(`truncate ${list} restart identity cascade`));
}

function readScript(path: string): string[] {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!lines.length) fail(`--script ${path} has no lines.`);
  return lines;
}

function positiveInt(value: string | undefined, flag: string): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(n) || n <= 0) fail(`${flag} must be a positive whole number (got "${value}").`);
  return n;
}

function fail(message: string): never {
  console.error(`sim: ${message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('sim failed:', err);
  process.exit(1);
});
