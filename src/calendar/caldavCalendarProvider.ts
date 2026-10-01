/**
 * CalendarProvider for any CalDAV server — Fastmail, iCloud, Nextcloud,
 * Radicale. Authenticates with HTTP Basic and an app password, so unlike
 * GoogleCalendarProvider there's no OAuth consent flow to run first.
 *
 * Idempotency works differently from Google, and more strongly. Google's
 * version searches for an event tagged with the idempotency key, then
 * inserts — two near-simultaneous calls can both pass the search (Open
 * Risks #8 in docs/ARCHITECTURE.md). Here the key determines the event's
 * resource name, and the event is written with `If-None-Match: *`, so the
 * server itself refuses a second create under the same key. The free-slot
 * guard before it is still check-then-write, exactly as in Google's version.
 */

import { createHash } from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { zonedTimeToUtcIso } from '../lib/timezone.js';
import type { TimeWindow } from '../tasks/schema.js';
import { davRequest, isOkStatus, parseMultistatus, textOf, type DavCredentials } from '../lib/dav/davHttp.js';
import { discoverCalendarUserAddresses } from '../lib/dav/discovery.js';
import { chunkIntoWindows, subtractBusyIntervals, type BusyInterval } from './freeSlots.js';
import { buildBookingCalendar, busyIntervalsFromEvents, eventSpan, findEvents, formatUtc, parseICalendar } from './ical.js';
import {
  SlotUnavailableError,
  type CalendarProvider,
  type CheckAvailabilityInput,
  type CreateEventInput,
  type CreateEventResult,
  type IsFreeInput,
} from './types.js';

const MS_PER_MINUTE = 60_000;
/** How long to wait before asking the server for the owner's addresses again after it failed to say. */
const ADDRESS_RETRY_MS = 60 * 60_000;

export interface CaldavCalendarOptions {
  /** The calendar collection, e.g. https://caldav.fastmail.com/dav/calendars/user/me@fastmail.com/<id>/ */
  calendarUrl: string;
  username: string;
  password: string;
  /** CALENDAR_TIMEZONE — how floating times and all-day dates are read. */
  timeZone: string;
  /**
   * The owner's own addresses, for skipping invitations they declined
   * (DAV_OWNER_EMAIL). When omitted they're read from the server once
   * (calendar-user-address-set), falling back to the username if it's an
   * email address.
   */
  ownerAddresses?: readonly string[];
}

function optionsFromConfig(): CaldavCalendarOptions {
  if (!config.CALDAV_CALENDAR_URL || !config.DAV_USERNAME || !config.DAV_PASSWORD) {
    // Unreachable when CALENDAR_PROVIDER=caldav — config's refine requires all three.
    throw new Error('CaldavCalendarProvider needs CALDAV_CALENDAR_URL, DAV_USERNAME, and DAV_PASSWORD');
  }
  return {
    calendarUrl: config.CALDAV_CALENDAR_URL,
    username: config.DAV_USERNAME,
    password: config.DAV_PASSWORD,
    timeZone: config.CALENDAR_TIMEZONE,
    ownerAddresses: config.DAV_OWNER_EMAIL ? parseAddressList(config.DAV_OWNER_EMAIL) : undefined,
  };
}

/** DAV_OWNER_EMAIL: comma-separated, any case, optional "mailto:". */
export function parseAddressList(value: string): string[] {
  return [...new Set(value.split(',').map((a) => a.trim().replace(/^mailto:/i, '').toLowerCase()).filter(Boolean))];
}

/**
 * The event's resource name (and UID) for an idempotency key. Hashed rather
 * than escaped: keys contain ':' and timestamps (see inbound's
 * `inbound-reschedule:<id>:<iso>`), and a hash gives every key a distinct,
 * URL-safe name with no escaping rules to get wrong.
 */
export function resourceNameForKey(idempotencyKey: string): string {
  return `banjo-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}.ics`;
}

/** What resourceNameForKey produces — the only event ids this provider ever hands out. */
const BANJO_RESOURCE_NAME = /^banjo-[0-9a-f]{40}\.ics$/;

export class CaldavCalendarProvider implements CalendarProvider {
  private readonly calendarUrl: string;
  private readonly credentials: DavCredentials;
  private readonly timeZone: string;
  /** Set when DAV_OWNER_EMAIL (or a test) gives the addresses; otherwise they're discovered. */
  private readonly configuredAddresses: readonly string[] | undefined;
  /** The username when it's an email address — the fallback when the server doesn't list addresses. */
  private readonly usernameAddress: string[];
  private discovered: { addresses: readonly string[] } | { failedAt: number } | undefined;

  constructor(options: CaldavCalendarOptions = optionsFromConfig()) {
    // Resource names resolve relative to the collection, which needs a trailing slash.
    this.calendarUrl = options.calendarUrl.endsWith('/') ? options.calendarUrl : `${options.calendarUrl}/`;
    this.credentials = { username: options.username, password: options.password };
    this.timeZone = options.timeZone;
    this.configuredAddresses = options.ownerAddresses;
    this.usernameAddress = options.username.includes('@') ? [options.username.toLowerCase()] : [];
  }

  /**
   * The addresses invitations to the owner are sent to. A login isn't always
   * one of them: a Fastmail user signing in as you@fastmail.com may be
   * invited at their own domain's addresses (#70). DAV_OWNER_EMAIL wins;
   * otherwise the server's calendar-user-address-set, read once and cached,
   * plus the username if it's an email. If the server can't say, the
   * username alone is used and the server is asked again an hour later.
   */
  async ownerAddresses(): Promise<readonly string[]> {
    if (this.configuredAddresses) return this.configuredAddresses;
    if (this.discovered && 'addresses' in this.discovered) return this.discovered.addresses;
    if (this.discovered && Date.now() - this.discovered.failedAt < ADDRESS_RETRY_MS) return this.usernameAddress;
    try {
      const addresses = [...new Set([...(await discoverCalendarUserAddresses(this.calendarUrl, this.credentials)), ...this.usernameAddress])];
      this.discovered = { addresses };
      return addresses;
    } catch (err) {
      this.discovered = { failedAt: Date.now() };
      logger.warn(
        { err },
        "couldn't read the calendar owner's addresses from the CalDAV server; declined invitations are recognized only by the username. Set DAV_OWNER_EMAIL to list them.",
      );
      return this.usernameAddress;
    }
  }

  async computeCandidateWindows({ dateWindows, durationMinutes }: CheckAvailabilityInput): Promise<TimeWindow[]> {
    const candidates: TimeWindow[] = [];
    for (const window of dateWindows) {
      const busy = await this.getBusyIntervals(window);
      const freeIntervals = subtractBusyIntervals({ startMs: this.instantMs(window.start), endMs: this.instantMs(window.end) }, busy);
      for (const free of freeIntervals) {
        candidates.push(...chunkIntoWindows(free, durationMinutes));
      }
    }
    return candidates;
  }

  async isFree({ start, durationMinutes }: IsFreeInput): Promise<boolean> {
    const startMs = this.instantMs(start);
    const endMs = startMs + durationMinutes * MS_PER_MINUTE;
    const busy = await this.getBusyIntervals({ start, end: new Date(endMs).toISOString() });
    return !busy.some((b) => b.startMs < endMs && b.endMs > startMs);
  }

  async findEventByIdempotencyKey(idempotencyKey: string): Promise<CreateEventResult | undefined> {
    const eventId = resourceNameForKey(idempotencyKey);
    const response = await davRequest({
      method: 'GET',
      url: this.eventUrl(eventId),
      credentials: this.credentials,
      allowStatuses: [404, 410],
    });
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return undefined;
    }

    // Read the event back rather than assuming what we wrote: the owner may
    // have moved it in their calendar app since.
    const [event] = findEvents(parseICalendar(await response.text()));
    const span = event ? eventSpan(event, this.timeZone) : undefined;
    if (!span) return undefined;
    return {
      eventId,
      confirmedStart: new Date(span.startMs).toISOString(),
      confirmedEnd: new Date(span.endMs).toISOString(),
    };
  }

  async createEventIdempotent({ idempotencyKey, start, durationMinutes, summary, description }: CreateEventInput): Promise<CreateEventResult> {
    // Both are read-only lookups, so run them together — this is on a live call.
    const guardCheckStartedAt = Date.now();
    const [existing, free] = await Promise.all([this.findEventByIdempotencyKey(idempotencyKey), this.isFree({ start, durationMinutes })]);
    logger.info({ idempotencyKey, durationMs: Date.now() - guardCheckStartedAt }, 'createEventIdempotent: idempotency + free-slot guard checks completed');

    if (existing) {
      logger.info({ idempotencyKey, eventId: existing.eventId }, 'createEventIdempotent: found existing event, skipping insert');
      return existing;
    }
    if (!free) {
      logger.warn({ idempotencyKey, start, durationMinutes }, 'createEventIdempotent: requested slot is no longer free, refusing to double-book');
      throw new SlotUnavailableError();
    }

    const eventId = resourceNameForKey(idempotencyKey);
    const startMs = this.instantMs(start);
    const endMs = startMs + durationMinutes * MS_PER_MINUTE;

    const insertStartedAt = Date.now();
    const response = await davRequest({
      method: 'PUT',
      url: this.eventUrl(eventId),
      credentials: this.credentials,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
      body: buildBookingCalendar({ uid: eventId.replace(/\.ics$/, ''), startMs, endMs, summary, description, idempotencyKey }),
      allowStatuses: [412],
    });
    await response.body?.cancel();
    logger.info({ idempotencyKey, durationMs: Date.now() - insertStartedAt }, 'createEventIdempotent: PUT completed');

    if (response.status === 412) {
      // Another attempt with the same key created it between our check and
      // our write. That's the retry this guards against — return its event.
      const raced = await this.findEventByIdempotencyKey(idempotencyKey);
      if (!raced) throw new Error(`createEventIdempotent: create refused as a duplicate but no event found (idempotencyKey=${idempotencyKey})`);
      logger.info({ idempotencyKey, eventId: raced.eventId }, 'createEventIdempotent: concurrent create won, returning its event');
      return raced;
    }

    logger.info({ idempotencyKey, eventId }, 'createEventIdempotent: created new event');
    return { eventId, confirmedStart: new Date(startMs).toISOString(), confirmedEnd: new Date(endMs).toISOString() };
  }

  async deleteEvent(eventId: string): Promise<void> {
    // Any other id was written by a different provider — a Google event id
    // stored before CALENDAR_PROVIDER was switched. It can't exist here, so
    // the 404 below would report success while the real event stays put.
    if (!BANJO_RESOURCE_NAME.test(eventId)) {
      throw new Error(`deleteEvent: "${eventId}" is not a CalDAV event Banjo created — was it booked under another CALENDAR_PROVIDER?`);
    }
    // Already gone (e.g. the owner deleted it by hand) is the outcome we
    // wanted, so it isn't an error — reschedule deletes then recreates, and
    // shouldn't fail on an event that's no longer there.
    const response = await davRequest({
      method: 'DELETE',
      url: this.eventUrl(eventId),
      credentials: this.credentials,
      allowStatuses: [404, 410],
    });
    await response.body?.cancel();
  }

  /**
   * A time from the call path as epoch ms. Offset-less means CALENDAR_TIMEZONE —
   * a bare Date.parse would read it in the server's zone (UTC in Docker).
   */
  private instantMs(value: string): number {
    return Date.parse(zonedTimeToUtcIso(value, this.timeZone));
  }

  private eventUrl(eventId: string): string {
    return new URL(encodeURIComponent(eventId), this.calendarUrl).toString();
  }

  /**
   * Every event overlapping `window`, with recurring events expanded into
   * instances by the server, reduced to the intervals that block booking.
   * Public (though not part of CalendarProvider) so scripts/dav-check.ts
   * can show what Banjo will treat as busy.
   */
  async getBusyIntervals(window: TimeWindow): Promise<BusyInterval[]> {
    const rangeStart = formatUtc(this.instantMs(window.start));
    const rangeEnd = formatUtc(this.instantMs(window.end));
    const response = await davRequest({
      method: 'REPORT',
      url: this.calendarUrl,
      credentials: this.credentials,
      headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-data>
      <c:expand start="${rangeStart}" end="${rangeEnd}"/>
    </c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${rangeStart}" end="${rangeEnd}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
    });

    const ownerEmails = await this.ownerAddresses();
    const busy: BusyInterval[] = [];
    for (const resource of parseMultistatus(await response.text())) {
      if (resource.status && !isOkStatus(resource.status)) {
        // e.g. 507: the server truncated the results. A partial list of busy
        // times would make busy slots look free, so fail instead.
        throw new Error(`CalDAV availability query returned ${resource.status} for ${resource.href}`);
      }
      for (const propstat of resource.propstats) {
        if (!isOkStatus(propstat.status)) continue;
        const calendarData = textOf(propstat.prop['calendar-data']);
        if (!calendarData) continue;
        const events = findEvents(parseICalendar(calendarData));
        busy.push(...busyIntervalsFromEvents(events, { timeZone: this.timeZone, ownerEmails }));
      }
    }
    return busy;
  }
}
