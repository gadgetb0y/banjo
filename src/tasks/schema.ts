import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { contacts } from '../contacts/schema.js';

export const taskChannelEnum = pgEnum('task_channel', ['phone', 'online']);

export const taskModeEnum = pgEnum('task_mode', ['booking', 'conversation']);

export const taskStatusEnum = pgEnum('task_status', [
  'pending', // created, not yet started
  'checking_availability', // (phone path) querying Steve's calendar for candidate windows
  'calling', // (phone path) call originated, not yet connected/negotiating
  'negotiating', // (phone path) call connected, AI is talking to a human/IVR
  'confirmed', // time agreed, calendar event written
  'voicemail_left', // left a message; resting state, not auto-retried in v1
  'negotiation_failed', // reached a human, no offered time fit constraints
  'escalated', // AI (or the skill, on the online path) got stuck
  'conversation_completed', // NEW — open-ended conversational call reached a natural close
  'failed', // technical failure (no answer, bad number, telephony/API error)
  'cancelled', // Steve cancelled before completion
]);

export const callAttemptStatusEnum = pgEnum('call_attempt_status', [
  'connecting',
  'active',
  'tool_pending',
  'ending',
  'ended',
  'error',
]);

export interface TimeWindow {
  start: string; // ISO 8601
  end: string; // ISO 8601
}

export interface TaskConstraints {
  dateWindows?: TimeWindow[]; // e.g. "next week after 3pm"
  durationMinutes?: number; // default applied per task type if omitted
  notes?: string; // any other free-text guidance Steve gave
}

export type TaskOutcome =
  | { kind: 'confirmed'; start: string; durationMinutes: number; details?: string }
  | { kind: 'voicemail_left'; message: string }
  | { kind: 'negotiation_failed'; reason: string }
  | { kind: 'escalated'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'conversation_completed'; summary: string };

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contacts.id),
  channel: taskChannelEnum('channel').notNull(),
  mode: taskModeEnum('mode').notNull().default('booking'),
  goalDescription: text('goal_description').notNull(),
  constraints: jsonb('constraints').$type<TaskConstraints>().notNull(),
  status: taskStatusEnum('status').notNull().default('pending'),
  candidateWindows: jsonb('candidate_windows').$type<TimeWindow[]>(), // phone path only
  outcome: jsonb('outcome').$type<TaskOutcome | null>(),
  calendarEventId: text('calendar_event_id'),
  // Phone path: the orchestrator won't place the call before this instant
  // (see isTaskDue in ./service.ts). Null means call as soon as possible.
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const callAttempts = pgTable('call_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id),
  providerCallId: text('provider_call_id'), // Twilio Call SID
  status: callAttemptStatusEnum('status').notNull().default('connecting'),
  // Twilio AMD's GUESS — human | machine_start | fax | unknown | null — not a
  // fact. It routinely reported machine_start for a person answering with a
  // business greeting (a long first utterance looks like voicemail to it).
  // Outbound calls stopped requesting AMD in #32, so this is null for calls
  // placed after that; older rows hold the guess. The model decides voicemail
  // vs human by listening. See docs/ARCHITECTURE.md Open Risks #23.
  answeredBy: text('answered_by'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  errorDetail: text('error_detail'),
});

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type CallAttempt = typeof callAttempts.$inferSelect;
export type NewCallAttempt = typeof callAttempts.$inferInsert;
