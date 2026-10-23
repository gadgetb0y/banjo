import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseScriptLines, runScript } from '../../src/sim/script.js';
import type { TextVoiceAIProvider } from '../../src/sim/simCall.js';
import type { SimTelephonyProvider } from '../../src/sim/simTelephony.js';
import type { VoiceAIEvent } from '../../src/voice/types.js';

describe('parseScriptLines', () => {
  it('reads plain, recording and silence steps', () => {
    expect(parseScriptLines(['Hello?', '~Please hold.', '(silence 20)'])).toEqual([
      { kind: 'line', text: 'Hello?' },
      { kind: 'recording', text: 'Please hold.' },
      { kind: 'silence', seconds: 20 },
    ]);
  });

  it('rejects a silence step without a whole number from 1 to 120', () => {
    expect(() => parseScriptLines(['(silence 0)'])).toThrow(/silence/);
    expect(() => parseScriptLines(['(silence x)'])).toThrow(/silence/);
    expect(() => parseScriptLines(['(silence 121)'])).toThrow(/silence/);
  });
});

/** Just enough of the voice session and phone line for runScript. */
function fakes() {
  const voiceEvents = new EventEmitter();
  const phoneEvents = new EventEmitter();
  const sent: string[] = [];
  const voice = {
    sendUserText: (text: string) => sent.push(text),
    on: (_: 'event', l: (e: VoiceAIEvent) => void) => voiceEvents.on('event', l),
  } as unknown as TextVoiceAIProvider;
  let hungUp = false;
  const telephony = {
    calleeHangsUp: () => {
      hungUp = true;
      phoneEvents.emit('event', { type: 'ended', callId: 'c', reason: 'callee' });
    },
    on: (_: 'event', l: (e: unknown) => void) => phoneEvents.on('event', l),
  } as unknown as SimTelephonyProvider;
  const banjoSays = (text: string) => voiceEvents.emit('event', { type: 'transcript', role: 'assistant', text, isFinal: true });
  return { voice, telephony, sent, banjoSays, hungUp: () => hungUp };
}

describe('runScript', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says the first line at once, and the next once Banjo has spoken and gone quiet', () => {
    const f = fakes();
    void runScript(parseScriptLines(['Hello?', 'Sure.']), f.voice, f.telephony, () => {});
    expect(f.sent).toEqual(['Hello?']);
    f.banjoSays("Hi, I'm an AI assistant.");
    vi.advanceTimersByTime(1499);
    expect(f.sent).toEqual(['Hello?']);
    vi.advanceTimersByTime(1);
    expect(f.sent).toEqual(['Hello?', 'Sure.']);
  });

  it('plays a ~ line 3 seconds after the one before it, without waiting for Banjo', () => {
    const f = fakes();
    void runScript(parseScriptLines(['~Thank you for calling.', '~Press 1 for appointments.']), f.voice, f.telephony, () => {});
    vi.advanceTimersByTime(2999);
    expect(f.sent).toEqual(['Thank you for calling.']);
    vi.advanceTimersByTime(1);
    expect(f.sent).toEqual(['Thank you for calling.', 'Press 1 for appointments.']);
  });

  it('a silence step sends nothing for N seconds, then plays the next line', () => {
    const f = fakes();
    void runScript(parseScriptLines(['Anything else?', '(silence 20)', 'Hello?']), f.voice, f.telephony, () => {});
    f.banjoSays('No, that was all.');
    vi.advanceTimersByTime(1500); // reaches the silence step
    vi.advanceTimersByTime(20_000 - 1);
    expect(f.sent).toEqual(['Anything else?']);
    vi.advanceTimersByTime(1);
    f.banjoSays('Are you still there?');
    vi.advanceTimersByTime(1500);
    expect(f.sent).toEqual(['Anything else?', 'Hello?']);
  });

  it('hangs up 15 seconds after the last line if Banjo has not ended the call, and resolves', async () => {
    const f = fakes();
    const done = runScript(parseScriptLines(['Hello?']), f.voice, f.telephony, () => {});
    f.banjoSays('Hi!');
    vi.advanceTimersByTime(15_000 - 1);
    expect(f.hungUp()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(f.hungUp()).toBe(true);
    await expect(done).resolves.toBeUndefined();
  });
});
