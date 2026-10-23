/**
 * An eval run's results, summarized and compared with the baseline (#188).
 * Warn only: a drop is flagged, never fails anything. With k = 3 to 5 runs a
 * scenario, one run either way is within the noise, and the summary says so.
 *
 * Type-only imports: the orchestrator uses this without loading src/config.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckResult } from './checks.js';
import type { Usage } from './cost.js';
import type { Rescue } from './rescues.js';
import type { RunRecord } from './runRecord.js';

export interface RunResult {
  scenarioId: string;
  run: number;
  checks: CheckResult[];
  pass: boolean;
  rescues: Rescue[];
  status: string;
  durationMs: number;
  usage?: Usage;
  costUsd: number | null;
  transcript: RunRecord['lines'];
  toolCalls: RunRecord['toolCalls'];
  /** Of the prompt and tools the run connected with (recording.ts). */
  fingerprint?: string;
  /** Set when the run couldn't finish: it counts as a failed run. */
  error?: string;
}

export interface ScenarioSummary {
  id: string;
  passed: number;
  runs: number;
  rescues: number;
  checks: Record<string, { passed: number; runs: number }>;
  costUsd: number | null;
  durationMs: number;
}

export interface Summary {
  startedAt: string;
  gitSha: string;
  model: string;
  fingerprint: string;
  k: number;
  /** Stopped early (Ctrl+C): never saved as a baseline. */
  partial: boolean;
  scenarios: ScenarioSummary[];
}

export interface Flag {
  scenarioId: string;
  kind: 'pass_rate_down' | 'rescues_up' | 'no_baseline';
  from?: string;
  to?: string;
  withinNoise: boolean;
}

export const DEFAULT_BASELINE_PATH = 'evals/baseline.json';

export function summarize(results: RunResult[], meta: Omit<Summary, 'scenarios'>): Summary {
  const byId = new Map<string, ScenarioSummary>();
  for (const r of results) {
    let s = byId.get(r.scenarioId);
    if (!s) byId.set(r.scenarioId, (s = { id: r.scenarioId, passed: 0, runs: 0, rescues: 0, checks: {}, costUsd: null, durationMs: 0 }));
    s.runs++;
    if (r.pass && !r.error) s.passed++;
    s.rescues += r.rescues.length;
    s.durationMs += r.durationMs;
    if (r.costUsd !== null) s.costUsd = (s.costUsd ?? 0) + r.costUsd;
    for (const c of r.checks) {
      const tally = (s.checks[c.name] ??= { passed: 0, runs: 0 });
      tally.runs++;
      if (c.pass) tally.passed++;
    }
  }
  return { ...meta, scenarios: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

export function compareToBaseline(current: Summary, baseline: Summary | null): Flag[] {
  const flags: Flag[] = [];
  for (const cur of current.scenarios) {
    const base = baseline?.scenarios.find((s) => s.id === cur.id);
    if (!base) {
      flags.push({ scenarioId: cur.id, kind: 'no_baseline', withinNoise: false });
      continue;
    }
    const noise = 1 / cur.runs;
    const passDelta = cur.passed / cur.runs - base.passed / base.runs;
    if (passDelta < 0) {
      flags.push({
        scenarioId: cur.id,
        kind: 'pass_rate_down',
        from: `${base.passed}/${base.runs}`,
        to: `${cur.passed}/${cur.runs}`,
        withinNoise: Math.abs(passDelta) <= noise + 1e-9,
      });
    }
    const rescueDelta = cur.rescues / cur.runs - base.rescues / base.runs;
    if (rescueDelta > 0) {
      flags.push({
        scenarioId: cur.id,
        kind: 'rescues_up',
        from: `${base.rescues} in ${base.runs}`,
        to: `${cur.rescues} in ${cur.runs}`,
        withinNoise: rescueDelta <= noise + 1e-9,
      });
    }
  }
  return flags;
}

export function readBaseline(path = DEFAULT_BASELINE_PATH): Summary | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Summary) : null;
}

/** Saves this run's scenarios over the baseline's, keeping the ones it didn't run. */
export function saveBaseline(summary: Summary, path = DEFAULT_BASELINE_PATH): void {
  if (summary.partial) throw new Error('Refusing to save a partial run as the baseline.');
  const existing = readBaseline(path);
  const merged = new Map((existing?.scenarios ?? []).map((s) => [s.id, s]));
  for (const s of summary.scenarios) merged.set(s.id, s);
  const { scenarios: _, ...meta } = summary;
  const out: Summary = { ...meta, scenarios: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
}

function describeFlag(flag: Flag): string {
  const noise = flag.withinNoise ? ' (within noise)' : '';
  if (flag.kind === 'pass_rate_down') return `down from ${flag.from}${noise}`;
  if (flag.kind === 'rescues_up') return `rescues up from ${flag.from}${noise}`;
  return 'no baseline';
}

export function formatSummary(summary: Summary, flags: Flag[]): string {
  const rows = summary.scenarios.map((s) => {
    const flag = flags
      .filter((f) => f.scenarioId === s.id)
      .map(describeFlag)
      .join('; ');
    const cost = s.costUsd === null ? 'n/a' : `$${s.costUsd.toFixed(2)}`;
    return [s.id, `${s.passed}/${s.runs}`, String(s.rescues), cost, `${Math.round(s.durationMs / 1000)}s`, flag ? `⚠ ${flag}` : ''];
  });
  const header = ['scenario', 'passed', 'rescues', 'cost', 'time', ''];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  const totalCost = summary.scenarios.every((s) => s.costUsd === null) ? 'n/a' : `$${summary.scenarios.reduce((n, s) => n + (s.costUsd ?? 0), 0).toFixed(2)}`;
  const totalTime = Math.round(summary.scenarios.reduce((n, s) => n + s.durationMs, 0) / 1000);
  return [
    line(header),
    ...rows.map(line),
    '',
    `Total: ${totalCost}, ${totalTime}s.${summary.partial ? ' Stopped early: partial run.' : ''}`,
    `k=${summary.k}: a difference of one run is within the noise.`,
  ].join('\n');
}
