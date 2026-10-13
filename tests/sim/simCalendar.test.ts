import { describe, expect, it } from 'vitest';
import { SlotUnavailableError } from '../../src/calendar/types.js';
import { formatInZone, zonedTimeToUtcIso } from '../../src/lib/timezone.js';
import { SimCalendarProvider } from '../../src/sim/simCalendar.js';

const TZ = 'America/New_York';
// Monday 2026-10-12, 8am New York: "tomorrow" is Tuesday the 13th.
const NOW = new Date(zonedTimeToUtcIso('2026-10-12T08:00:00', TZ));
const local = (iso: string) => formatInZone(iso, TZ);
const at = (localTime: string) => zonedTimeToUtcIso(localTime, TZ);

function calendar(print: (line: string) => void = () => {}) {
  return new SimCalendarProvider(TZ, print, () => NOW);
}

describe('SimCalendarProvider', () => {
  it('offers working hours only, around tomorrow’s two meetings', async () => {
    const windows = await calendar().computeCandidateWindows({
      dateWindows: [{ start: at('2026-10-13T00:00:00'), end: at('2026-10-14T00:00:00') }],
      durationMinutes: 60,
    });
    expect(windows.map((w) => local(w.start).slice(11, 16))).toEqual(['09:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
  });

  it('keeps the meetings to tomorrow: the day after is open 9 to 6', async () => {
    const windows = await calendar().computeCandidateWindows({
      dateWindows: [{ start: at('2026-10-14T00:00:00'), end: at('2026-10-15T00:00:00') }],
      durationMinutes: 180,
    });
    expect(windows.map((w) => `${local(w.start).slice(11, 16)}-${local(w.end).slice(11, 16)}`)).toEqual(['09:00-12:00', '12:00-15:00', '15:00-18:00']);
  });

  it('books once per idempotency key, refuses a taken slot, and prints the dry-run booking', async () => {
    const lines: string[] = [];
    const cal = calendar((line) => lines.push(line));
    const input = { idempotencyKey: 'confirm:a', start: at('2026-10-14T14:00:00'), durationMinutes: 60, summary: 'Grooming' };
    const first = await cal.createEventIdempotent(input);
    expect(await cal.createEventIdempotent(input)).toEqual(first);
    expect(cal.events).toHaveLength(1);
    expect(lines).toEqual(['[calendar] would book "Grooming" Wednesday, October 14, 2:00 PM–3:00 PM (dry run: nothing is written)']);
    await expect(cal.createEventIdempotent({ ...input, idempotencyKey: 'confirm:b' })).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(await cal.findEventByIdempotencyKey('confirm:a')).toEqual(first);
  });

  it('treats off-hours and meetings as busy, and a deleted booking as free again', async () => {
    const cal = calendar();
    expect(await cal.isFree({ start: at('2026-10-13T10:30:00'), durationMinutes: 15 })).toBe(false);
    expect(await cal.isFree({ start: at('2026-10-14T07:00:00'), durationMinutes: 30 })).toBe(false);
    const booked = await cal.createEventIdempotent({ idempotencyKey: 'k', start: at('2026-10-14T09:00:00'), durationMinutes: 30, summary: 'x' });
    expect(await cal.isFree({ start: at('2026-10-14T09:00:00'), durationMinutes: 30 })).toBe(false);
    await cal.deleteEvent(booked.eventId);
    expect(await cal.isFree({ start: at('2026-10-14T09:00:00'), durationMinutes: 30 })).toBe(true);
  });
});
