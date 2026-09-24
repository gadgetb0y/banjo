import { beforeEach, describe, expect, it, vi } from 'vitest';

// A Twilio client stand-in: messages.create() sends, messages(sid).fetch() reads delivery status.
const { create, fetchMessage, fakeLog } = vi.hoisted(() => ({
  create: vi.fn(async () => ({ sid: 'SM1' })),
  fetchMessage: vi.fn(async (): Promise<{ status: string; errorCode: number | null }> => ({ status: 'delivered', errorCode: null })),
  fakeLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('twilio', () => ({
  default: () => ({ messages: Object.assign(vi.fn(() => ({ fetch: fetchMessage })), { create }) }),
}));
vi.mock('../../src/lib/logger.js', () => ({ logger: fakeLog, childLogger: () => fakeLog }));

const { TwilioSmsNotificationChannel, DELIVERY_CHECK_DELAY_MS } = await import('../../src/notifications/twilioSms.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SMS delivery is checked after sending', () => {
  // Every notification this week was accepted by Twilio and then blocked by
  // the carrier (error 30034, unregistered 10DLC number). messages.create()
  // succeeded, so nothing was logged — a blocked text looked exactly like a
  // delivered one.
  async function sendAndWait() {
    vi.useFakeTimers();
    try {
      await new TwilioSmsNotificationChannel().notify('task-1', { kind: 'failed', reason: 'x' }, 'Summary');
      await vi.advanceTimersByTimeAsync(DELIVERY_CHECK_DELAY_MS + 10);
    } finally {
      vi.useRealTimers();
    }
  }

  it('logs an error naming the cause when the carrier blocks it (30034)', async () => {
    fetchMessage.mockResolvedValueOnce({ status: 'undelivered', errorCode: 30034 });
    await sendAndWait();
    expect(fakeLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ messageSid: 'SM1', status: 'undelivered', errorCode: 30034 }),
      expect.stringMatching(/A2P 10DLC/),
    );
  });

  it('logs any other undelivered or failed status too', async () => {
    fetchMessage.mockResolvedValueOnce({ status: 'failed', errorCode: 30006 });
    await sendAndWait();
    expect(fakeLog.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 30006 }), expect.any(String));
  });

  it('stays quiet when it was delivered', async () => {
    await sendAndWait();
    expect(fetchMessage).toHaveBeenCalled();
    expect(fakeLog.error).not.toHaveBeenCalled();
  });
});
