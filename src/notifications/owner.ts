import { config } from '../config/index.js';
import type { NotificationChannel } from './channel.js';
import { PushoverNotificationChannel, sendPushover } from './pushover.js';
import { NoopNotificationChannel, sendOwnerSms, TwilioSmsNotificationChannel } from './twilioSms.js';

/**
 * Tells the owner something directly, over whichever NOTIFICATION_CHANNEL is
 * configured — for events with no Task outcome to report: inbound bookings
 * and reschedules, an inbound call flagged for attention, a booking written
 * after its call was already reported, a call an agent wants approved.
 * Resolves whether the channel took the message (false for
 * NOTIFICATION_CHANNEL=none); never throws.
 * `urgent` raises the Pushover priority past quiet hours; SMS has no
 * equivalent, so it's ignored there.
 */
export async function sendOwnerMessage(body: string, { urgent = false }: { urgent?: boolean } = {}): Promise<boolean> {
  if (sink) {
    sink(body);
    return true;
  }
  switch (config.NOTIFICATION_CHANNEL) {
    case 'twilio_sms':
      return sendOwnerSms(body);
    case 'pushover':
      return sendPushover({ message: body, urgent });
    case 'none':
      return false;
  }
}

let instance: NotificationChannel | null = null;
let sink: ((body: string) => void) | null = null;

/**
 * The simulator's seam (src/sim/): every message to the owner, and every
 * outcome summary, goes to `to` instead of a real channel, as the
 * telephony and calendar factories' overrides do. null puts things back.
 */
export function overrideOwnerMessages(to: ((body: string) => void) | null): void {
  sink = to;
  instance = null;
}

/** The channel for end-of-call outcome summaries, per NOTIFICATION_CHANNEL. */
export function createNotificationChannel(): NotificationChannel {
  if (sink) {
    const to = sink;
    return { notify: async (_taskId, _outcome, summary) => to(summary) };
  }
  if (instance) return instance;
  switch (config.NOTIFICATION_CHANNEL) {
    case 'twilio_sms':
      instance = new TwilioSmsNotificationChannel();
      break;
    case 'pushover':
      instance = new PushoverNotificationChannel();
      break;
    case 'none':
      instance = new NoopNotificationChannel();
      break;
  }
  return instance;
}
