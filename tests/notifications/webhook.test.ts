import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked at fetch, the webhook's only way out.
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

const URL_ = 'https://agent.example.test/webhooks/banjo';
const SECRET = 'webhook-secret-0123456789abcdef0123';

let webhook: typeof import('../../src/notifications/webhook.js');
let logger: typeof import('../../src/lib/logger.js').logger;

beforeAll(async () => {
  process.env.TASK_WEBHOOK_URL = URL_;
  process.env.TASK_WEBHOOK_SECRET = SECRET;
  process.env.TASK_WEBHOOK_TOKEN = 'openclaw-hook-token';
  vi.resetModules();
  webhook = await import('../../src/notifications/webhook.js');
  logger = (await import('../../src/lib/logger.js')).logger;
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const event = {
  event: 'task.finished' as const,
  taskId: 'task-1',
  status: 'confirmed' as const,
  outcome: { kind: 'confirmed' as const, start: '2026-10-09T18:00:00.000Z', durationMinutes: 30 },
  contact: { id: 'contact-1', name: "Luigi's" },
  text: "Booked with Luigi's for Thu Oct 9, 2:00 PM.",
  finishedAt: '2026-10-05T20:00:00.000Z',
};

const sent = (call = 0) => fetchMock.mock.calls[call]![1];
const header = (name: string, call = 0) => new Headers(sent(call).headers).get(name);

describe('sendTaskWebhook', () => {
  it('posts the event as JSON to TASK_WEBHOOK_URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await webhook.sendTaskWebhook(event);

    expect(fetchMock.mock.calls[0]![0]).toBe(URL_);
    expect(sent().method).toBe('POST');
    expect(header('content-type')).toBe('application/json');
    expect(JSON.parse(String(sent().body))).toEqual(event);
  });

  it('signs it the way Hermes Agent checks: HMAC-SHA256 hex of "<timestamp>.<body>"', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const before = Math.floor(Date.now() / 1000);

    await webhook.sendTaskWebhook(event);

    const timestamp = header('x-webhook-timestamp')!;
    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(timestamp)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${String(sent().body)}`).digest('hex');
    expect(header('x-webhook-signature-v2')).toBe(expected);
  });

  it('adds the bearer token for receivers that want one (OpenClaw hooks), and an idempotency key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await webhook.sendTaskWebhook(event);

    expect(header('authorization')).toBe('Bearer openclaw-hook-token');
    expect(header('idempotency-key')).toBe('task-1:confirmed');
  });

  it('retries once after a 5xx, then gives up without throwing', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(logger, 'error');
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const done = webhook.sendTaskWebhook(event);
    await vi.advanceTimersByTimeAsync(webhook.RETRY_DELAY_MS);
    await expect(done).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', status: 503 }), 'Failed to send task webhook');
  });

  it('retries a network failure, and succeeds on the second try', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(new Response(null, { status: 204 }));

    const done = webhook.sendTaskWebhook(event);
    await vi.advanceTimersByTimeAsync(webhook.RETRY_DELAY_MS);
    await expect(done).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx: that is a configuration problem on the receiving side', async () => {
    const error = vi.spyOn(logger, 'error');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await webhook.sendTaskWebhook(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', status: 401 }), 'Failed to send task webhook');
  });
});

describe('sendTaskWebhook with no TASK_WEBHOOK_URL', () => {
  it('sends nothing', async () => {
    process.env.TASK_WEBHOOK_URL = '';
    vi.resetModules();
    const unconfigured = await import('../../src/notifications/webhook.js');

    await unconfigured.sendTaskWebhook(event);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
