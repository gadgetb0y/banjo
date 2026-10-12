import { EventEmitter } from 'node:events';
import type { LoopInResult, TelephonyEvent, TelephonyEventListener, TelephonyProvider } from '../telephony/providers/types.js';
import type { AudioChunk } from '../voice/types.js';

/**
 * The simulator's phone line (scripts/sim.ts, ROADMAP 4.5). There is no call:
 * the "callee" is whoever is typing, and their lines go straight to the text
 * voice session. What this keeps real is the telephony event flow CallSession
 * runs on — connected, then ended — and the control actions a tool can take
 * (press digits, hang up, transfer), which it reports through `print` instead
 * of carrying out.
 */
/** How long the sim's owner "rings" on a warm transfer: long enough to feel like a hold, short enough not to bore. */
const LOOP_IN_RING_MS = 2_000;

export class SimTelephonyProvider implements TelephonyProvider {
  readonly name = 'sim';
  readonly nativeAudioFormat = 'g711_ulaw_8k' as const;

  private emitter = new EventEmitter();
  private ended = new Set<string>();
  private lastCallId: string | undefined;

  /**
   * `owner`: what the owner does when a warm transfer (#149) calls them. The
   * sim has no second line, so their answer is set up front (--owner).
   */
  constructor(
    private readonly print: (line: string) => void,
    private readonly owner: LoopInResult = 'accepted',
  ) {}

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

  /** Warm transfer (#149): reports the brief, then answers as `owner` says, after a moment's ringing. */
  async loopInOwner(callId: string, opts: { to: string; brief: string }): Promise<LoopInResult> {
    this.print(`[Banjo is calling the owner at ${opts.to} on another line. They hear: "${opts.brief}"]`);
    await new Promise((resolve) => setTimeout(resolve, LOOP_IN_RING_MS));
    if (this.ended.has(callId)) return 'no_answer';
    if (this.owner === 'accepted') {
      this.print('[The owner pressed 1 and joined the call. Banjo left it.]');
      this.endCall(callId, 'transferred', null);
    } else {
      this.print(this.owner === 'declined' ? '[The owner declined. Banjo is back with you.]' : "[The owner didn't answer. Banjo is back with you.]");
    }
    return this.owner;
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
