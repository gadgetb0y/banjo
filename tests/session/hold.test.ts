import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallSessionOptions } from '../../src/session/callSession.js';
import type { CallContext } from '../../src/session/types.js';
import type { TelephonyEvent, TelephonyProvider } from '../../src/telephony/providers/types.js';
import type { VoiceAIEvent, VoiceAIProvider } from '../../src/voice/types.js';
import { defineVoiceTool } from '../../src/voice/tools/defineVoiceTool.js';
import { holdBudgetMs, isRepeatOnHold, personPickedUpNote } from '../../src/session/hold.js';

// Waiting on hold (#151), at the VoiceAIProvider/TelephonyProvider boundary,
// like tests/session/callSession.test.ts, with a voice provider that can hold.
const voiceAIEmitter = new EventEmitter();
const fakeVoiceAI = {
  name: 'fake-voice',
  maxSessionMs: 60 * 60_000 as number | undefined,
  connect: vi.fn(async () => {}),
  sendAudioChunk: vi.fn(),
  sendToolResult: vi.fn(),
  interrupt: vi.fn(),
  triggerResponse: vi.fn(),
  sayVerbatim: vi.fn(),
  setHold: vi.fn(),
  addContext: vi.fn(),
  judgeHoldLine: vi.fn(async (_line: string, _earlier: string[]) => 'recording' as 'person' | 'recording'),
  disconnect: vi.fn(async () => {}),
  on: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.on('event', listener)),
  off: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.off('event', listener)),
} satisfies VoiceAIProvider;

vi.mock('../../src/voice/factory.js', () => ({ createVoiceAIProvider: () => fakeVoiceAI }));

const { CallSession } = await import('../../src/session/callSession.js');

const waitOnHold = defineVoiceTool({ name: 'wait_on_hold', description: 'hold', schema: z.object({}), startsHold: true, handler: async () => ({ ok: true }) });

function setup(overrides: Partial<CallSessionOptions> = {}) {
  const emitter = new EventEmitter();
  const telephony: TelephonyProvider = {
    name: 'fake-telephony',
    nativeAudioFormat: 'g711_ulaw_8k',
    originateCall: vi.fn(async () => ({ providerCallId: 'CA-1' })),
    sendAudio: vi.fn(),
    sendDigits: vi.fn(async () => {}),
    interrupt: vi.fn(),
    hangUp: vi.fn(async () => {}),
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
  };
  const options: CallSessionOptions = {
    callId: 'call-1',
    telephony,
    systemPrompt: 'irrelevant',
    tools: [waitOnHold],
    openingLine: "Hi, I'm an AI assistant calling on behalf of Alex.",
    beginCall: vi.fn(async () => ({ providerCallId: 'CA-1' })),
    buildToolContext: vi.fn(async () => ({}) as CallContext),
    onStatusChange: vi.fn(async () => {}),
    onFailure: vi.fn(async () => {}),
    notifyIfTerminal: vi.fn(async () => {}),
    onTranscript: vi.fn(async () => {}),
    onHoldChange: vi.fn(async () => {}),
    onHoldLimit: vi.fn(async () => {}),
    maxHoldMs: 5 * 60_000,
    ...overrides,
  };
  const emitTelephony = (e: TelephonyEvent) => emitter.emit('event', e);
  return { options, telephony, emitTelephony };
}

const voice = (e: VoiceAIEvent) => voiceAIEmitter.emit('event', e);
const heard = (text: string) => voice({ type: 'transcript', role: 'user', text, isFinal: true });

async function onHold(overrides: Partial<CallSessionOptions> = {}) {
  const s = setup(overrides);
  const session = new CallSession(s.options);
  await session.start();
  s.emitTelephony({ callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId: 'CA-1', toNumber: '+15555550100' } });
  voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
  await vi.waitFor(() => expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(true));
  return { ...s, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  voiceAIEmitter.removeAllListeners();
  fakeVoiceAI.maxSessionMs = 60 * 60_000;
  fakeVoiceAI.judgeHoldLine.mockImplementation(async () => 'recording');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isRepeatOnHold', () => {
  it('skips a line that repeats one already heard, allowing for transcription differences', () => {
    const before = ['Your call is important to us. Please stay on the line.'];
    expect(isRepeatOnHold('your call is important to us, please stay on the line', before)).toBe(true);
    expect(isRepeatOnHold('Your call is important to us. Please stay on the line and hold.', before)).toBe(true);
  });

  it("never skips a person picking up: they say something new", () => {
    const before = ['Your call is important to us. Please stay on the line.', 'Please hold.'];
    expect(isRepeatOnHold('Thanks for holding, this is Dana. How can I help?', before)).toBe(false);
    expect(isRepeatOnHold('Hello?', before)).toBe(false);
  });

  it('skips a line with no words in it', () => {
    expect(isRepeatOnHold('...', [])).toBe(true);
  });
});

describe('holdBudgetMs', () => {
  const base = { maxHoldMs: 20 * 60_000, now: 0, sessionStartedAt: 0, maxSessionMs: 60 * 60_000, reserveMs: 10 * 60_000 };
  it("is the call's limit when the session has room", () => {
    expect(holdBudgetMs(base)).toBe(20 * 60_000);
  });
  it('is cut short to leave the session time to talk in', () => {
    expect(holdBudgetMs({ ...base, now: 40 * 60_000 })).toBe(10 * 60_000);
    expect(holdBudgetMs({ ...base, now: 55 * 60_000 })).toBeLessThanOrEqual(0);
  });
  it('is just the limit for a provider with no known session length', () => {
    expect(holdBudgetMs({ ...base, maxSessionMs: undefined, now: 500 * 60_000 })).toBe(20 * 60_000);
  });
});

describe('personPickedUpNote', () => {
  it('has Banjo open again with the disclosure, and is fixed text', () => {
    const note = personPickedUpNote("Hi, I'm an AI assistant calling on behalf of Alex.");
    expect(note).toContain(`Your first sentence must be: "Hi, I'm an AI assistant calling on behalf of Alex."`);
    expect(note).toContain('wait_on_hold again');
  });
});

describe('CallSession on hold (#151)', () => {
  it('goes on hold silently: no reply to the tool result, and the owner is told the limit', async () => {
    const { options } = await onHold();
    expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-1', { ok: true }, false, { respond: false });
    expect(options.onHoldChange).toHaveBeenCalledWith({ kind: 'started', maxMs: 5 * 60_000 });
  });

  it("never nudges the model on hold, however long it's quiet", async () => {
    vi.useFakeTimers();
    await onHold();
    heard('Please hold.');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
  });

  it('judges each new line once, with what came before, and skips repeats', async () => {
    await onHold();
    heard('Please hold. Your call is important to us.');
    await vi.waitFor(() => expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(1));
    heard('please hold, your call is important to us');
    heard('The estimated wait time is five minutes.');
    await vi.waitFor(() => expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(2));
    expect(fakeVoiceAI.judgeHoldLine).toHaveBeenLastCalledWith('The estimated wait time is five minutes.', ['Please hold. Your call is important to us.']);
    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
    expect(fakeVoiceAI.setHold).not.toHaveBeenCalledWith(false);
  });

  it('judges only the latest of the lines that arrive while a judgment is out', async () => {
    let finish!: (v: 'person' | 'recording') => void;
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await onHold();
    heard('Please hold.');
    heard('Press 1 to leave a callback number.');
    heard('Our hours are nine to five.');
    finish('recording');
    await vi.waitFor(() => expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(2));
    expect(fakeVoiceAI.judgeHoldLine).toHaveBeenLastCalledWith('Our hours are nine to five.', ['Please hold.']);
  });

  it('a person picks up: off hold, the owner is told, and Banjo opens to them with the disclosure', async () => {
    const { options } = await onHold();
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'person');
    heard('Thanks for holding, this is Dana. How can I help?');

    await vi.waitFor(() => expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(false));
    // Their words as a user line after a fixed note, never inside instructions:
    // a cue would replace the session's instructions and quote them there.
    expect(fakeVoiceAI.addContext).toHaveBeenCalledWith([
      { role: 'system', text: personPickedUpNote(options.openingLine) },
      { role: 'user', text: 'Thanks for holding, this is Dana. How can I help?' },
    ]);
    expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledWith();
    expect(options.onHoldChange).toHaveBeenCalledWith({ kind: 'person', waitedMs: expect.any(Number) });
    // Off hold, lines go to the model as usual, not to the judge.
    heard('Hello?');
    expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(1);
  });

  it('the limit runs out: recorded, then the call ends', async () => {
    vi.useFakeTimers();
    const { options, telephony } = await onHold({ maxHoldMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(options.onHoldLimit).toHaveBeenCalledWith(60_000);
    expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(telephony.hangUp).toHaveBeenCalled());
    expect(options.onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ended', reason: 'hold_limit' }));
  });

  it('the other party hanging up ends the hold, and a late judgment changes nothing', async () => {
    let finish!: (v: 'person' | 'recording') => void;
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { options, emitTelephony } = await onHold();
    heard('Please hold.');
    emitTelephony({ callId: 'call-1', type: 'ended', reason: 'stop' });
    await vi.waitFor(() => expect(options.onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ended' })));
    finish('person');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
    expect(options.onHoldLimit).not.toHaveBeenCalled();
  });

  it('refuses a hold with no session time left to talk in afterwards, and stays off hold', async () => {
    fakeVoiceAI.maxSessionMs = 5 * 60_000; // less than the 10 minutes kept back
    const s = setup();
    await new CallSession(s.options).start();
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.waitFor(() => expect(fakeVoiceAI.sendToolResult).toHaveBeenCalled());
    expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-1', expect.objectContaining({ ok: false, error: 'hold_unavailable' }), true);
    expect(fakeVoiceAI.setHold).not.toHaveBeenCalled();
  });

  it('refuses a second hold while already holding', async () => {
    await onHold();
    voice({ type: 'tool_call', call: { id: 'hold-2', name: 'wait_on_hold', arguments: {} } });
    await vi.waitFor(() =>
      expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-2', expect.objectContaining({ error: 'already_on_hold' }), true),
    );
  });
});

describe('recording consent on hold (#151, #8)', () => {
  const NOTICE_LINE = "Hi, I'm an AI assistant calling on behalf of Alex. This call is recorded.";

  /** A call whose recording is running: the notice was said, its turn ended, and the start timer fired. */
  async function recordedCall(telephonyOverrides: Partial<TelephonyProvider> = {}) {
    vi.useFakeTimers();
    const s = setup({ recordCalls: true });
    Object.assign(s.telephony, {
      startRecording: vi.fn(async () => ({ recordingId: 'RE-1' })),
      pauseRecording: vi.fn(async () => 'paused' as const),
      resumeRecording: vi.fn(async () => {}),
      ...telephonyOverrides,
    });
    const session = new CallSession(s.options);
    await session.start();
    s.emitTelephony({ callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId: 'CA-1', toNumber: '+15555550100' } });
    voice({ type: 'transcript', role: 'assistant', text: NOTICE_LINE, isFinal: true });
    voice({ type: 'turn_end' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.telephony.startRecording).toHaveBeenCalledTimes(1);
    return s;
  }

  it('pauses a running recording before going on hold, and resumes only after the notice is said again', async () => {
    const s = await recordedCall();
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.telephony.pauseRecording).toHaveBeenCalledWith('call-1');
    expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(true);

    // A person picks up and talks: still not recorded.
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'person');
    heard('This is Dana, how can I help?');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.telephony.resumeRecording).not.toHaveBeenCalled();

    // Banjo says the notice to them; once its turn has played, recording resumes, never restarts.
    voice({ type: 'transcript', role: 'assistant', text: NOTICE_LINE, isFinal: true });
    voice({ type: 'turn_end' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.telephony.resumeRecording).toHaveBeenCalledWith('call-1');
    expect(s.telephony.startRecording).toHaveBeenCalledTimes(1);
  });

  it('a recording that could only be stopped stays stopped', async () => {
    const s = await recordedCall({ pauseRecording: vi.fn(async () => 'stopped' as const) });
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.advanceTimersByTimeAsync(0);
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'person');
    heard('This is Dana.');
    await vi.advanceTimersByTimeAsync(0);
    voice({ type: 'transcript', role: 'assistant', text: NOTICE_LINE, isFinal: true });
    voice({ type: 'turn_end' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.telephony.resumeRecording).not.toHaveBeenCalled();
    expect(s.telephony.startRecording).toHaveBeenCalledTimes(1);
  });

  it('fails closed: no hold if a running recording can be neither paused nor stopped', async () => {
    await recordedCall({ pauseRecording: vi.fn(async () => { throw new Error('twilio 500'); }) });
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-1', expect.objectContaining({ ok: false, error: 'hold_unavailable' }), true);
    expect(fakeVoiceAI.setHold).not.toHaveBeenCalled();
  });

  it('a recording scheduled but not yet started is called off, and starts after the notice is said again', async () => {
    vi.useFakeTimers();
    const s = setup({ recordCalls: true });
    Object.assign(s.telephony, { startRecording: vi.fn(async () => ({ recordingId: 'RE-1' })), pauseRecording: vi.fn(), resumeRecording: vi.fn() });
    await new CallSession(s.options).start();
    s.emitTelephony({ callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId: 'CA-1', toNumber: '+15555550100' } });
    voice({ type: 'transcript', role: 'assistant', text: NOTICE_LINE, isFinal: true });
    voice({ type: 'turn_end' });
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.telephony.startRecording).not.toHaveBeenCalled();
    expect(s.telephony.pauseRecording).not.toHaveBeenCalled();
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'person');
    heard('This is Dana.');
    await vi.advanceTimersByTimeAsync(0);
    voice({ type: 'transcript', role: 'assistant', text: NOTICE_LINE, isFinal: true });
    voice({ type: 'turn_end' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.telephony.startRecording).toHaveBeenCalledTimes(1);
  });
});

describe('waiting on hold needs every hold method', () => {
  it('refuses on a provider that cannot add context', async () => {
    const addContext = fakeVoiceAI.addContext;
    // @ts-expect-error removed for this test only
    delete fakeVoiceAI.addContext;
    try {
      const s = setup();
      await new CallSession(s.options).start();
      voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
      await vi.waitFor(() => expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-1', expect.objectContaining({ error: 'hold_unsupported' }), true));
    } finally {
      fakeVoiceAI.addContext = addContext;
    }
  });
});
