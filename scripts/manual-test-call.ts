#!/usr/bin/env -S npx tsx
/**
 * Manual, ad-hoc script for exercising a real outbound call end-to-end
 * without going through the MCP layer — it seeds/reuses a contact, calls the
 * exact same placeCallHandler() the place_call MCP tool wraps, then polls
 * task status and prints it as the call progresses.
 *
 * Deliberately bypasses the MCP transport (mcp/server.ts) so this
 * script's correctness doesn't depend on that layer — it calls the
 * underlying handler function directly. To test the MCP transport itself,
 * point a real MCP client (e.g. Claude Code) at the running server's
 * /mcp endpoint instead.
 *
 * This script STARTS THE SERVER ITSELF (same startServer()/startOrchestrationPoller()
 * as src/index.ts) in-process, because TwilioProvider keeps its per-call
 * state (the WebSocket for an in-progress media stream) in memory — the
 * process that originates the call must be the same process whose HTTP
 * server receives Twilio's media-stream WebSocket connection back. Do NOT
 * run this alongside a separately-running `npm run dev` on the same port.
 *
 * THIS PLACES A REAL PHONE CALL. Requires PUBLIC_HOSTNAME to point at a
 * publicly reachable tunnel (e.g. `ngrok http $PORT`) so Twilio can reach
 * this process for the TwiML webhook and media-stream WebSocket.
 *
 * Usage:
 *   npx tsx scripts/manual-test-call.ts --phone "+15551234567" [options]
 *   npx tsx scripts/manual-test-call.ts --phone "+15551234567" --mode ask --question "Are you open Sunday?"
 *
 * It goes through placeCallHandler, so the per-number call cap
 * (MAX_CALLS_PER_NUMBER_PER_DAY) applies as it does to place_call.
 *
 * Options:
 *   --phone <e164>         Required (unless --contact-id given). Number to call.
 *   --name <string>        Contact display name. Default: "Manual Test Contact".
 *   --contact-id <uuid>    Reuse an existing contact instead of creating one.
 *   --category <string>    salon|medical|restaurant|home_services|other. Default: other.
 *   --goal <string>        Task description read into the call's system prompt.
 *   --mode <mode>          booking|conversation|ask. Default: booking. Use conversation for a call
 *                          with no booking goal — it ends via end_conversation_call. Use ask to
 *                          find something out (#148): give the questions with --question.
 *   --question <text>      With --mode ask: something Banjo should find out, on one line. Repeat
 *                          for more than one (at most 5). Checked as place_call checks them.
 *   --at <datetime>        Place the call no earlier than this local date-time in CALENDAR_TIMEZONE,
 *                          e.g. "2026-09-14T09:00:00". The script keeps its server running until then.
 *   --notes <string>       Extra context injected into the call system prompt.
 *   --duration <minutes>   Appointment duration to negotiate. Default: 15. Not used by --mode ask.
 *   --window-days <n>      How many days out the offerable window extends. Default: 3. Not used by --mode ask.
 *   --yes                  Skip the interactive confirmation prompt.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { config } from '../src/config/index.js';
import { addContact, findContact } from '../src/contacts/service.js';
import { db } from '../src/db/index.js';
import { logger } from '../src/lib/logger.js';
import { startServer } from '../src/server.js';
import { callAttempts } from '../src/tasks/schema.js';
import { getTask, isTerminalStatus } from '../src/tasks/service.js';
import { startOrchestrationPoller } from '../src/tasks/orchestrator.js';
import { placeCallHandler } from '../src/mcp/tools/placeCall.js';
import { buildPlaceCallInput, type ManualCallInput } from './manual-test-call/lib.js';

async function main() {
  const { values } = parseArgs({
    options: {
      phone: { type: 'string' },
      name: { type: 'string', default: 'Manual Test Contact' },
      'contact-id': { type: 'string' },
      category: { type: 'string', default: 'other' },
      // Defaults to a test goal for the mode: see manual-test-call/lib.ts.
      goal: { type: 'string' },
      mode: { type: 'string', default: 'booking' },
      question: { type: 'string', multiple: true },
      at: { type: 'string' },
      notes: { type: 'string', default: '' },
      duration: { type: 'string', default: '15' },
      'window-days': { type: 'string', default: '3' },
      yes: { type: 'boolean', default: false },
    },
  });

  if (!values['contact-id'] && !values.phone) {
    console.error('Error: --phone is required unless --contact-id is given.\n');
    console.error('Usage: npx tsx scripts/manual-test-call.ts --phone "+15551234567" [--goal "..."] [--yes]');
    process.exit(1);
  }
  // Checked before anything is created or started, with place_call's own rules.
  let input: ManualCallInput;
  try {
    input = buildPlaceCallInput({
      mode: values.mode,
      goal: values.goal,
      question: values.question,
      notes: values.notes,
      duration: values.duration,
      windowDays: values['window-days'],
      at: values.at,
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log('\n--- ea manual test call ---');
  console.log(`Telephony provider: twilio`);
  console.log(`Voice AI provider:  ${config.VOICE_AI_PROVIDER}`);
  console.log(`Public hostname:    ${config.PUBLIC_HOSTNAME ?? '(not set — Twilio will not be able to reach this process!)'}`);
  console.log(`Target:             ${values['contact-id'] ? `existing contact ${values['contact-id']}` : `${values.name} <${values.phone}>`}`);
  console.log(`Mode:               ${input.mode}`);
  console.log(`Goal:               ${input.taskDescription}`);
  input.questions?.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  console.log(`Scheduled for:      ${values.at ? `${values.at} (${config.CALENDAR_TIMEZONE})` : '(now)'}`);
  console.log('----------------------------\n');

  if (!values.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('This will place a REAL outbound phone call. Continue? [y/N] ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Same startup sequence as src/index.ts — must run in this process so the
  // TwilioProvider instance that originates the call is the same one that
  // receives the media-stream WebSocket connection back from Twilio.
  startServer();
  startOrchestrationPoller();

  const contactId = await resolveContactId(values);

  // The same handler as place_call, so the per-number call cap applies.
  const { taskId, ackMessage } = await placeCallHandler({ contactId, ...input });

  console.log(`\nTask created: ${taskId}`);
  console.log(`${ackMessage}\n`);
  console.log('Watching task status (server logs above/below are the structured pino logs from the live call)...\n');

  await pollUntilTerminal(taskId);
}

async function resolveContactId(values: Record<string, string | string[] | boolean | undefined>): Promise<string> {
  if (values['contact-id']) return values['contact-id'] as string;

  const name = values.name as string;
  const { bestMatch } = await findContact(name);
  if (bestMatch && bestMatch.phoneNumber === values.phone) {
    console.log(`Reusing existing contact "${bestMatch.displayName}" (${bestMatch.id})`);
    return bestMatch.id;
  }

  const contact = await addContact({
    displayName: name,
    phoneNumber: values.phone as string,
    category: values.category as never, // validated against the DB enum on insert
    notes: (values.notes as string) || undefined,
  });
  console.log(`Created contact "${contact.displayName}" (${contact.id})`);
  return contact.id;
}

async function pollUntilTerminal(taskId: string): Promise<void> {
  let lastStatus: string | null = null;

  // No hard timeout by default — a live call can take a few minutes, and
  // exiting this process would kill the server (and the in-progress call)
  // out from under it. Ctrl+C when you're done watching; that's the
  // deliberate way to end this script (and the underlying call, if still live).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const task = await getTask(taskId);
    if (!task) {
      console.log('Task disappeared — exiting.');
      return;
    }
    if (task.status !== lastStatus) {
      console.log(`[${new Date().toISOString()}] status -> ${task.status}`);
      lastStatus = task.status;
    }
    if (isTerminalStatus(task.status)) {
      await waitForCallToEnd(taskId);
      const final = (await getTask(taskId)) ?? task;
      console.log('\n--- final outcome ---');
      console.log(JSON.stringify({ status: final.status, outcome: final.outcome, calendarEventId: final.calendarEventId }, null, 2));
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

/**
 * A task can reach a terminal status while its call is still live — e.g.
 * confirm_appointment marks it confirmed, and the model still has to read the
 * booking back and say goodbye. Exiting at that point kills the in-process
 * server (and the call) mid-sentence, and loses the Voice AI adapter's
 * end-of-call log lines. Waits for every call attempt on the task to record an
 * end time first, bounded so a stuck attempt can't hang the script forever.
 */
const CALL_END_WAIT_MAX_MS = 10 * 60 * 1000;

async function waitForCallToEnd(taskId: string): Promise<void> {
  const deadline = Date.now() + CALL_END_WAIT_MAX_MS;
  while (Date.now() < deadline) {
    const attempts = await db.select({ endedAt: callAttempts.endedAt }).from(callAttempts).where(eq(callAttempts.taskId, taskId));
    if (attempts.every((attempt) => attempt.endedAt)) {
      // A moment for the adapter's end-of-call summary line to flush.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log('Call still not marked ended after 10 minutes — exiting anyway.');
}

main().catch((err) => {
  logger.error({ err }, 'manual-test-call failed');
  process.exit(1);
});
