import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';

/**
 * Approval links for calls an agent asks for (MCP_AGENT_API_KEY; design in
 * docs/superpowers/specs/2026-10-14-place-call-approval-design.md). The
 * signature covers the task id and its approval deadline, keyed from
 * MCP_API_KEY, the owner's key, which the agent never holds: an agent can't
 * make a link that approves its own call. Nothing is stored, since the task
 * row has both inputs. The link is a credential: keep it out of logs, MCP
 * results and the task webhook.
 */
function signingKey(): Buffer {
  return createHmac('sha256', config.MCP_API_KEY).update('banjo-approval-v1').digest();
}

export function approvalSignature(taskId: string, expiresAt: Date): string {
  return createHmac('sha256', signingKey()).update(`${taskId}.${expiresAt.getTime()}`).digest('hex');
}

export function isValidApprovalSignature(taskId: string, expiresAt: Date, sig: string): boolean {
  const wanted = Buffer.from(approvalSignature(taskId, expiresAt), 'hex');
  const given = /^[0-9a-f]{64}$/.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function approvalUrl(taskId: string, expiresAt: Date): string {
  return `https://${config.PUBLIC_HOSTNAME}/approve/${taskId}?sig=${approvalSignature(taskId, expiresAt)}`;
}
