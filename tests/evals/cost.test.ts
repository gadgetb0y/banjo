import { describe, expect, it } from 'vitest';
import { estimateCost, PRICES } from '../../src/evals/cost.js';

describe('estimateCost', () => {
  it('prices uncached input, cached input and output per million tokens', () => {
    const p = PRICES['gpt-realtime']!;
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 };
    expect(estimateCost('gpt-realtime', usage)).toBeCloseTo(0.6 * p.inputPerM + 0.4 * p.cachedInputPerM + 0.1 * p.outputPerM, 10);
  });

  it('returns null for an unknown model', () => {
    expect(estimateCost('gpt-mystery', { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).toBeNull();
  });

  it('every price says where it came from and when', () => {
    for (const p of Object.values(PRICES)) {
      expect(p.source).toMatch(/^https:\/\//);
      expect(p.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
