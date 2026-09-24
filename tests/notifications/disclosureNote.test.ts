import { describe, expect, it } from 'vitest';
import { withDisclosureNote } from '../../src/notifications/channel.js';

describe('withDisclosureNote (#8)', () => {
  it("adds a note to the owner's notification when the call didn't open by saying it's an AI", () => {
    expect(withDisclosureNote('Booked with Claudia: Fri 10am.', 'missed')).toMatch(/didn't say it was an AI/);
  });

  it('leaves the summary alone otherwise', () => {
    expect(withDisclosureNote('Booked.', 'disclosed')).toBe('Booked.');
    expect(withDisclosureNote('Booked.', 'no_speech')).toBe('Booked.');
    expect(withDisclosureNote('Booked.', undefined)).toBe('Booked.');
  });
});
