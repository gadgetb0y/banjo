import type { CallSession } from '../session/callSession.js';

/**
 * The calls this process is driving right now.
 *
 * `runTask` used to create a CallSession, await it, and drop it — nothing
 * outside that function could reach a call in flight. That's why there was no
 * way to stop a call once it started, and why the orchestration poller
 * couldn't tell a live call from one whose process had died mid-conversation.
 *
 * Deliberately in-memory and per-process: a CallSession owns live WebSocket
 * state (the Twilio Media Stream IS the call — see callSession.ts), so it
 * cannot be reached from anywhere but the process holding it. Anything
 * consulting this registry has to treat "not here" as "not running *here*",
 * never as "not running at all".
 */
export interface LiveCall {
  taskId: string;
  callAttemptId: string;
  session: Pick<CallSession, 'stop'>;
  startedAt: Date;
}

const liveCalls = new Map<string, LiveCall>();

export function registerLiveCall(input: Omit<LiveCall, 'startedAt'> & { startedAt?: Date }): void {
  liveCalls.set(input.taskId, { ...input, startedAt: input.startedAt ?? new Date() });
}

export function unregisterLiveCall(taskId: string): void {
  liveCalls.delete(taskId);
}

export function getLiveCall(taskId: string): LiveCall | undefined {
  return liveCalls.get(taskId);
}

export function listLiveCalls(): LiveCall[] {
  return [...liveCalls.values()];
}
