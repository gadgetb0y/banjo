import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';

/**
 * Answer links for ask_owner questions. Signed like approval links
 * (approvals/link.ts), with a key derived from MCP_API_KEY under its own
 * label, so an approval signature can never answer a question or the other
 * way round. The signature covers the question id and its deadline. The link
 * is a credential: keep it out of logs, MCP results and the task webhook.
 */
function signingKey(): Buffer {
  return createHmac('sha256', config.MCP_API_KEY).update('banjo-answer-v1').digest();
}

export function answerSignature(questionId: string, expiresAt: Date): string {
  return createHmac('sha256', signingKey()).update(`${questionId}.${expiresAt.getTime()}`).digest('hex');
}

export function isValidAnswerSignature(questionId: string, expiresAt: Date, sig: string): boolean {
  const wanted = Buffer.from(answerSignature(questionId, expiresAt), 'hex');
  const given = /^[0-9a-f]{64}$/.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function answerUrl(questionId: string, expiresAt: Date): string {
  return `https://${config.PUBLIC_HOSTNAME}/answer/${questionId}?sig=${answerSignature(questionId, expiresAt)}`;
}
