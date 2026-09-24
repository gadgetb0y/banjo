import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { maskPhoneNumber, redactOptions } from '../../src/lib/logger.js';

/** A logger with the app's redaction, writing JSON lines to an array. */
function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { log: pino({ redact: redactOptions }, stream), output: () => lines.join('') };
}

describe('maskPhoneNumber (#8)', () => {
  it('keeps the last 4 digits and masks the rest', () => {
    expect(maskPhoneNumber('+18622904699')).toBe('+•••••••4699');
  });

  it('leaves short and non-string values alone', () => {
    expect(maskPhoneNumber('4699')).toBe('4699');
    expect(maskPhoneNumber(undefined)).toBeUndefined();
  });
});

describe('logger redaction (#8)', () => {
  it('never writes a full phone number, at the sites that log one today', () => {
    const { log, output } = capture();
    log.info({ callSid: 'CA1', from: '+18622904699' }, 'inbound call webhook received'); // src/server.ts
    log.error({ callerPhoneNumber: '+18622904699' }, 'caller context resolution failed'); // inbound/callerContext.ts
    log.info({ contact: { phoneNumber: '+18622904699' } }, 'nested');
    expect(output()).not.toContain('8622904699');
    expect(output()).toContain('4699');
  });

  it('never writes what was said to the other party — voicemail text and raw tool arguments', () => {
    const { log, output } = capture();
    const message = 'Hi, this is Steve calling about his MRI results appointment.';
    log.error({ taskId: 't1', outcome: { kind: 'voicemail_left', message } }, 'Failed to send notification SMS');
    log.warn({ argsStr: `{"message":"${message}"}` }, 'failed to parse function_call arguments as JSON');
    expect(output()).not.toContain('MRI');
    expect(output()).toContain('voicemail_left'); // the kind stays: it's what you debug with
  });

  it('a wildcard-matched nested field is masked, not a crash that drops the line', () => {
    const { log, output } = capture();
    log.info({ contact: { phoneNumber: '+18622904699' } }, 'nested contact');
    expect(output()).toContain('nested contact');
    expect(output()).toContain('+•••••••4699');
  });

  it('keeps everything else as it was', () => {
    const { log, output } = capture();
    log.info({ callId: 'c1', reason: 'insufficient_quota' }, 'Call ended');
    expect(output()).toContain('insufficient_quota');
  });
});
