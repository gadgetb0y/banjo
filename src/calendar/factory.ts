import { config } from '../config/index.js';
import { CaldavCalendarProvider } from './caldavCalendarProvider.js';
import { GoogleCalendarProvider } from './googleCalendarProvider.js';
import type { CalendarProvider } from './types.js';

let instance: CalendarProvider | null = null;
let override: CalendarProvider | null = null;

/** For the text simulator (scripts/sim.ts) only: createCalendarProvider() returns `provider` until cleared with null. Nothing in src/ sets it. */
export function overrideCalendarProvider(provider: CalendarProvider | null): void {
  override = provider;
}

/**
 * Picks the calendar backend from CALENDAR_PROVIDER. Application code should
 * program against CalendarProvider and get an instance from here, never
 * construct a provider class directly — same pattern as voice/factory.ts.
 * One instance per process, like telephony/factory.ts: the providers hold
 * only a client, so callers can ask for it each time they need it.
 */
export function createCalendarProvider(): CalendarProvider {
  if (override) return override;
  instance ??= buildCalendarProvider();
  return instance;
}

function buildCalendarProvider(): CalendarProvider {
  switch (config.CALENDAR_PROVIDER) {
    case 'google':
      return new GoogleCalendarProvider();
    case 'caldav':
      return new CaldavCalendarProvider();
    default: {
      // Unreachable: CALENDAR_PROVIDER is a Zod enum. Guards a future enum
      // value that forgets to add its provider here.
      const exhaustiveCheck: never = config.CALENDAR_PROVIDER;
      throw new Error(`Unrecognized CALENDAR_PROVIDER: ${String(exhaustiveCheck)}`);
    }
  }
}
