import { describe, expect, it } from 'vitest';
import { SIM_DATABASE, simDatabaseUrl, simEnv } from '../../src/sim/env.js';

describe('simDatabaseUrl', () => {
  it('keeps the server and credentials and swaps in banjo_sim', () => {
    expect(simDatabaseUrl('postgresql://u:p@db.example:6543/banjo?sslmode=require')).toBe(
      `postgresql://u:p@db.example:6543/${SIM_DATABASE}?sslmode=require`,
    );
  });

  it('defaults to the docker compose server when DATABASE_URL is unset', () => {
    expect(simDatabaseUrl(undefined)).toBe(`postgresql://banjo:banjo@localhost:5432/${SIM_DATABASE}`);
  });
});

describe('simEnv', () => {
  const real = {
    DATABASE_URL: 'postgresql://banjo:banjo@localhost:5432/banjo',
    NOTIFICATION_CHANNEL: 'pushover',
    TASK_WEBHOOK_URL: 'https://hooks.example/banjo',
    RECORD_CALLS: 'true',
    CONTACTS_PROVIDER: 'carddav',
    CALENDAR_PROVIDER: 'caldav',
    TWILIO_ACCOUNT_SID: 'ACreal',
    ASSISTANT_PRINCIPAL_NAME: 'Steve',
  };

  it('overrides everything that reaches the outside world or the dev database', () => {
    const env = simEnv(real, { transfer: false, verbose: false });
    expect(env).toMatchObject({
      DATABASE_URL: `postgresql://banjo:banjo@localhost:5432/${SIM_DATABASE}`,
      NOTIFICATION_CHANNEL: 'none',
      TASK_WEBHOOK_URL: '',
      RECORD_CALLS: 'false',
      CONTACTS_PROVIDER: 'none',
      CALENDAR_PROVIDER: 'google',
      INBOUND_BOOKING_ENABLED: 'false',
      TRANSFER_ENABLED: 'false',
      VOICE_AI_PROVIDER: 'openai',
      LOG_LEVEL: 'warn',
    });
    expect(env).not.toHaveProperty('TRANSFER_TO_PHONE_NUMBER');
  });

  it('fills placeholders only where nothing is set', () => {
    const env = simEnv(real, { transfer: false, verbose: false });
    expect(env).not.toHaveProperty('TWILIO_ACCOUNT_SID');
    expect(env).not.toHaveProperty('ASSISTANT_PRINCIPAL_NAME');
    expect(env.TWILIO_AUTH_TOKEN).toBe('simulator');
    expect(env.MCP_API_KEY!.length).toBeGreaterThanOrEqual(32);
  });

  it('turns transfer on with a fictional owner number, and info logs with --verbose', () => {
    const env = simEnv({}, { transfer: true, verbose: true });
    expect(env).toMatchObject({ TRANSFER_ENABLED: 'true', TRANSFER_TO_PHONE_NUMBER: '+12025550199', LOG_LEVEL: 'info' });
  });
});
