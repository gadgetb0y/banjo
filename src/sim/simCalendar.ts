import { chunkIntoWindows, subtractBusyIntervals, type BusyInterval } from '../calendar/freeSlots.js';
import {
  SlotUnavailableError,
  type CalendarProvider,
  type CheckAvailabilityInput,
  type CreateEventInput,
  type CreateEventResult,
  type IsFreeInput,
} from '../calendar/types.js';
import { formatInZone, formatSpokenInZone, zonedTimeToUtcIso } from '../lib/timezone.js';
import type { TimeWindow } from '../tasks/schema.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export interface SimEvent {
  eventId: string;
  idempotencyKey: string;
  summary: string;
  startMs: number;
  endMs: number;
}

/**
 * The simulator's calendar (scripts/sim.ts, ROADMAP 4.5): in memory, gone when
 * the sim exits, and nothing is ever written anywhere real. It stands in for
 * the owner's calendar with a believable day — free 9am to 6pm in
 * CALENDAR_TIMEZONE, minus two meetings tomorrow — so the model offers times a
 * person would, not 3am. Bookings go through the same idempotency and
 * double-booking rules as the real providers, and are reported through `print`.
 */
export class SimCalendarProvider implements CalendarProvider {
  readonly events: SimEvent[] = [];

  constructor(
    private readonly timeZone: string,
    private readonly print: (line: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async computeCandidateWindows({ dateWindows, durationMinutes }: CheckAvailabilityInput): Promise<TimeWindow[]> {
    const candidates: TimeWindow[] = [];
    for (const window of dateWindows) {
      const startMs = Date.parse(window.start);
      const endMs = Date.parse(window.end);
      for (const free of subtractBusyIntervals({ startMs, endMs }, this.busyBetween(startMs, endMs))) {
        candidates.push(...chunkIntoWindows(free, durationMinutes));
      }
    }
    return candidates;
  }

  async isFree({ start, durationMinutes }: IsFreeInput): Promise<boolean> {
    const startMs = Date.parse(start);
    const endMs = startMs + durationMinutes * MS_PER_MINUTE;
    return !this.busyBetween(startMs, endMs).some((b) => b.startMs < endMs && b.endMs > startMs);
  }

  async findEventByIdempotencyKey(idempotencyKey: string): Promise<CreateEventResult | undefined> {
    const event = this.events.find((e) => e.idempotencyKey === idempotencyKey);
    return event && toResult(event);
  }

  async createEventIdempotent({ idempotencyKey, start, durationMinutes, summary }: CreateEventInput): Promise<CreateEventResult> {
    const existing = await this.findEventByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    if (!(await this.isFree({ start, durationMinutes }))) throw new SlotUnavailableError();
    const startMs = Date.parse(start);
    const event: SimEvent = {
      eventId: `sim-event-${this.events.length + 1}`,
      idempotencyKey,
      summary,
      startMs,
      endMs: startMs + durationMinutes * MS_PER_MINUTE,
    };
    this.events.push(event);
    const from = formatSpokenInZone(new Date(event.startMs).toISOString(), this.timeZone);
    const to = formatSpokenInZone(new Date(event.endMs).toISOString(), this.timeZone);
    this.print(`[calendar] would book "${summary}" ${from.day}, ${from.time}–${to.time} (dry run: nothing is written)`);
    return toResult(event);
  }

  async deleteEvent(eventId: string): Promise<void> {
    const index = this.events.findIndex((e) => e.eventId === eventId);
    if (index >= 0) this.events.splice(index, 1);
  }

  /** Off-hours (before 9am, from 6pm), tomorrow's two meetings, and anything booked, for every local day the range touches. */
  private busyBetween(startMs: number, endMs: number): BusyInterval[] {
    const busy: BusyInterval[] = this.events.map(({ startMs: s, endMs: e }) => ({ startMs: s, endMs: e }));
    const tomorrow = this.localDate(this.now().getTime() + MS_PER_DAY);
    // A day either side, so a range starting or ending near midnight still gets that day's hours.
    for (let ms = startMs - MS_PER_DAY; ms <= endMs + MS_PER_DAY; ms += MS_PER_DAY) {
      const day = this.localDate(ms);
      busy.push(this.span(day, '00:00', '09:00'), this.span(day, '18:00', '23:59:59'));
      if (day === tomorrow) busy.push(this.span(day, '10:00', '11:00'), this.span(day, '12:00', '13:00'));
    }
    // Clipped to the range: subtractBusyIntervals assumes nothing lies outside
    // its window (see freeSlots.ts), and the day either side above does.
    return busy
      .filter((b) => b.startMs < endMs && b.endMs > startMs)
      .map((b) => ({ startMs: Math.max(b.startMs, startMs), endMs: Math.min(b.endMs, endMs) }));
  }

  private localDate(ms: number): string {
    return formatInZone(new Date(ms).toISOString(), this.timeZone).slice(0, 10);
  }

  private span(day: string, from: string, to: string): BusyInterval {
    const time = (t: string) => Date.parse(zonedTimeToUtcIso(`${day}T${t.length === 5 ? `${t}:00` : t}`, this.timeZone));
    return { startMs: time(from), endMs: time(to) };
  }
}

function toResult(event: SimEvent): CreateEventResult {
  return {
    eventId: event.eventId,
    confirmedStart: new Date(event.startMs).toISOString(),
    confirmedEnd: new Date(event.endMs).toISOString(),
  };
}
