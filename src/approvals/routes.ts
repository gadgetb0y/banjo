import { Hono, type Context } from 'hono';
import { config } from '../config/index.js';
import { getContact } from '../contacts/service.js';
import { triggerOrchestration } from '../tasks/orchestrator.js';
import type { Task } from '../tasks/schema.js';
import { approveTask, getTask } from '../tasks/service.js';
import { isValidApprovalSignature } from './link.js';
import { escapeHtml, page } from './page.js';
import { formatLocal } from './request.js';

/**
 * The owner's page for approving a call an agent asked for. GET only shows
 * it, so a link preview or prefetch can't approve anything; the button
 * POSTs. Every failure (a bad sig, an unknown task, one that never needed
 * approval) gets the same page, so it can't be used to find task ids.
 */
export const approvalRoutes = new Hono();

const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(c: Context) {
  return c.html(page('Banjo', '<h1>This link isn’t valid</h1><p>Ask for the call again if you still want it.</p>'), 404, HEADERS);
}

async function signedTask(taskId: string, sig: string | undefined): Promise<Task | undefined> {
  if (!sig || !UUID.test(taskId)) return undefined;
  const task = await getTask(taskId);
  if (!task?.approvalExpiresAt) return undefined;
  return isValidApprovalSignature(task.id, task.approvalExpiresAt, sig) ? task : undefined;
}

function whenHtml(task: Task, now: number): string {
  if (!task.scheduledFor) return 'Now';
  if (task.scheduledFor.getTime() > now) return escapeHtml(formatLocal(task.scheduledFor));
  const minutes = Math.round((now - task.scheduledFor.getTime()) / 60_000);
  return `<span class="warn">Scheduled for ${escapeHtml(formatLocal(task.scheduledFor))}, ${minutes} minutes ago: approving calls now</span>`;
}

approvalRoutes.get('/approve/:taskId', async (c) => {
  const sig = c.req.query('sig');
  const task = await signedTask(c.req.param('taskId'), sig);
  if (!task) return invalid(c);
  const contact = await getContact(task.contactId);
  const now = Date.now();
  const expiresAt = task.approvalExpiresAt!;
  const rows: Array<[string, string]> = [
    ['Who', escapeHtml(`${contact?.displayName ?? 'Unknown contact'} (${contact?.phoneNumber ?? 'no number'})`)],
    ['When', whenHtml(task, now)],
    ['Kind of call', escapeHtml(task.mode)],
    ['What the agent asked for', escapeHtml(task.goalDescription)],
    ...(task.questions?.length
      ? ([['Questions', escapeHtml(task.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'))]] as Array<[string, string]>)
      : []),
    ['Approve by', escapeHtml(`${formatLocal(expiresAt)} (${config.CALENDAR_TIMEZONE})`)],
  ];
  const action = task.approvedAt
    ? '<p>Already approved.</p>'
    : task.status !== 'pending'
      ? '<p>This request was cancelled, so the call won’t be placed.</p>'
      : expiresAt.getTime() <= now
        ? '<p>This request expired, so the call won’t be placed.</p>'
        : `<form method="post" action="/approve/${task.id}"><input type="hidden" name="sig" value="${escapeHtml(sig!)}"><button type="submit">Approve this call</button></form>`;
  const list = rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('');
  return c.html(page('Approve a call?', `<h1>An agent wants Banjo to make a call</h1><dl>${list}</dl>${action}`), 200, HEADERS);
});

const RESULTS = {
  approved: 'Approved. Banjo will place the call.',
  already_approved: 'This call was already approved.',
  expired: 'This request expired, so the call won’t be placed.',
  not_waiting: 'This request was cancelled, so nothing changed.',
  not_found: 'This link isn’t valid',
} as const;

approvalRoutes.post('/approve/:taskId', async (c) => {
  const body = await c.req.parseBody();
  const sig = typeof body.sig === 'string' ? body.sig : undefined;
  const task = await signedTask(c.req.param('taskId'), sig);
  if (!task) return invalid(c);
  const result = await approveTask(task.id);
  if (result === 'approved') triggerOrchestration(task.id);
  return c.html(page('Banjo', `<h1>${escapeHtml(RESULTS[result])}</h1>`), 200, HEADERS);
});

/** For the request log: an approval link's signature is a credential. */
export function redactQuery(query: Record<string, string>): Record<string, string> {
  return 'sig' in query ? { ...query, sig: '[redacted]' } : query;
}
