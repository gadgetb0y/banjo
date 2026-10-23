/**
 * What an eval run cost (#188), from the token usage the realtime session
 * reports. Text-mode sim calls use text tokens only. Prices are looked up, not
 * remembered: update `checked` with them.
 */
export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export const PRICES: Record<string, { inputPerM: number; cachedInputPerM: number; outputPerM: number; source: string; checked: string }> = {
  'gpt-realtime': {
    inputPerM: 4,
    cachedInputPerM: 0.4,
    outputPerM: 16,
    source: 'https://developers.openai.com/api/docs/pricing',
    checked: '2026-10-22',
  },
};

/** US dollars, or null for a model with no price here. inputTokens includes the cached ones. */
export function estimateCost(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  return (uncached * price.inputPerM + usage.cachedInputTokens * price.cachedInputPerM + usage.outputTokens * price.outputPerM) / 1_000_000;
}
