import { createHmac } from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import type { Task, TaskOutcome } from '../tasks/schema.js';

const REQUEST_TIMEOUT_MS = 5_000;
export const RETRY_DELAY_MS = 5_000;

/**
 * What TASK_WEBHOOK_URL receives when a call finishes (docs/ROADMAP.md, 4.4).
 * `text` is the same summary the owner is sent, so a receiver that only
 * wants a sentence (OpenClaw's hooks take `text` or `message`) needs no
 * mapping. No phone numbers: the receiver has contact.id if it needs more.
 */
export interface TaskFinishedEvent {
  event: 'task.finished';
  taskId: string;
  status: Task['status'];
  outcome: TaskOutcome;
  contact: { id: string; name: string };
  text: string;
  finishedAt: string;
}

/**
 * HMAC-SHA256, hex, over `<timestamp>.<body>`: Hermes Agent's "generic V2"
 * webhook signature. The timestamp is in the signed string, so a captured
 * request can't be replayed once the receiver's window (Hermes: 300s) passes.
 */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

type Attempt = { ok: true } | { ok: false; retryable: boolean; detail: Record<string, unknown> };

async function attempt(url: string, body: string, event: TaskFinishedEvent): Promise<Attempt> {
  // Signed per attempt, so a retry carries a fresh timestamp.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature-V2': signWebhook(config.TASK_WEBHOOK_SECRET!, timestamp, body),
    'Idempotency-Key': `${event.taskId}:${event.status}`,
  };
  if (config.TASK_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${config.TASK_WEBHOOK_TOKEN}`;
  try {
    const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.body?.cancel();
    if (response.ok) return { ok: true };
    return { ok: false, retryable: response.status >= 500, detail: { status: response.status } };
  } catch (err) {
    // Network failure or timeout: worth one retry, like a 5xx.
    return { ok: false, retryable: true, detail: { err } };
  }
}

/**
 * Sends the task-finished event to TASK_WEBHOOK_URL, if one is set. Never
 * throws: like a notification, a webhook problem must not reach the call.
 * Retries once after RETRY_DELAY_MS on a network error or 5xx; a 4xx means
 * the receiver is misconfigured (wrong secret, unknown route) and is logged,
 * not retried. Logs only the task and status, never the body.
 */
export async function sendTaskWebhook(event: TaskFinishedEvent): Promise<void> {
  const url = config.TASK_WEBHOOK_URL;
  if (!url) return;
  const body = JSON.stringify(event);
  let result = await attempt(url, body, event);
  if (!result.ok && result.retryable) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    result = await attempt(url, body, event);
  }
  if (!result.ok) logger.error({ taskId: event.taskId, ...result.detail }, 'Failed to send task webhook');
}
