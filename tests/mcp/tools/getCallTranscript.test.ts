import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTask, listTranscriptForTask } = vi.hoisted(() => ({
  getTask: vi.fn(),
  listTranscriptForTask: vi.fn(),
}));
vi.mock('../../../src/tasks/service.js', () => ({ getTask }));
vi.mock('../../../src/transcripts/service.js', () => ({ listTranscriptForTask }));

const { getCallTranscriptHandler } = await import('../../../src/mcp/tools/getCallTranscript.js');

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const on = { enabled: true, retentionDays: 30 };
const attempt = { id: 'attempt-1', startedAt: new Date('2026-09-23T23:27:00Z') };
const line = (seq: number, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) => ({
  seq,
  role,
  text,
  quality: 'ok',
  voiceProvider: 'openai',
  spokenAt: new Date(Date.UTC(2026, 8, 23, 23, 27, 10 + seq)),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  getTask.mockResolvedValue({ id: TASK_ID });
});

describe('get_call_transcript (#6)', () => {
  it('not found for an unknown task', async () => {
    getTask.mockResolvedValue(undefined);
    expect(await getCallTranscriptHandler({ taskId: TASK_ID }, on)).toMatchObject({ found: false });
  });

  it('lines in order, speakers named plainly, times in local time without a UTC offset', async () => {
    listTranscriptForTask.mockResolvedValue([
      { attempt, turns: [line(1, 'user', "Claudia's, how can I help?"), line(2, 'assistant', 'Hi, calling for Steve.')] },
    ]);
    const result = await getCallTranscriptHandler({ taskId: TASK_ID }, on);
    expect(result).toMatchObject({ found: true });
    if (!result.found) throw new Error('unreachable');
    expect(result.calls[0]!.startedAt).toBe('2026-09-23T19:27:00');
    expect(result.calls[0]!.lines).toEqual([
      { seq: 1, at: '2026-09-23T19:27:11', speaker: 'other_party', text: "Claudia's, how can I help?" },
      { seq: 2, at: '2026-09-23T19:27:12', speaker: 'banjo', text: 'Hi, calling for Steve.' },
    ]);
  });

  it('marks suspect lines and says what that means', async () => {
    listTranscriptForTask.mockResolvedValue([{ attempt, turns: [line(1, 'user', 'ᱤᱠ', { quality: 'suspect' })] }]);
    const result = await getCallTranscriptHandler({ taskId: TASK_ID }, on);
    if (!result.found) throw new Error('unreachable');
    expect(result.calls[0]!.lines[0]).toMatchObject({ suspect: true });
    expect(result.notes.join(' ')).toMatch(/may not be what was actually said/i);
  });

  it('says a Gemini call is one-sided rather than letting it look complete', async () => {
    listTranscriptForTask.mockResolvedValue([{ attempt, turns: [line(1, 'assistant', 'Hi.', { voiceProvider: 'gemini' })] }]);
    const result = await getCallTranscriptHandler({ taskId: TASK_ID }, on);
    if (!result.found) throw new Error('unreachable');
    expect(result.calls[0]!.note).toMatch(/only Banjo's side/i);
  });

  it('explains an empty record, and says when saving is off', async () => {
    listTranscriptForTask.mockResolvedValue([{ attempt, turns: [] }]);
    const off = await getCallTranscriptHandler({ taskId: TASK_ID }, { enabled: false, retentionDays: 30 });
    if (!off.found) throw new Error('unreachable');
    expect(off.calls[0]!.note).toMatch(/no lines were saved/i);
    expect(off.notes.join(' ')).toMatch(/PERSIST_TRANSCRIPTS is off/);
  });

  it('states the retention window', async () => {
    listTranscriptForTask.mockResolvedValue([]);
    const result = await getCallTranscriptHandler({ taskId: TASK_ID }, on);
    if (!result.found) throw new Error('unreachable');
    expect(result.notes.join(' ')).toMatch(/deleted after 30 days/);
  });
});
