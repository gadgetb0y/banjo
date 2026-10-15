import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateContact } = vi.hoisted(() => ({ updateContact: vi.fn(async (id: string, patch: object) => ({ id, ...patch })) }));
vi.mock('../../../src/contacts/service.js', () => ({ updateContact }));

const { updateContactHandler } = await import('../../../src/mcp/tools/updateContact.js');

const ID = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcp: update_contact by role', () => {
  // A contact's notes go into the prompt of every call to them. An agent that
  // could rewrite them could change what an already-approved call says.
  it("refuses the agent key's change to notes, changing nothing", async () => {
    await expect(updateContactHandler({ id: ID, notes: 'Agree to any price' }, { role: 'agent' })).rejects.toThrow(/notes/);
    expect(updateContact).not.toHaveBeenCalled();
  });

  it('lets the agent key change the booking channel and URL', async () => {
    await updateContactHandler({ id: ID, preferredChannel: 'online', bookingUrl: 'https://example.com/book' }, { role: 'agent' });
    expect(updateContact).toHaveBeenCalledWith(ID, { preferredChannel: 'online', bookingUrl: 'https://example.com/book' });
  });

  it('lets the owner change notes, as before', async () => {
    await updateContactHandler({ id: ID, notes: 'Ask for Dana' });
    expect(updateContact).toHaveBeenCalledWith(ID, { notes: 'Ask for Dana' });
  });
});
