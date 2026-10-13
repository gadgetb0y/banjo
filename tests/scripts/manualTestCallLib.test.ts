import { describe, expect, it } from 'vitest';
import { buildPlaceCallInput, ManualCallInputError } from '../../scripts/manual-test-call/lib.js';

const NOW = new Date('2026-10-13T16:00:00Z');

describe('npm run test:call: place_call input', () => {
  it('builds a booking call with a window from now', () => {
    const input = buildPlaceCallInput({ duration: '30', windowDays: '2' }, NOW);
    expect(input.mode).toBe('booking');
    expect(input.questions).toBeUndefined();
    expect(input.constraints).toEqual({
      durationMinutes: 30,
      dateWindows: [{ start: NOW.toISOString(), end: '2026-10-15T16:00:00.000Z' }],
    });
  });

  it('builds an ask call with its questions and no booking constraints (#148 review)', () => {
    const input = buildPlaceCallInput({ mode: 'ask', question: ['What time do you close Saturday?', 'Do you take walk-ins?'], notes: 'For Banjo the dog.' }, NOW);
    expect(input).toMatchObject({ mode: 'ask', questions: ['What time do you close Saturday?', 'Do you take walk-ins?'] });
    expect(input.constraints).toEqual({ notes: 'For Banjo the dog.' });
    expect(input.taskDescription).not.toMatch(/end_call|book/i);
  });

  it('keeps a --goal given for an ask call', () => {
    expect(buildPlaceCallInput({ mode: 'ask', question: ['Open Sunday?'], goal: 'Check their hours.' }, NOW).taskDescription).toBe('Check their hours.');
  });

  it('refuses an ask call with no --question', () => {
    expect(() => buildPlaceCallInput({ mode: 'ask' }, NOW)).toThrow(ManualCallInputError);
    expect(() => buildPlaceCallInput({ mode: 'ask' }, NOW)).toThrow(/--question/);
  });

  it('refuses --question without --mode ask', () => {
    expect(() => buildPlaceCallInput({ question: ['Open Sunday?'] }, NOW)).toThrow(/only for --mode ask/);
  });

  it('refuses an unknown mode', () => {
    expect(() => buildPlaceCallInput({ mode: 'survey' }, NOW)).toThrow(/booking.*conversation.*ask/);
  });

  it("checks questions as place_call does: at most 5, 300 characters, one line each", () => {
    const six = ['a?', 'b?', 'c?', 'd?', 'e?', 'f?'];
    expect(() => buildPlaceCallInput({ mode: 'ask', question: six }, NOW)).toThrow(ManualCallInputError);
    expect(() => buildPlaceCallInput({ mode: 'ask', question: ['q'.repeat(301)] }, NOW)).toThrow(/questions\.0/);
    expect(() => buildPlaceCallInput({ mode: 'ask', question: ['Hours?\n2. Walk-ins?'] }, NOW)).toThrow(/one line/);
  });

  it('refuses a duration that is not a positive whole number', () => {
    expect(() => buildPlaceCallInput({ duration: 'abc' }, NOW)).toThrow(ManualCallInputError);
  });
});
