import { describe, expect, it } from 'vitest';
import type { Contact } from '../../src/contacts/schema.js';
import { buildCallFrontendPrompt, buildCallSystemPrompt } from '../../src/tasks/promptBuilder.js';
import type { Task } from '../../src/tasks/schema.js';

const contact = { displayName: 'Alex', notes: null } as Contact;

const bookingTask = {
  goalDescription: 'Book a haircut for Steve',
  mode: 'booking',
} as Task;

const conversationTask = {
  goalDescription: 'Call and say thanks for having us over',
  mode: 'conversation',
} as Task;

describe('buildCallSystemPrompt: mode-aware branch', () => {
  it('booking mode: prompt is unchanged from today — no conversation-mode guidance present', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, []);
    expect(prompt).toContain('Once a specific time is agreed, call confirm_appointment');
    expect(prompt).not.toContain('end_conversation_call');
  });

  it('conversation mode: includes guidance not to end the call early for lack of a booking outcome', () => {
    const prompt = buildCallSystemPrompt(conversationTask, contact, []);
    expect(prompt.toLowerCase()).toContain('no booking or negotiation goal');
    expect(prompt.toLowerCase()).toContain('do not treat that as a reason to end the call quickly');
    expect(prompt).toContain('end_conversation_call');
  });

  it('conversation mode: booking tools remain mentioned too — unified toolset, not a separate restricted path', () => {
    const prompt = buildCallSystemPrompt(conversationTask, contact, []);
    expect(prompt).toContain('Once a specific time is agreed, call confirm_appointment');
  });

  it('conversation mode: explicitly warns against escalate_and_end_call/end_call for a normal, successful close — a live call ended via escalate_and_end_call even though nothing went wrong, mislabeling a fine conversation as needing Steve follow-up', () => {
    const prompt = buildCallSystemPrompt(conversationTask, contact, []);
    const lower = prompt.toLowerCase();
    expect(lower).toContain('do not use escalate_and_end_call or end_call');
    expect(lower).toContain('nothing specific was decided or accomplished');
  });
});

describe('buildCallFrontendPrompt: voice-layer prompt for a split provider (openai-live)', () => {
  it('carries who is being called, why, the contact context, and how to hold the conversation', () => {
    const prompt = buildCallFrontendPrompt(bookingTask, { displayName: 'Pat', notes: 'prefers mornings' } as Contact);
    expect(prompt).toContain('You are calling Pat on behalf of Alex to: Book a haircut for Steve.');
    expect(prompt).toContain('Contact context: prefers mornings');
    expect(prompt).toContain('Turn-taking');
    expect(prompt).toContain('Delegating to your backend');
  });

  it('leaves tool workflow and the timezone contract to the backend prompt', () => {
    const prompt = buildCallFrontendPrompt(bookingTask, contact);
    for (const backendOnly of ['check_my_availability', 'confirm_appointment', 'leave_voicemail_and_end_call', 'report_negotiation_failed', 'press_digits', 'Timezone']) {
      expect(prompt).not.toContain(backendOnly);
    }
  });

  it('booking mode: no conversation-mode guidance', () => {
    expect(buildCallFrontendPrompt(bookingTask, contact).toLowerCase()).not.toContain('no booking or negotiation goal');
  });

  it('conversation mode: tells the voice layer not to end the call early, without naming backend tools', () => {
    const prompt = buildCallFrontendPrompt(conversationTask, contact);
    expect(prompt.toLowerCase()).toContain('do not treat that as a reason to end the call quickly');
    expect(prompt).not.toContain('end_conversation_call');
  });
});

describe('the task\'s own constraints reach the model', () => {
  // Demo call, 2026-09-22: the task said 90 minutes and "Full groom preferred",
  // and neither was in the prompt. The model asked the callee how long to book
  // three times, then told her a 3:30 slot "works" when a 90-minute appointment
  // there ran into Steve's 4pm meeting — most likely because it checked a short
  // slot, having no duration to check with.
  const groomTask = {
    goalDescription: "Book a grooming appointment for Banjo, Steve's dog",
    mode: 'booking',
    constraints: { durationMinutes: 90, notes: 'Full groom preferred.' },
  } as Task;

  it('states the appointment length, and tells the model to use it rather than ask', () => {
    const prompt = buildCallSystemPrompt(groomTask, contact, []);
    expect(prompt).toContain('90 minutes');
    expect(prompt).toMatch(/every check_my_availability and confirm_appointment call/i);
    expect(prompt).toMatch(/do not ask the other party how long/i);
  });

  it("includes the task's notes, which are separate from the contact's", () => {
    const prompt = buildCallSystemPrompt(groomTask, contact, []);
    expect(prompt).toContain('Full groom preferred.');
  });

  it('gives the voice layer the length and notes too, since it is the part that talks', () => {
    const prompt = buildCallFrontendPrompt(groomTask, contact);
    expect(prompt).toContain('90 minutes');
    expect(prompt).toContain('Full groom preferred.');
  });

  it('says nothing about length when the task does not specify one, rather than inventing a number', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, []);
    expect(prompt).not.toMatch(/Appointment length:/);
  });
});
