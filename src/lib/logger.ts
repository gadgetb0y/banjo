import pino from 'pino';
import { config } from '../config/index.js';

/** Masks all but the last 4 digits: "+18622904699" → "+•••••••4699". Enough to tell calls apart, not to identify anyone. */
export function maskPhoneNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const digits = value.replace(/\D/g, '').length;
  if (digits <= 4) return value;
  let toMask = digits - 4;
  return value.replace(/\d/g, (d) => (toMask-- > 0 ? '•' : d));
}

// Fields that hold a phone number. Inbound caller numbers were logged in full
// at info, on by default, from src/server.ts and inbound/callerContext.ts (#8).
const PHONE_PATHS = ['from', 'to', 'toNumber', 'phoneNumber', 'callerPhoneNumber', '*.phoneNumber', '*.callerPhoneNumber'];

// Fields that hold what was said to the other party: a voicemail message
// inside an outcome, and the model's raw tool arguments (which carry that
// message, or booking details) when they fail to parse. Logged as a length,
// the pattern the provider adapters already use (textLength). Transcript
// lines are not here: LOG_TRANSCRIPTS is an explicit, off-by-default opt-in
// to see exactly that text.
const CONTENT_PATHS = ['outcome.message', 'outcome.details', 'argsStr'];

export const redactOptions = {
  paths: [...PHONE_PATHS, ...CONTENT_PATHS],
  // String() per segment: wildcard matches put a Symbol in `path`, which
  // join() can't convert — and a censor that throws takes the log line with it.
  censor: (value: unknown, path: string[]) =>
    CONTENT_PATHS.includes(path.map((segment) => String(segment)).join('.')) && typeof value === 'string'
      ? `[redacted: ${value.length} chars]`
      : maskPhoneNumber(value),
} satisfies pino.LoggerOptions['redact'];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: redactOptions,
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
