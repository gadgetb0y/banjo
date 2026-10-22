import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeChannels, splitWavChannels } from '../../src/transcripts/transferLeg.js';

/** A 16-bit PCM WAV with the given channels, sample by sample. */
function wav(channels: number[][], sampleRate = 8000): Buffer {
  const frames = channels[0]!.length;
  const data = Buffer.alloc(frames * channels.length * 2);
  for (let i = 0; i < frames; i++) channels.forEach((ch, c) => data.writeInt16LE(ch[i]!, (i * channels.length + c) * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels.length, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2 * channels.length, 28);
  header.writeUInt16LE(2 * channels.length, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('splitWavChannels', () => {
  it('splits a two-channel WAV into two mono WAVs, sample for sample', () => {
    const [a, b] = splitWavChannels(wav([[1, 2, 3], [-1, -2, -3]]));
    expect(a!.readUInt16LE(22)).toBe(1);
    expect([a!.readInt16LE(44), a!.readInt16LE(46), a!.readInt16LE(48)]).toEqual([1, 2, 3]);
    expect([b!.readInt16LE(44), b!.readInt16LE(46), b!.readInt16LE(48)]).toEqual([-1, -2, -3]);
    expect(b!.readUInt32LE(24)).toBe(8000);
  });

  it('refuses what it cannot read', () => {
    expect(() => splitWavChannels(Buffer.from('not a wav at all, really'))).toThrow();
  });
});

describe('mergeChannels', () => {
  it('labels them and the owner, in time order, without empty lines', () => {
    expect(
      mergeChannels(
        [
          { start: 0.5, text: 'Thanks for calling.' },
          { start: 9, text: '' },
          { start: 12, text: 'I can send a technician.' },
        ],
        [{ start: 4, text: 'The coax signal is low.' }],
      ),
    ).toEqual([
      { role: 'user', start: 0.5, text: 'Thanks for calling.' },
      { role: 'owner', start: 4, text: 'The coax signal is low.' },
      { role: 'user', start: 12, text: 'I can send a technician.' },
    ]);
  });
});

// DB-backed (banjo_test — see vitest.config.ts).
let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let callTranscriptTurns: any;
let saveTransferLeg: typeof import('../../src/transcripts/transferLeg.js').saveTransferLeg;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  ({ callTranscriptTurns } = await import('../../src/transcripts/schema.js'));
  ({ saveTransferLeg } = await import('../../src/transcripts/transferLeg.js'));
});

async function clearTables() {
  await db.delete(callTranscriptTurns);
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}
beforeEach(clearTables);
afterAll(clearTables);

async function makeAttempt() {
  const [contact] = await db.insert(contacts).values({ displayName: 'Xfinity', phoneNumber: '+18005550100' }).returning();
  const [task] = await db
    .insert(tasks)
    .values({ contactId: contact.id, channel: 'phone', goalDescription: 'File a ticket', constraints: {}, status: 'transferred' })
    .returning();
  const [attempt] = await db.insert(callAttempts).values({ taskId: task.id }).returning();
  await db.insert(callTranscriptTurns).values({
    callAttemptId: attempt.id,
    seq: 1,
    role: 'assistant',
    text: 'Connecting you now.',
    quality: 'ok',
    voiceProvider: 'openai',
    spokenAt: new Date('2026-10-19T01:17:05Z'),
  });
  return attempt;
}

const RECORDING = 'RE' + 'a'.repeat(32);
const STARTED = new Date('2026-10-19T01:17:30Z');

function deps(overrides: Record<string, unknown> = {}) {
  return {
    fetchRecordingWav: vi.fn(async () => wav([[1, 2], [3, 4]])),
    deleteRecording: vi.fn(async () => {}),
    transcribe: vi
      .fn()
      .mockResolvedValueOnce([{ start: 0, text: 'Thanks for holding, how can I help?' }])
      .mockResolvedValueOnce([{ start: 3.5, text: "Hi, I'm the account holder." }]),
    retryDelayMs: 1,
    ...overrides,
  };
}

describe('saveTransferLeg', () => {
  it('appends the transferred part after Banjo’s lines, labelled, then deletes the recording', async () => {
    const attempt = await makeAttempt();
    const d = deps();
    expect(await saveTransferLeg({ callId: attempt.id, recordingId: RECORDING, startedAt: STARTED }, d)).toBe(2);
    const rows = await db.select().from(callTranscriptTurns).orderBy(callTranscriptTurns.seq);
    expect(rows.map((r: any) => [r.seq, r.role, r.leg, r.text])).toEqual([
      [1, 'assistant', 'banjo', 'Connecting you now.'],
      [2, 'user', 'transferred', 'Thanks for holding, how can I help?'],
      [3, 'owner', 'transferred', "Hi, I'm the account holder."],
    ]);
    expect(rows[2].spokenAt.toISOString()).toBe('2026-10-19T01:17:33.500Z');
    expect(d.deleteRecording).toHaveBeenCalledWith(RECORDING);
  });

  it('deletes the recording even when transcription keeps failing, after retrying', async () => {
    const attempt = await makeAttempt();
    const d = deps({ transcribe: vi.fn(async () => Promise.reject(new Error('OpenAI down'))) });
    expect(await saveTransferLeg({ callId: attempt.id, recordingId: RECORDING, startedAt: STARTED }, d)).toBe(0);
    expect(d.transcribe).toHaveBeenCalledTimes(6);
    expect(d.deleteRecording).toHaveBeenCalledWith(RECORDING);
    expect(await db.select().from(callTranscriptTurns)).toHaveLength(1);
  });

  it('deletes a recording for a call it has no record of, saving nothing', async () => {
    const d = deps();
    expect(await saveTransferLeg({ callId: '44444444-4444-4444-4444-444444444444', recordingId: RECORDING, startedAt: STARTED }, d)).toBe(0);
    expect(d.fetchRecordingWav).not.toHaveBeenCalled();
    expect(d.deleteRecording).toHaveBeenCalledWith(RECORDING);
  });
});
