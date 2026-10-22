import { eq, max } from 'drizzle-orm';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { inboundCalls } from '../inbound/schema.js';
import { logger } from '../lib/logger.js';
import { classifyTranscript } from '../session/transcriptQuality.js';
import { callAttempts } from '../tasks/schema.js';
import { callTranscriptTurns } from './schema.js';
import type { TranscriptCall } from './service.js';

/**
 * What the principal and the other party said after a cold transfer
 * (TRANSCRIBE_TRANSFERS). Banjo is off the call by then, so this part is
 * recorded by Twilio instead, one channel each (twilio.ts's transferCall),
 * after both heard a recording notice. Once the call ends, the recording is
 * transcribed into the call's transcript as leg 'transferred', then deleted:
 * only the transcript is kept. A failure here never touches a call, and the
 * recording is deleted even when transcription keeps failing.
 */

/** The model used for the transferred part: it returns segment timestamps, so the two channels can be merged in order. */
export const TRANSFER_TRANSCRIPTION_MODEL = 'whisper-1';

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

export interface TransferLegDeps {
  fetchRecordingWav(recordingId: string): Promise<Buffer>;
  deleteRecording(recordingId: string): Promise<void>;
  transcribe?: (wav: Buffer) => Promise<Segment[]>;
  retryDelayMs?: number;
}

export interface Segment {
  start: number;
  text: string;
}

/** A 16-bit PCM WAV, one buffer per channel, each a mono WAV of its own. */
export function splitWavChannels(wav: Buffer): Buffer[] {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = { format: wav.readUInt16LE(body), channels: wav.readUInt16LE(body + 2), sampleRate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before its format');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits} bits)`);
      const data = wav.subarray(body, Math.min(body + size, wav.length));
      const frame = 2 * fmt.channels;
      const frames = Math.floor(data.length / frame);
      return Array.from({ length: fmt.channels }, (_, ch) => {
        const pcm = Buffer.alloc(frames * 2);
        for (let i = 0; i < frames; i++) pcm.writeInt16LE(data.readInt16LE(i * frame + ch * 2), i * 2);
        return monoWav(pcm, fmt!.sampleRate);
      });
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data');
}

function monoWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** One channel through OpenAI's transcription API, with segment start times. */
async function transcribeWithOpenAI(wav: Buffer): Promise<Segment[]> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'channel.wav');
  form.append('model', TRANSFER_TRANSCRIPTION_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`transcription failed: OpenAI returned ${res.status}`);
  const json = (await res.json()) as { segments?: { start: number; text: string }[] };
  return (json.segments ?? []).map((s) => ({ start: s.start, text: s.text.trim() }));
}

/**
 * Channel 1 of a <Dial> recording is the call it was dialed from (the other
 * party), channel 2 the dialed call (the principal), per Twilio's dual-channel
 * recording docs. Merged by start time, empty lines dropped.
 */
export function mergeChannels(them: Segment[], owner: Segment[]): { role: 'user' | 'owner'; start: number; text: string }[] {
  return [
    ...them.map((s) => ({ role: 'user' as const, ...s })),
    ...owner.map((s) => ({ role: 'owner' as const, ...s })),
  ]
    .filter((s) => classifyTranscript(s.text) !== 'empty')
    .sort((a, b) => a.start - b.start);
}

/** Which call `callId` is: an outbound call attempt or an inbound call, both keyed by Banjo's own id. */
async function transcriptCallFor(callId: string): Promise<TranscriptCall | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(callId)) return undefined;
  const [attempt] = await db.select({ id: callAttempts.id }).from(callAttempts).where(eq(callAttempts.id, callId));
  if (attempt) return { callAttemptId: attempt.id };
  const [inbound] = await db.select({ id: inboundCalls.id }).from(inboundCalls).where(eq(inboundCalls.id, callId));
  return inbound ? { inboundCallId: inbound.id } : undefined;
}

/** Transcribes a transferred part's recording into its call's transcript, then deletes the recording. Never throws. */
export async function saveTransferLeg(
  input: { callId: string; recordingId: string; startedAt: Date },
  deps: TransferLegDeps,
): Promise<number> {
  const log = logger.child({ callId: input.callId, recordingId: input.recordingId });
  let saved = 0;
  try {
    const call = await transcriptCallFor(input.callId);
    if (!call) {
      log.warn('a transfer recording arrived for a call Banjo has no record of; deleting it');
    } else {
      saved = await withRetries(() => transcribeInto(call, input.startedAt, input.recordingId, deps), deps.retryDelayMs ?? RETRY_DELAY_MS, log);
      log.info({ lines: saved }, 'saved the transcript of the transferred part of the call');
    }
  } catch (err) {
    log.error({ err }, 'could not transcribe the transferred part of the call');
  }
  // Retried like the transcription: recording retention only knows the
  // recordings it started (call_attempts.recording_sid), not this one.
  try {
    await withRetries(() => deps.deleteRecording(input.recordingId), deps.retryDelayMs ?? RETRY_DELAY_MS, log);
    log.info('deleted the transfer recording');
  } catch (err) {
    log.error({ err }, 'could not delete the transfer recording: delete it in the Twilio console');
  }
  return saved;
}

async function transcribeInto(call: TranscriptCall, startedAt: Date, recordingId: string, deps: TransferLegDeps): Promise<number> {
  const channels = splitWavChannels(await deps.fetchRecordingWav(recordingId));
  if (channels.length !== 2) throw new Error(`expected a two-channel recording, got ${channels.length}`);
  const transcribe = deps.transcribe ?? transcribeWithOpenAI;
  const [them, owner] = await Promise.all([transcribe(channels[0]!), transcribe(channels[1]!)]);
  const lines = mergeChannels(them, owner);
  if (lines.length === 0) return 0;
  const column = call.callAttemptId ? callTranscriptTurns.callAttemptId : callTranscriptTurns.inboundCallId;
  const id = (call.callAttemptId ?? call.inboundCallId)!;
  return db.transaction(async (tx) => {
    const [last] = await tx.select({ seq: max(callTranscriptTurns.seq) }).from(callTranscriptTurns).where(eq(column, id));
    const first = (last?.seq ?? 0) + 1;
    await tx.insert(callTranscriptTurns).values(
      lines.map((line, i) => ({
        callAttemptId: call.callAttemptId ?? null,
        inboundCallId: call.inboundCallId ?? null,
        seq: first + i,
        role: line.role,
        leg: 'transferred' as const,
        text: line.text,
        quality: classifyTranscript(line.text) === 'suspect' ? ('suspect' as const) : ('ok' as const),
        voiceProvider: TRANSFER_TRANSCRIPTION_MODEL,
        spokenAt: new Date(startedAt.getTime() + Math.round(line.start * 1000)),
      })),
    );
    return lines.length;
  });
}

async function withRetries<T>(run: () => Promise<T>, delayMs: number, log: typeof logger): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      log.warn({ err, attempt }, 'transcribing the transferred part failed; retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
