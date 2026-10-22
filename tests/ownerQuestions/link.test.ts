import { describe, expect, it } from 'vitest';
import { approvalSignature } from '../../src/approvals/link.js';
import { answerSignature, isValidAnswerSignature } from '../../src/ownerQuestions/link.js';

const ID = '22222222-2222-2222-2222-222222222222';
const EXPIRES = new Date('2026-10-19T14:00:00Z');

describe('answer links', () => {
  it('accepts its own signature, for that question and deadline only', () => {
    const sig = answerSignature(ID, EXPIRES);
    expect(isValidAnswerSignature(ID, EXPIRES, sig)).toBe(true);
    expect(isValidAnswerSignature(ID, new Date(EXPIRES.getTime() + 1), sig)).toBe(false);
    expect(isValidAnswerSignature('33333333-3333-3333-3333-333333333333', EXPIRES, sig)).toBe(false);
    expect(isValidAnswerSignature(ID, EXPIRES, 'nope')).toBe(false);
  });

  it("never accepts an approval link's signature: the two are keyed apart", () => {
    expect(isValidAnswerSignature(ID, EXPIRES, approvalSignature(ID, EXPIRES))).toBe(false);
  });
});
