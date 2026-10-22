import { z } from 'zod';
import { config } from '../config/index.js';
import { getContact } from '../contacts/service.js';
import type { CallContext } from '../session/types.js';
import { defineVoiceTool, type VoiceTool } from '../voice/tools/defineVoiceTool.js';
import { MAX_QUESTION_CHARS, askOwner } from './service.js';

export const ASK_OWNER_TOOL_NAME = 'ask_owner';

/**
 * ask_owner (ASK_OWNER_ENABLED): a question to the owner mid-call. Returns as
 * soon as the question is sent; the answer arrives later as a note in the
 * conversation (service.ts), so the tool budget never has to cover the wait.
 */
export const askOwnerTool: VoiceTool<{ question: string }, CallContext> = defineVoiceTool({
  name: ASK_OWNER_TOOL_NAME,
  description:
    `Ask ${config.ASSISTANT_PRINCIPAL_NAME} a question during the call, when the other party asks something your instructions ` +
    "don't answer and a guess could be wrong. First tell them you'll check and it may take a minute or two. The answer is " +
    'given to you when it arrives; until then, carry on with anything else, or wait with them. Never with a phone menu.',
  schema: z.object({
    question: z
      .string()
      .min(1)
      .max(MAX_QUESTION_CHARS)
      .describe(`The question, in one or two sentences ${config.ASSISTANT_PRINCIPAL_NAME} can answer without hearing the call.`),
  }),
  handler: async ({ question }, ctx) => {
    const contact = await getContact(ctx.task.contactId);
    const result = await askOwner({
      taskId: ctx.task.id,
      callAttemptId: ctx.callAttempt.id,
      contactName: contact?.displayName ?? 'the business',
      question,
    });
    switch (result) {
      case 'asked':
        return { ok: true, note: `Asked. ${config.ASSISTANT_PRINCIPAL_NAME}'s answer will be given to you when it arrives. Don't guess it meanwhile.` };
      case 'too_many':
        return { ok: false, note: 'You already have questions waiting for an answer. Wait for those before asking more.' };
      case 'not_sent':
        return { ok: false, note: `The question couldn't be sent, so no answer will come. Don't guess it.` };
    }
  },
});
