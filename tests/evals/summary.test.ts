import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareToBaseline, formatSummary, saveBaseline, summarize, type RunResult, type Summary } from '../../src/evals/summary.js';

function run(scenarioId: string, n: number, passes: Record<string, boolean>, rescues = 0, costUsd: number | null = 0.1): RunResult {
  const checks = Object.entries(passes).map(([name, pass]) => ({ name, pass }));
  return {
    scenarioId,
    run: n,
    checks,
    pass: checks.every((c) => c.pass),
    rescues: Array.from({ length: rescues }, (_, i) => ({ kind: 'fixed_goodbye' as const, t: i })),
    status: 'confirmed',
    durationMs: 1000,
    costUsd,
    transcript: [],
    toolCalls: [],
  };
}

const META = { startedAt: '2026-10-22T20:00:00.000Z', gitSha: 'abc1234', model: 'gpt-realtime', fingerprint: 'fp', k: 3, partial: false };

function summaryOf(passed: number, runs: number, rescues: number, id = 'voicemail'): Summary {
  return { ...META, k: runs, scenarios: [{ id, passed, runs, rescues, checks: {}, costUsd: 0.3, durationMs: 3000 }] };
}

describe('summarize', () => {
  it('counts per-scenario and per-check pass rates, rescues, cost and time', () => {
    const s = summarize(
      [
        run('voicemail', 1, { status: true, goodbye_before_end: true }, 1),
        run('voicemail', 2, { status: true, goodbye_before_end: false }),
        run('voicemail', 3, { status: true, goodbye_before_end: true }, 2),
      ],
      META,
    );
    expect(s.scenarios).toEqual([
      {
        id: 'voicemail',
        passed: 2,
        runs: 3,
        rescues: 3,
        checks: { status: { passed: 3, runs: 3 }, goodbye_before_end: { passed: 2, runs: 3 } },
        costUsd: expect.closeTo(0.3, 10),
        durationMs: 3000,
      },
    ]);
  });

  it('a run that errored counts as a failed run', () => {
    const errored = { ...run('voicemail', 1, {}), pass: false, error: 'child exited 1' };
    expect(summarize([errored], META).scenarios[0]).toMatchObject({ passed: 0, runs: 1 });
  });

  it('cost is null when no run reported one', () => {
    expect(summarize([run('voicemail', 1, { status: true }, 0, null)], META).scenarios[0]!.costUsd).toBeNull();
  });
});

describe('compareToBaseline', () => {
  it('flags a drop, and marks 4/5 against 5/5 within the noise', () => {
    expect(compareToBaseline(summaryOf(4, 5, 0), summaryOf(5, 5, 0))).toEqual([
      { scenarioId: 'voicemail', kind: 'pass_rate_down', from: '5/5', to: '4/5', withinNoise: true },
    ]);
    expect(compareToBaseline(summaryOf(2, 5, 0), summaryOf(5, 5, 0))[0]).toMatchObject({ kind: 'pass_rate_down', withinNoise: false });
  });

  it('flags rescues going up', () => {
    expect(compareToBaseline(summaryOf(5, 5, 4), summaryOf(5, 5, 0))).toEqual([
      { scenarioId: 'voicemail', kind: 'rescues_up', from: '0 in 5', to: '4 in 5', withinNoise: false },
    ]);
  });

  it('a scenario only in the baseline is ignored; one only in this run has no baseline', () => {
    expect(compareToBaseline(summaryOf(1, 3, 0, 'new-one'), summaryOf(3, 3, 0, 'old-one'))).toEqual([
      { scenarioId: 'new-one', kind: 'no_baseline', withinNoise: false },
    ]);
  });

  it('with no baseline at all, every scenario has none', () => {
    expect(compareToBaseline(summaryOf(3, 3, 0), null)).toEqual([{ scenarioId: 'voicemail', kind: 'no_baseline', withinNoise: false }]);
  });
});

describe('saveBaseline', () => {
  it('refuses a partial summary', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'base-')), 'baseline.json');
    expect(() => saveBaseline({ ...summaryOf(3, 3, 0), partial: true }, path)).toThrow(/partial/);
  });

  it('merges by scenario id, keeping scenarios this run left out', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'base-')), 'baseline.json');
    saveBaseline(summaryOf(3, 3, 0, 'voicemail'), path);
    saveBaseline(summaryOf(2, 3, 1, 'tired-callee'), path);
    saveBaseline(summaryOf(1, 3, 0, 'voicemail'), path);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Summary;
    expect(saved.scenarios.map((s) => [s.id, s.passed])).toEqual([
      ['tired-callee', 2],
      ['voicemail', 1],
    ]);
  });
});

describe('formatSummary', () => {
  it('has a row per scenario with its flag, and says what is within the noise', () => {
    const text = formatSummary(summaryOf(4, 5, 1), [{ scenarioId: 'voicemail', kind: 'pass_rate_down', from: '5/5', to: '4/5', withinNoise: true }]);
    expect(text).toMatch(/voicemail\s+4\/5\s+1\s+\$0\.30\s+3s\s+.*down from 5\/5 \(within noise\)/);
    expect(text).toContain('k=5: a difference of one run is within the noise.');
  });
});
