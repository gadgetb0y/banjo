import { describe, expect, it } from 'vitest';
import { saidGoodbye } from '../../src/session/goodbye.js';

describe('saidGoodbye (#102)', () => {
  it.each([
    'Okay, take care—bye, Sam!',
    'Great, thanks — talk soon!',
    'Thanks so much — have a great day!',
    'Have a good one!',
    'Goodbye!',
    'Thank you, have a lovely evening.',
    'See you Friday!',
    'Good night!',
    'Thanks again for your help!',
  ])('accepts a real goodbye: %s', (line) => {
    expect(saidGoodbye(line)).toBe(true);
  });

  it.each([
    // The live call in #102.
    "Okay, sounds like we're about ready to close this out together.",
    // The demo call before #47: thanks, but then it describes wrapping up instead of saying goodbye.
    'Great, thanks for confirming. Let me wrap this up.',
    "Perfect, that's all set. I'll say a quick goodbye and end the call.",
    'Got it. Is there anything else I can help with?',
    'Sure, Friday at 10 works.',
  ])('rejects a line with no goodbye: %s', (line) => {
    expect(saidGoodbye(line)).toBe(false);
  });
});
