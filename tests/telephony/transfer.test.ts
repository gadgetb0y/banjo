import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

// transfer.ts reuses waitForPlayback from callTools.ts, which imports the task
// service; stub it so nothing here reaches a DB.
const { recordTransferResult } = vi.hoisted(() => ({ recordTransferResult: vi.fn(async () => true) }));
vi.mock('../../src/tasks/service.js', () => ({ transitionTask: vi.fn(), isTerminalStatus: () => false, recordTransferResult }));

const { config } = await import('../../src/config/index.js');
const { defineTransferTool, transferAfterSpeaking, LOOP_IN_TIMEOUT_MS, TRANSFER_TOOL_NAME, TRANSFER_HANDLER_BUDGET_MS, WARM_TRANSFER_HANDLER_BUDGET_MS } = await import('../../src/telephony/transfer.js');

function ctxWith(transferCall?: TelephonyProvider['transferCall'], estimatedAudioDoneAt = Date.now()) {
  return {
    callId: 'call-1',
    estimatedAudioDoneAt,
    telephony: { transferCall } as unknown as TelephonyProvider,
  };
}

beforeEach(() => {
  config.TRANSFER_TO_PHONE_NUMBER = '+15557654321';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('transferAfterSpeaking (#7)', () => {
  it('waits for the handoff line to finish playing, then transfers to the configured number', async () => {
    vi.useFakeTimers();
    const transferCall = vi.fn(async () => {});
    const done = transferAfterSpeaking(ctxWith(transferCall, Date.now() + 2000));

    await vi.advanceTimersByTimeAsync(1500);
    expect(transferCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(transferCall).toHaveBeenCalledWith('call-1', { to: '+15557654321' });
  });

  it('throws when the provider cannot transfer', async () => {
    await expect(transferAfterSpeaking(ctxWith(undefined))).rejects.toThrow(/transfer/i);
  });
});

describe('defineTransferTool (#7)', () => {
  it('is named transfer_to_owner, ends the call, and has no verbatim message', () => {
    const tool = defineTransferTool({ onTransferred: vi.fn(async () => {}) });
    expect(tool.name).toBe(TRANSFER_TOOL_NAME);
    expect(tool.endsCall).toBe(true);
    expect(tool.verbatimMessage).toBeUndefined();
    expect(tool.schema.safeParse({ reason: 'needs a card number' }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it('records the transfer only after the redirect succeeds', async () => {
    const transferCall = vi.fn(async () => {});
    const onTransferred = vi.fn(async () => {});
    const tool = defineTransferTool({ onTransferred });

    const result = await tool.handler({ reason: 'needs a card number' }, ctxWith(transferCall));

    expect(result).toEqual({ ok: true });
    expect(onTransferred).toHaveBeenCalledWith({ reason: 'needs a card number' }, expect.objectContaining({ callId: 'call-1' }));
    expect(transferCall.mock.invocationCallOrder[0]).toBeLessThan(onTransferred.mock.invocationCallOrder[0]!);
  });

  it('returns transfer_failed and records nothing when the redirect fails (e.g. the callee already hung up)', async () => {
    const transferCall = vi.fn(async () => {
      throw new Error('transferCall: no live Twilio call for call-1');
    });
    const onTransferred = vi.fn(async () => {});
    const tool = defineTransferTool({ onTransferred });

    const result = await tool.handler({ reason: 'x' }, ctxWith(transferCall));

    expect(result).toMatchObject({ ok: false, error: 'transfer_failed' });
    expect(onTransferred).not.toHaveBeenCalled();
  });

  it('declares a handler budget covering the playback wait and both Twilio REST calls, so CallSession waits for it', () => {
    const tool = defineTransferTool({ onTransferred: vi.fn(async () => {}) });
    expect(tool.handlerBudgetMs).toBe(TRANSFER_HANDLER_BUDGET_MS);
    expect(TRANSFER_HANDLER_BUDGET_MS).toBeGreaterThanOrEqual(6_000 + 2 * 30_000);
  });

  it('a redirect slower than TOOL_TIMEOUT_MS still reports success — it is never cut off part-way', async () => {
    vi.useFakeTimers();
    const transferCall = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, config.TOOL_TIMEOUT_MS + 5_000)));
    const onTransferred = vi.fn(async () => {});
    const tool = defineTransferTool({ onTransferred });

    const result = tool.handler({ reason: 'x' }, ctxWith(transferCall));
    await vi.advanceTimersByTimeAsync(config.TOOL_TIMEOUT_MS + 6_000);

    expect(await result).toEqual({ ok: true });
    expect(onTransferred).toHaveBeenCalledTimes(1);
  });

  it('still reports success when recording it afterwards fails — the call has already been handed over', async () => {
    const tool = defineTransferTool({
      onTransferred: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const result = await tool.handler({ reason: 'x' }, ctxWith(vi.fn(async () => {})));
    expect(result).toEqual({ ok: true });
  });
});

describe('transfer_to_owner with TRANSFER_MODE=warm (#149)', () => {
  beforeEach(() => {
    config.TRANSFER_MODE = 'warm';
    recordTransferResult.mockClear();
  });
  afterEach(() => {
    config.TRANSFER_MODE = 'cold';
  });

  function warmCtx(loopInOwner: TelephonyProvider['loopInOwner']) {
    return { callId: 'call-1', estimatedAudioDoneAt: Date.now(), telephony: { loopInOwner } as unknown as TelephonyProvider };
  }

  it("reaches the owner with the reason as the brief, and records the transfer once they accept", async () => {
    const loopInOwner = vi.fn(async () => 'accepted' as const);
    const onTransferred = vi.fn(async () => {});
    const tool = defineTransferTool({ onTransferred });

    const result = await tool.handler({ reason: "Pam at Claudia's needs you." }, warmCtx(loopInOwner));

    expect(result).toEqual({ ok: true });
    expect(loopInOwner).toHaveBeenCalledWith('call-1', { to: '+15557654321', brief: "Pam at Claudia's needs you.", timeoutMs: LOOP_IN_TIMEOUT_MS });
    expect(onTransferred).toHaveBeenCalledTimes(1);
    expect(recordTransferResult).toHaveBeenCalledWith('call-1', 'answered');
  });

  it.each([
    ['declined', 'declined', "can't take the call"],
    ['no_answer', 'no_answer', "didn't pick up"],
  ] as const)('%s: the call stays with Banjo, which is told to say so and carry on', async (loopInResult, recorded, said) => {
    const onTransferred = vi.fn(async () => {});
    const tool = defineTransferTool({ onTransferred });

    const result = await tool.handler({ reason: 'needs you' }, warmCtx(vi.fn(async () => loopInResult)));

    expect(result).toMatchObject({ ok: false, error: 'owner_unavailable', result: loopInResult });
    expect((result as { message: string }).message).toContain(said);
    expect((result as { message: string }).message).toContain('You are still on the call');
    expect(onTransferred).not.toHaveBeenCalled();
    expect(recordTransferResult).toHaveBeenCalledWith('call-1', recorded);
  });

  it("reports a failure when the owner's call can't be placed, and a provider that can't do it", async () => {
    const tool = defineTransferTool({ onTransferred: vi.fn(async () => {}) });
    const failed = await tool.handler({ reason: 'needs you' }, warmCtx(vi.fn(async () => { throw new Error('twilio 400'); })));
    expect(failed).toMatchObject({ ok: false, error: 'transfer_failed', message: 'twilio 400' });
    const unsupported = await tool.handler({ reason: 'needs you' }, warmCtx(undefined));
    expect(unsupported).toMatchObject({ ok: false, error: 'transfer_failed' });
  });

  it("still succeeds when recording the result fails: the owner is already on the call", async () => {
    recordTransferResult.mockRejectedValueOnce(new Error('db down'));
    const tool = defineTransferTool({ onTransferred: vi.fn(async () => {}) });
    await expect(tool.handler({ reason: 'needs you' }, warmCtx(vi.fn(async () => 'accepted' as const)))).resolves.toEqual({ ok: true });
  });

  it('budgets for the wait on the owner, says the reason is read to them, and keeps it short', () => {
    const tool = defineTransferTool({ onTransferred: vi.fn(async () => {}) });
    expect(tool.handlerBudgetMs).toBe(WARM_TRANSFER_HANDLER_BUDGET_MS);
    expect(WARM_TRANSFER_HANDLER_BUDGET_MS).toBeGreaterThanOrEqual(TRANSFER_HANDLER_BUDGET_MS + LOOP_IN_TIMEOUT_MS);
    expect(tool.description).toContain('second line');
    expect(tool.schema.safeParse({ reason: 'x'.repeat(301) }).success).toBe(false);
  });
});
