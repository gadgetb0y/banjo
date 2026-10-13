import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let addContactHandler: any;
let addContactInputSchema: any;

// Set the real database URL and reload modules before any tests run
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';

  const dbModule = await import('../../../src/db/index.js');
  const schemaModule = await import('../../../src/contacts/schema.js');
  const tasksModule = await import('../../../src/tasks/schema.js');
  const toolModule = await import('../../../src/mcp/tools/addContact.js');

  db = dbModule.db;
  contacts = schemaModule.contacts;
  tasks = tasksModule.tasks;
  callAttempts = tasksModule.callAttempts;
  addContactHandler = toolModule.addContactHandler;
  addContactInputSchema = toolModule.addContactInputSchema;
});

beforeEach(async () => {
  // Delete in reverse dependency order to handle foreign keys
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
});

describe('addContactHandler', () => {
  it('creates a new contact', async () => {
    const result = await addContactHandler({ displayName: 'Luxe Salon', phoneNumber: '+15551234567' });
    expect(result.created).toBe(true);
    expect(result.created && result.contact.displayName).toBe('Luxe Salon');
  });

  it('stores a relationship tier when given one (#163)', async () => {
    // Through the schema, as the MCP server does: it drops fields it doesn't declare.
    const input = addContactInputSchema.parse({ displayName: 'Nate', phoneNumber: '+15551230001', relationshipTier: 'family' });
    const result = await addContactHandler(input);
    expect(result.created && result.contact.relationshipTier).toBe('family');
  });

  it('returns created: false with the existing contact on a duplicate phone number, instead of throwing', async () => {
    await addContactHandler({ displayName: 'Luxe Salon', phoneNumber: '+15551234567' });

    const result = await addContactHandler({ displayName: 'Luxe Salon (again)', phoneNumber: '+15551234567' });

    expect(result.created).toBe(false);
    expect(!result.created && result.existingContact.displayName).toBe('Luxe Salon');
    expect(!result.created && result.message).toMatch(/already exists/);
  });
});
