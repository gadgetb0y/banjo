import { describe, expect, it } from 'vitest';
import { checkDisclosure } from '../../src/session/disclosure.js';

describe('checkDisclosure (#8)', () => {
  it('disclosed: the first thing Banjo said includes "AI"', () => {
    expect(checkDisclosure("Hi, I'm an AI assistant calling on behalf of Steve.")).toBe('disclosed');
    expect(checkDisclosure("Hi, this is Steve's A.I. assistant.")).toBe('disclosed');
  });

  it('missed: an opener that never says it is an AI — every demo call before this change', () => {
    expect(checkDisclosure("Hi, I'm calling on behalf of Steve about booking a grooming appointment.")).toBe('missed');
    expect(checkDisclosure('I said I would wait.')).toBe('missed'); // "ai" inside a word doesn't count
  });

  it('no_speech: Banjo never said anything, so there was nothing to disclose in', () => {
    expect(checkDisclosure(undefined)).toBe('no_speech');
  });
});
