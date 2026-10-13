import { describe, expect, it, vi } from 'vitest';
import { SimTelephonyProvider } from '../../src/sim/simTelephony.js';
import type { TelephonyEvent } from '../../src/telephony/providers/types.js';

function setup() {
  const lines: string[] = [];
  const telephony = new SimTelephonyProvider((line) => lines.push(line));
  const events: TelephonyEvent[] = [];
  telephony.on('event', (event) => events.push(event));
  return { telephony, lines, events };
}

describe('SimTelephonyProvider', () => {
  it('answers on the next tick, after originateCall returns, as a real call would', async () => {
    const { telephony, events } = setup();
    const { providerCallId } = await telephony.originateCall({ to: '+12025550142', callId: 'call-1' });
    expect(events).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([
      { callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId, toNumber: '+12025550142' } },
    ]);
  });

  it('reports digits and transfers instead of carrying them out', async () => {
    const { telephony, lines, events } = setup();
    await telephony.originateCall({ to: '+12025550142', callId: 'call-1' });
    await telephony.sendDigits('call-1', '2');
    await telephony.transferCall('call-1', { to: '+12025550199' });
    expect(lines).toEqual(['[Banjo pressed 2]', '[Banjo transferred the call to the owner at +12025550199]']);
    expect(events.filter((e) => e.type === 'ended')).toEqual([{ callId: 'call-1', type: 'ended', reason: 'transferred' }]);
  });

  it('ends a call once, whoever hangs up first', async () => {
    const { telephony, lines, events } = setup();
    await telephony.originateCall({ to: '+12025550142', callId: 'call-1' });
    telephony.calleeHangsUp();
    await telephony.hangUp('call-1');
    expect(lines).toEqual(['[You hung up]']);
    expect(events.filter((e) => e.type === 'ended')).toEqual([{ callId: 'call-1', type: 'ended', reason: 'callee hung up' }]);
  });
});

describe('SimTelephonyProvider warm transfer (#149)', () => {
  it.each([
    ['accepted', 1, 'joined the call'],
    ['declined', 0, 'declined'],
    ['no_answer', 0, "didn't answer"],
  ] as const)('owner %s: reports the brief, then answers as set up', async (owner, endedEvents, reported) => {
    const lines: string[] = [];
    const telephony = new SimTelephonyProvider((line) => lines.push(line), owner);
    const events: TelephonyEvent[] = [];
    telephony.on('event', (event) => events.push(event));
    await telephony.originateCall({ to: '+12025550142', callId: 'call-1' });

    vi.useFakeTimers();
    try {
      const result = telephony.loopInOwner('call-1', { to: '+12025550199', brief: 'Pam needs you.' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toBe(owner);
    } finally {
      vi.useRealTimers();
    }

    expect(lines[0]).toContain('They hear: "Pam needs you."');
    expect(lines[1]).toContain(reported);
    expect(events.filter((e) => e.type === 'ended')).toHaveLength(endedEvents);
  });
});
