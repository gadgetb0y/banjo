import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let addContact: any;
let updateContactHandler: any;
let updateContactInputSchema: any;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';

  const dbModule = await import('../../../src/db/index.js');
  const schemaModule = await import('../../../src/contacts/schema.js');
  const tasksModule = await import('../../../src/tasks/schema.js');
  const serviceModule = await import('../../../src/contacts/service.js');
  const toolModule = await import('../../../src/mcp/tools/updateContact.js');

  db = dbModule.db;
  contacts = schemaModule.contacts;
  tasks = tasksModule.tasks;
  callAttempts = tasksModule.callAttempts;
  addContact = serviceModule.addContact;
  updateContactHandler = toolModule.updateContactHandler;
  updateContactInputSchema = toolModule.updateContactInputSchema;
});

async function clearTables() {
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}

beforeEach(clearTables);
afterAll(clearTables);

describe('updateContactHandler: relationship tier (#163)', () => {
  // Family and friends may ask Banjo about the owner; everyone else hears
  // only what the call needs. Until now only a Google Contacts sync could
  // set the tier.
  it('sets a tier', async () => {
    const contact = await addContact({ displayName: 'Jessica', phoneNumber: '+15551230002' });
    const updated = await updateContactHandler(updateContactInputSchema.parse({ id: contact.id, relationshipTier: 'family' }));
    expect(updated.relationshipTier).toBe('family');
  });

  it('clears a tier with null', async () => {
    const contact = await addContact({ displayName: 'Sam', phoneNumber: '+15551230003', relationshipTier: 'friend' });
    const updated = await updateContactHandler(updateContactInputSchema.parse({ id: contact.id, relationshipTier: null }));
    expect(updated.relationshipTier).toBeNull();
  });

  it('leaves the tier alone when the field is omitted', async () => {
    const contact = await addContact({ displayName: 'Gema', phoneNumber: '+15551230004', relationshipTier: 'family' });
    const updated = await updateContactHandler(updateContactInputSchema.parse({ id: contact.id, notes: 'Pronounced "Gemma".' }));
    expect(updated.relationshipTier).toBe('family');
  });

  it('rejects anything but family or friend', () => {
    expect(updateContactInputSchema.safeParse({ id: '00000000-0000-4000-8000-000000000000', relationshipTier: 'cousin' }).success).toBe(false);
  });
});
