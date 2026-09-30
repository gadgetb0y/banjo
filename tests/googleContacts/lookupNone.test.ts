import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// With CONTACTS_PROVIDER=none nothing keeps the cache current, so lookups
// mustn't read it at all. The db is mocked so any read shows up as a call.
const select = vi.fn(() => {
  throw new Error('the contacts cache was read');
});
vi.mock('../../src/db/index.js', () => ({ db: { select } }));

let lookup: typeof import('../../src/googleContacts/lookup.js');
const previous = process.env.CONTACTS_PROVIDER;

beforeAll(async () => {
  process.env.CONTACTS_PROVIDER = 'none';
  vi.resetModules();
  lookup = await import('../../src/googleContacts/lookup.js');
});

afterAll(() => {
  if (previous === undefined) delete process.env.CONTACTS_PROVIDER;
  else process.env.CONTACTS_PROVIDER = previous;
});

describe('lookup with CONTACTS_PROVIDER=none', () => {
  it('finds no one by phone or name without reading rows an earlier provider left behind', async () => {
    expect(await lookup.findByPhone('+15551112222')).toBeUndefined();
    expect(await lookup.findByName('claudia')).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
