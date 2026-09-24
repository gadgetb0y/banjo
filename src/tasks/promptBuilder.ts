import type { Contact } from '../contacts/schema.js';
import { config } from '../config/index.js';
import { buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance } from '../voice/systemPrompt.js';
import type { Task, TimeWindow } from './schema.js';

/**
 * Candidate windows arrive as UTC ISO instants, one per appointment-length
 * slot. They used to go into the prompt exactly like that — beside a timezone
 * rule saying every time is local. A demo call (2026-09-23), asked for
 * something after Thursday 3:30, offered "around 4:00 or 5:30": the UTC slot
 * starts 16:00 and 17:30, read as local. So: local time, spoken-style, with
 * back-to-back slots merged into the stretch of free time they came from
 * (a 90-minute grid also hid that 10:00 was as free as 9:00 and 10:30).
 */
function formatWindows(windows: TimeWindow[]): string {
  if (windows.length === 0) return '(no pre-checked windows — always use check_my_availability before agreeing to a time)';

  const sorted = [...windows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const ranges: TimeWindow[] = [];
  for (const w of sorted) {
    const last = ranges.at(-1);
    if (last && Date.parse(w.start) <= Date.parse(last.end)) {
      if (Date.parse(w.end) > Date.parse(last.end)) last.end = w.end;
    } else {
      ranges.push({ ...w });
    }
  }

  const day = new Intl.DateTimeFormat('en-US', { timeZone: config.CALENDAR_TIMEZONE, weekday: 'long', month: 'long', day: 'numeric' });
  const time = new Intl.DateTimeFormat('en-US', { timeZone: config.CALENDAR_TIMEZONE, hour: 'numeric', minute: '2-digit' });
  // ICU puts a narrow no-break space before AM/PM; plain text reads better.
  const clock = (iso: string) => time.format(new Date(iso)).replace(/\s/g, ' ');
  return ranges.map((r) => `${day.format(new Date(r.start))}, ${clock(r.start)} to ${clock(r.end)}`).join('; ');
}

/**
 * The task's own constraints, which used to stop at the database. A demo call
 * (2026-09-22) had durationMinutes 90 and notes "Full groom preferred" on the
 * task and neither in the prompt: the model asked the callee how long to book
 * three times, and told her a 3:30 slot "works" when 90 minutes there ran into
 * Steve's 4pm meeting — most likely because it checked a short slot, having no
 * duration to check with. `contact.notes` is a different thing (standing
 * context about who is being called), so this is additive, not a replacement.
 *
 * Optional-chained because the column is NOT NULL but test fixtures and any
 * future partial Task shape shouldn't turn a missing field into "undefined
 * minutes" in front of the model.
 */
function taskDetails(task: Task): string {
  const lines: string[] = [];
  const duration = task.constraints?.durationMinutes;
  if (duration) {
    lines.push(
      `Appointment length: ${duration} minutes. Use this duration in every check_my_availability and confirm_appointment call. ` +
        `Do not ask the other party how long to book — you already know. If they tell you the service itself takes a different ` +
        `length, use theirs for both the check and the booking.`,
    );
  }
  const notes = task.constraints?.notes?.trim();
  if (notes) lines.push(`Notes from ${config.ASSISTANT_PRINCIPAL_NAME} for this call: ${notes}`);
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

function conversationModeGuidance(task: Task): string {
  if (task.mode !== 'conversation') return '';
  return `

This call has no booking or negotiation goal — it's a conversation: ${task.goalDescription}. Not having a
specific outcome to report is expected and fine; do not treat that as a reason to end the call quickly. Engage
naturally and stay on the call until the conversation actually reaches its own natural close — the other party
sounds done, or you've said what you called to say and there's nothing more to add — not the moment you've
delivered your opening line. If a specific time or booking need comes up naturally, you can still use
confirm_appointment/check_my_availability as usual. When the conversation is genuinely over, call
end_conversation_call with a short summary — this is the correct, successful way to end this call, even if
nothing specific was decided or accomplished. Do NOT use escalate_and_end_call or end_call to close out a normal
conversation that went fine — those mark the task as needing ${config.ASSISTANT_PRINCIPAL_NAME}'s follow-up, which would be wrong here.
escalate_and_end_call is still the right call if something genuinely goes wrong (hostile response, you can't
understand each other, you're truly stuck) — just not as a way to wrap up a conversation that went normally.`;
}

/**
 * Builds the call-specific system prompt injected into the VoiceAIProvider
 * session. The precomputed candidateWindows are an optimization/starting
 * point, not the source of truth — check_my_availability exists precisely so
 * the model isn't stuck if what the other party offers diverges from what
 * was computed minutes/hours earlier (stale calendar state, a slightly
 * different duration, etc).
 */
export function buildCallSystemPrompt(task: Task, contact: Contact, candidateWindows: TimeWindow[]): string {
  return `
${buildBaseSystemPromptGuidance()}

You are calling ${contact.displayName} on behalf of ${config.ASSISTANT_PRINCIPAL_NAME} to: ${task.goalDescription}.

Contact context: ${contact.notes ?? '(no notes on file)'}${taskDetails(task)}

${config.ASSISTANT_PRINCIPAL_NAME} is free during these ranges (${config.CALENDAR_TIMEZONE} local time): ${formatWindows(candidateWindows)}.
You may offer or accept any appointment that fits entirely inside one of these ranges, start to finish, without
checking back with anyone. When you suggest a time yourself, only suggest start times that leave the whole
appointment inside one of these ranges — never a time you have not seen here or checked.
If the other party offers a time outside these ranges, call check_my_availability(date, time, durationMinutes)
to check live before agreeing — do not assume it's free or unavailable.

Once a specific time is agreed, call confirm_appointment with the confirmed start time and duration.
If you reach voicemail, call leave_voicemail_and_end_call with a concise, natural message (including a callback
number if one was given to you) as the message argument — the system speaks that message for you, verbatim,
before hanging up. Do not say the message yourself first; the callee would hear it twice.
If you reach a human who engages properly but no offered time fits the constraints (e.g. fully booked), call
report_negotiation_failed with a short reason.
If you get stuck — a confusing phone menu, a hostile or nonsensical response, or you genuinely cannot proceed —
call escalate_and_end_call with a short reason rather than guessing or looping indefinitely.
If you're navigating a phone menu, use press_digits to select the relevant option; if you've tried a couple of
options and still can't find a relevant one, escalate rather than keep guessing.${conversationModeGuidance(task)}
`.trim();
}

function conversationModeFrontendGuidance(task: Task): string {
  if (task.mode !== 'conversation') return '';
  return `

This call has no booking or negotiation goal — it's a conversation. Not having a specific outcome to report is
expected and fine; do not treat that as a reason to end the call quickly. Engage naturally and stay on the call
until the conversation reaches its own natural close — the other party sounds done, or you've said what you
called to say and there's nothing more to add — then say goodbye and immediately delegate ending the call. The
call does not end when you say goodbye; it ends only when your backend ends it.`;
}

/**
 * Voice-layer counterpart of buildCallSystemPrompt, for a VoiceAIProvider that
 * splits its voice front-end from a reasoning backend (openai-live — passed
 * through as VoiceAISessionConfig.frontendInstructions; every other provider
 * ignores it). The backend receives buildCallSystemPrompt's full prompt —
 * tools, candidate windows, timezone contract — so this carries only what the
 * voice needs to hold the conversation: who it is calling, why, and how to
 * sound.
 */
export function buildCallFrontendPrompt(task: Task, contact: Contact): string {
  return `
${buildFrontendSystemPromptGuidance()}

You are calling ${contact.displayName} on behalf of ${config.ASSISTANT_PRINCIPAL_NAME} to: ${task.goalDescription}.

Contact context: ${contact.notes ?? '(no notes on file)'}${taskDetails(task)}${conversationModeFrontendGuidance(task)}
`.trim();
}
