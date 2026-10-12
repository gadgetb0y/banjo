import { EventEmitter } from 'node:events';
import type { TelephonyEvent, TelephonyEventListener, TelephonyProvider } from '../telephony/providers/types.js';
import type { AudioChunk } from '../voice/types.js';

/**
 * The simulator's phone line (scripts/sim.ts, ROADMAP 4.5). There is no call:
 * the "callee" is whoever is typing, and their lines go straight to the text
 * voice session. What this keeps real is the telephony event flow CallSession
 * runs on — connected, then ended — and the control actions a tool can take
 * (press digits, hang up, transfer), which it reports through `print` instead
 * of carrying out.
 */
export class SimTelephonyProvider implements TelephonyProvider {
  readonly name = 'sim';
  readonly nativeAudioFormat = 'g711_ulaw_8k' as const;

  private emitter = new EventEmitter();
  private ended = new Set<string>();
  private lastCallId: string | undefined;

  constructor(private readonly print: (line: string) => void) {}

  async originateCall(opts: { to: string; callId: string }): Promise<{ providerCallId: string }> {
    this.lastCallId = opts.callId;
    // On the next tick, as a real answer arrives after originateCall returns:
    // CallSession goes 'active' on this event, not on the return.
    const providerCallId = `SIM-${opts.callId}`;
    setImmediate(() =>
      this.emit({ callId: opts.callId, type: 'connected', meta: { callId: opts.callId, providerCallId, toNumber: opts.to } }),
    );
    return { providerCallId };
  }

  sendAudio(_callId: string, _chunk: AudioChunk): void {}

  async sendDigits(_callId: string, digits: string): Promise<void> {
    this.print(`[Banjo pressed ${digits}]`);
  }

  interrupt(_callId: string): void {}

  async hangUp(callId: string): Promise<void> {
    this.endCall(callId, 'hung up', 'Banjo hung up');
  }

  async transferCall(callId: string, opts: { to: string }): Promise<void> {
    this.print(`[Banjo transferred the call to the owner at ${opts.to}]`);
    this.endCall(callId, 'transferred', null);
  }

  /** The other party hangs up the current call (the sim's /hangup). */
  calleeHangsUp(): void {
    if (this.lastCallId) this.endCall(this.lastCallId, 'callee hung up', 'You hung up');
  }

  on(event: 'event', listener: TelephonyEventListener): void {
    this.emitter.on(event, listener);
  }

  off(event: 'event', listener: TelephonyEventListener): void {
    this.emitter.off(event, listener);
  }

  /** Reports and emits 'ended' once per call, as a real line goes dead once however many sides hang up. */
  private endCall(callId: string, reason: string, line: string | null): void {
    if (this.ended.has(callId)) return;
    this.ended.add(callId);
    if (line) this.print(`[${line}]`);
    this.emit({ callId, type: 'ended', reason });
  }

  private emit(event: TelephonyEvent): void {
    this.emitter.emit('event', event);
  }
}
