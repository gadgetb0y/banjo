import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, normalizeVolatile, readRecording, scenarioHash, writeRecording, type RecordingFile } from '../../src/evals/recording.js';

const prompt = (taskId: string, start: string) =>
  `You are calling for task ${taskId}. Alex is free from ${start} to ${start.replace('T15', 'T18')}. Never invent details.`;

describe('fingerprint', () => {
  it('the same prompt with different task ids and timestamps has the same fingerprint', () => {
    const a = fingerprint({ instructions: prompt('6f1c1a52-3b1e-4a8c-9a59-1f0a9b8f2c11', '2026-10-22T15:00:00.000Z'), tools: [{ at: 1792717403010 }] });
    const b = fingerprint({ instructions: prompt('0d2b7e44-91aa-4f3e-8c55-77e0c1d2a3b4', '2031-03-04T15:00:00.000Z'), tools: [{ at: 1951234567890 }] });
    expect(a).toBe(b);
  });

  it('a changed rule sentence changes the fingerprint', () => {
    const base = prompt('6f1c1a52-3b1e-4a8c-9a59-1f0a9b8f2c11', '2026-10-22T15:00:00.000Z');
    expect(fingerprint({ instructions: base, tools: [] })).not.toBe(fingerprint({ instructions: base.replace('Never', 'Do not'), tools: [] }));
  });

  it('a changed tool description changes the fingerprint', () => {
    const tool = (description: string) => [{ name: 'end_call', description, parameters: {} }];
    expect(fingerprint({ instructions: 'x', tools: tool('End the call.') })).not.toBe(fingerprint({ instructions: 'x', tools: tool('End it.') }));
  });

  describe('under the app config', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    async function confirmToolUnder(name: string) {
      vi.resetModules();
      vi.stubEnv('ASSISTANT_PRINCIPAL_NAME', name);
      const { confirmAppointmentTool } = await import('../../src/voice/tools/callTools.js');
      const { toToolDefinition } = await import('../../src/voice/tools/defineVoiceTool.js');
      return toToolDefinition(confirmAppointmentTool);
    }

    it('a different ASSISTANT_PRINCIPAL_NAME changes the fingerprint', async () => {
      const alex = fingerprint({ instructions: 'x', tools: [await confirmToolUnder('Alex')] });
      const sam = fingerprint({ instructions: 'x', tools: [await confirmToolUnder('Sam')] });
      expect(alex).not.toBe(sam);
    });
  });
});

describe('normalizeVolatile', () => {
  it('replaces uuids, ISO datetimes and epoch ms', () => {
    expect(normalizeVolatile('id 6f1c1a52-3b1e-4a8c-9a59-1f0a9b8f2c11 at 2026-10-22T15:00:00.000Z (1792717403010) or 2026-10-22T15:00:00')).toBe(
      'id <uuid> at <iso> (<epoch>) or <iso>',
    );
  });
});

describe('recording files', () => {
  const rec: RecordingFile = {
    version: 1,
    scenarioId: 'voicemail',
    scenarioHash: 'abc',
    fingerprint: 'def',
    recordedAt: '2026-10-22T15:00:00.000Z',
    windowStart: '2026-10-22T15:00:00.000Z',
    gitSha: '0123456',
    model: 'gpt-realtime',
    log: [{ dir: 'in', t: 0, call: 'capabilities', has: [], props: {} }],
  };

  it('writeRecording then readRecording round-trips, as readable JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    writeRecording(dir, rec);
    expect(readRecording(dir, 'voicemail')).toEqual(rec);
  });

  it('readRecording returns null for a missing file', () => {
    expect(readRecording(mkdtempSync(join(tmpdir(), 'rec-')), 'nope')).toBeNull();
  });

  it("scenarioHash is the file's sha256", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rec-')), 's.yaml');
    writeFileSync(path, 'id: s\n');
    expect(scenarioHash(path)).toMatch(/^[0-9a-f]{64}$/);
  });
});
