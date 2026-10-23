import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../src/evals/recorder.js';
import { findRescues } from '../../src/evals/rescues.js';
import { FALLBACK_GOODBYE, openingLineCue, STILL_THERE_CUE, UNANSWERED_QUESTION_CUE } from '../../src/session/callSession.js';

const at = (t: number, entry: Record<string, unknown>) => ({ dir: 'in', t, ...entry }) as LogEntry;

describe('findRescues', () => {
  it.each(['callee_speaking', 'unanswered_question', 'no_reply', 'no_goodbye'])('a refused ending (%s)', (error) => {
    const log = [at(5, { call: 'sendToolResult', toolCallId: 'x', result: { ok: false, error }, isError: true })];
    expect(findRescues(log)).toEqual([{ kind: 'refused_ending', t: 5, detail: error }]);
  });

  it('the fixed goodbye', () => {
    expect(findRescues([at(9, { call: 'sayVerbatim', text: FALLBACK_GOODBYE })])).toEqual([{ kind: 'fixed_goodbye', t: 9 }]);
  });

  it('a cued goodbye, as a cue or as added context', () => {
    expect(findRescues([at(1, { call: 'triggerResponse', cue: UNANSWERED_QUESTION_CUE })])).toEqual([{ kind: 'cued_goodbye', t: 1 }]);
    expect(findRescues([at(2, { call: 'addContext', items: [{ role: 'system', text: UNANSWERED_QUESTION_CUE }] })])).toEqual([
      { kind: 'cued_goodbye', t: 2 },
    ]);
  });

  it('a still-there check', () => {
    expect(findRescues([at(3, { call: 'addContext', items: [{ role: 'system', text: STILL_THERE_CUE }] })])).toEqual([
      { kind: 'still_there_check', t: 3 },
    ]);
  });

  it('the opener cue', () => {
    expect(findRescues([at(4, { call: 'triggerResponse', cue: openingLineCue("Hi, I'm an AI assistant.") })])).toEqual([{ kind: 'opener_cue', t: 4 }]);
  });

  it('a voicemail sayVerbatim is not a rescue', () => {
    expect(findRescues([at(1, { call: 'sayVerbatim', text: 'Hi, this is Alex’s AI assistant calling to book a grooming. Bye!' })])).toEqual([]);
  });

  it('a non-refusal tool error (invalid_arguments) is not a rescue', () => {
    expect(findRescues([at(1, { call: 'sendToolResult', toolCallId: 'x', result: { ok: false, error: 'invalid_arguments' }, isError: true })])).toEqual([]);
  });

  it('an open-ended trigger is not a rescue', () => {
    expect(findRescues([at(1, { call: 'triggerResponse' })])).toEqual([]);
  });
});
