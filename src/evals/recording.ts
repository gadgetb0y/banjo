/**
 * A recording (evals/recordings/<id>.json, #188): one passing live run's
 * boundary log, with what it was made under. Replay plays the model's side
 * back; the fingerprint says whether the prompt and tools it was made with are
 * still the ones the code would send, so a changed prompt makes it stale
 * rather than a pass.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from './recorder.js';

export interface RecordingFile {
  version: 1;
  scenarioId: string;
  /** sha256 of the scenario file it was recorded from. */
  scenarioHash: string;
  /** Of the session config the run connected with: see fingerprint(). */
  fingerprint: string;
  recordedAt: string;
  /** The booking window's start, so a replay builds the same prompt. */
  windowStart: string;
  gitSha: string;
  model: string;
  log: LogEntry[];
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const EPOCH_MS = /\b1\d{12}\b/g;

/** What differs between two runs of the same call: ids and timestamps. */
export function normalizeVolatile(text: string): string {
  return text.replace(UUID, '<uuid>').replace(ISO, '<iso>').replace(EPOCH_MS, '<epoch>');
}

/** The prompt and tools a session connected with, minus what differs per run. */
export function fingerprint(config: { instructions: string; tools: unknown[] }): string {
  return createHash('sha256')
    .update(normalizeVolatile(config.instructions))
    .update('\n')
    .update(normalizeVolatile(JSON.stringify(config.tools)))
    .digest('hex');
}

export function scenarioHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeRecording(dir: string, rec: RecordingFile): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rec.scenarioId}.json`), `${JSON.stringify(rec, null, 2)}\n`);
}

export function readRecording(dir: string, scenarioId: string): RecordingFile | null {
  const path = join(dir, `${scenarioId}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RecordingFile) : null;
}
