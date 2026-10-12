import { z } from 'zod';
import { config } from '../config/index.js';
import { childLogger } from '../lib/logger.js';
import type { TransferResult } from '../tasks/schema.js';
import { recordTransferResult } from '../tasks/service.js';
import { MAX_HANGUP_WAIT_MS, waitForPlayback } from '../voice/tools/callTools.js';
import { defineVoiceTool, type VoiceTool } from '../voice/tools/defineVoiceTool.js';
import type { LoopInResult, TelephonyProvider } from './providers/types.js';

const log = childLogger({ module: 'telephony.transfer' });

/**
 * transfer_to_owner — cold-transfer the live call to the principal (#7).
 *
 * Lives here, next to dtmf.ts, for the same reason press_digits does: the
 * transfer itself is phone signaling. What a transfer MEANS differs by
 * direction (an outbound task's outcome; a text about an inbound caller), so
 * each side builds its own tool from defineTransferTool with an
 * onTransferred hook — tasks/callSessionAdapter.ts and inbound/tools.ts.
 * Offered to the model only when TRANSFER_ENABLED is on.
 */
export const TRANSFER_TOOL_NAME = 'transfer_to_owner';

/** A warm transfer's reason is read aloud to the owner while the other party holds (#149): a brief, not a report. */
const TRANSFER_REASON_MAX_CHARS = 300;

export type TransferContext = { telephony: TelephonyProvider; callId: string; estimatedAudioDoneAt: number };

/** The twilio SDK's default per-request timeout (RequestClient, 30s); Banjo does not override it. */
const TWILIO_REST_TIMEOUT_MS = 30_000;

/**
 * How long transfer_to_owner's handler may run (VoiceTool.handlerBudgetMs).
 *
 * Unlike every other tool, this handler is NOT bounded by runToolSafely's
 * TOOL_TIMEOUT_MS. withTimeout cannot cancel work, and the work here is a
 * redirect that, once sent, may already have handed the call to the
 * principal. An 8s timeout firing while it was in flight told the model the
 * transfer failed (so it escalated or hung up a call that was being bridged),
 * and the handler finishing early let end() mark the task failed before the
 * redirect landed (#7 review). So the handler waits for the real answer, and
 * CallSession is told how long that can honestly take: the handoff line's
 * playback wait, then transferCall's two Twilio REST calls (stop the
 * recording, then redirect), each bounded only by the SDK's own timeout, then
 * recording the transfer (one TOOL_TIMEOUT_MS, which its one retry shares).
 * That is ~74s by default — a limit for a stuck call, not a normal duration:
 * a healthy transfer takes a second or two after the handoff line. A warm
 * transfer (#149) adds its wait for the owner: WARM_TRANSFER_HANDLER_BUDGET_MS.
 */
export const TRANSFER_HANDLER_BUDGET_MS = MAX_HANGUP_WAIT_MS + 2 * TWILIO_REST_TIMEOUT_MS + config.TOOL_TIMEOUT_MS;

/**
 * How long a warm transfer waits for the owner (#149) before going back to the
 * other party: their line rings for 25s, then the brief and two "press 1"
 * prompts. The other party is holding all this time, so it is kept short.
 */
export const LOOP_IN_TIMEOUT_MS = 60_000;

/**
 * A warm transfer adds the wait for the owner, and placing their call, to the
 * cold transfer's budget. The bridge's own REST calls (stop the recording,
 * redirect) start when they press 1 and may run past LOOP_IN_TIMEOUT_MS; the
 * cold budget's two REST timeouts cover those.
 */
export const WARM_TRANSFER_HANDLER_BUDGET_MS = TRANSFER_HANDLER_BUDGET_MS + LOOP_IN_TIMEOUT_MS + TWILIO_REST_TIMEOUT_MS;

/** Lets the handoff line finish ("connecting you now"), then redirects the call to TRANSFER_TO_PHONE_NUMBER. */
export async function transferAfterSpeaking(ctx: TransferContext): Promise<void> {
  if (!ctx.telephony.transferCall) throw new Error(`transfer: telephony provider ${ctx.telephony.name} cannot transfer calls`);
  if (!config.TRANSFER_TO_PHONE_NUMBER) throw new Error('transfer: TRANSFER_TO_PHONE_NUMBER is not set');
  await waitForPlayback(ctx);
  await ctx.telephony.transferCall(ctx.callId, { to: config.TRANSFER_TO_PHONE_NUMBER });
}

/**
 * Warm transfer (#149): lets the hold line finish ("let me see if they can
 * join, one moment"), then calls the owner on a second line with `brief`.
 * Records how it went on the call attempt, as a cold transfer's callback does.
 */
export async function loopInAfterSpeaking(ctx: TransferContext, brief: string): Promise<LoopInResult> {
  if (!ctx.telephony.loopInOwner) throw new Error(`transfer: telephony provider ${ctx.telephony.name} cannot do a warm transfer`);
  if (!config.TRANSFER_TO_PHONE_NUMBER) throw new Error('transfer: TRANSFER_TO_PHONE_NUMBER is not set');
  await waitForPlayback(ctx);
  const result = await ctx.telephony.loopInOwner(ctx.callId, { to: config.TRANSFER_TO_PHONE_NUMBER, brief, timeoutMs: LOOP_IN_TIMEOUT_MS });
  const recorded: Record<LoopInResult, TransferResult> = { accepted: 'answered', declined: 'declined', no_answer: 'no_answer' };
  await recordTransferResult(ctx.callId, recorded[result]).catch((err: unknown) =>
    log.error({ err, callId: ctx.callId, result }, 'could not record the warm transfer result'),
  );
  return result;
}

/** What the model hears when the owner doesn't take a warm transfer (#149): the call is still its own, so it says so and carries on. */
function ownerUnavailable(result: Exclude<LoopInResult, 'accepted'>) {
  const principal = config.ASSISTANT_PRINCIPAL_NAME;
  return {
    ok: false as const,
    error: 'owner_unavailable' as const,
    result,
    message:
      `${principal} ${result === 'declined' ? "can't take the call right now" : "didn't pick up"}. You are still on the call. ` +
      `Tell them in one short sentence that ${principal} isn't available right now, then carry on: help with what you can ` +
      'yourself, or, if only they can help, end the call as your instructions say for when you are stuck. Do not try to ' +
      `reach ${principal} again on this call.`,
  };
}

const COLD_DESCRIPTION = `Connect the other party to ${config.ASSISTANT_PRINCIPAL_NAME} directly, by phone. Use only when they need ${config.ASSISTANT_PRINCIPAL_NAME} personally and have said yes to being connected. Say one short handoff line first; you are off the call once this runs.`;
const WARM_DESCRIPTION =
  `Call ${config.ASSISTANT_PRINCIPAL_NAME} on a second line, read them your reason, and connect them to this call if they accept. ` +
  `Use only when the other party needs ${config.ASSISTANT_PRINCIPAL_NAME} personally and has said yes to being connected. ` +
  'First tell them you will try to reach them and it may take up to a minute. If they accept, you are off the call; if ' +
  'not, the result says so, and the call is still yours.';
const COLD_REASON = `Why they need ${config.ASSISTANT_PRINCIPAL_NAME}, e.g. "they need a card number to hold the table". Sent to ${config.ASSISTANT_PRINCIPAL_NAME}; not spoken to the other party.`;
const WARM_REASON =
  `One or two sentences for ${config.ASSISTANT_PRINCIPAL_NAME}: who you are talking to and what they need from them, e.g. ` +
  `"Dr. Smith's office can do 3 or 4:30 tomorrow and wants you to choose." Read aloud to ${config.ASSISTANT_PRINCIPAL_NAME} ` +
  'before they decide, and sent to them afterwards; never to the other party.';

export function defineTransferTool<Ctx extends TransferContext>(opts: {
  onTransferred: (input: { reason: string }, ctx: Ctx) => Promise<void>;
}): VoiceTool<{ reason: string }, Ctx> {
  return defineVoiceTool<{ reason: string }, Ctx>({
    name: TRANSFER_TOOL_NAME,
    description: config.TRANSFER_MODE === 'warm' ? WARM_DESCRIPTION : COLD_DESCRIPTION,
    schema: z.object({
      reason: (config.TRANSFER_MODE === 'warm' ? z.string().min(1).max(TRANSFER_REASON_MAX_CHARS) : z.string().min(1)).describe(config.TRANSFER_MODE === 'warm' ? WARM_REASON : COLD_REASON),
    }),
    endsCall: true,
    handlerBudgetMs: config.TRANSFER_MODE === 'warm' ? WARM_TRANSFER_HANDLER_BUDGET_MS : TRANSFER_HANDLER_BUDGET_MS,
    // Deliberately not wrapped in runToolSafely — see TRANSFER_HANDLER_BUDGET_MS.
    handler: async (input, ctx: Ctx) => {
      try {
        if (config.TRANSFER_MODE === 'warm') {
          const result = await loopInAfterSpeaking(ctx, input.reason);
          if (result !== 'accepted') return ownerUnavailable(result);
        } else {
          await transferAfterSpeaking(ctx);
        }
      } catch (err) {
        log.warn({ err, callId: ctx.callId }, 'transfer failed — the call is still ours');
        return { ok: false as const, error: 'transfer_failed' as const, message: err instanceof Error ? err.message : String(err) };
      }
      // The call is already with the principal, so a failure to record it
      // must not tell the model the transfer failed; it has no call to act on.
      try {
        await opts.onTransferred(input, ctx);
      } catch (err) {
        log.error(
          { err, callId: ctx.callId },
          'call transferred, but recording the transfer failed — the call will be recorded as failed although it was handed over',
        );
      }
      return { ok: true as const };
    },
  });
}
