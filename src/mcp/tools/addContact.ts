import { z } from 'zod';
import { addContact, getContactByPhoneNumber, isContactsUniqueViolation } from '../../contacts/service.js';
import { contactCategoryEnum } from '../../contacts/schema.js';
import type { Contact } from '../../contacts/schema.js';
import type { McpRole } from '../role.js';

export const addContactInputSchema = z.object({
  displayName: z.string().min(1).describe('Human-readable name for the contact, e.g. "Luxe Salon" or "Dr. Patel".'),
  phoneNumber: z.string().min(1).describe('Phone number in E.164 format, e.g. "+14155551234".'),
  category: z
    .enum(contactCategoryEnum.enumValues)
    .optional()
    .describe('Type of business/person. Defaults to "other" if omitted.'),
  notes: z
    .string()
    .optional()
    .describe('Free-text notes about this contact — injected into the live-call system prompt as context (hours, quirks, prior history, etc). Only the owner\'s key can set them.'),
  bookingUrl: z
    .string()
    .url()
    .optional()
    .describe('Online booking URL, if this contact supports booking online as an alternative to a phone call.'),
});

export type AddContactResult =
  | { created: true; contact: Contact }
  | { created: false; message: string; existingContact: Contact };

/**
 * Surfaces a duplicate phone number (contacts_phone_number_unique — see
 * src/contacts/schema.ts) as a clear, distinct shape rather than letting the
 * DB error crash the tool call — the calling skill needs to gracefully
 * offer update_contact/find_contact instead, not see an opaque isError.
 */
/**
 * The agent key (MCP_AGENT_API_KEY) can't set notes: they go into the prompt
 * of every call to the contact, including ones the owner places later.
 */
export async function addContactHandler(
  input: z.infer<typeof addContactInputSchema>,
  ctx: { role: McpRole } = { role: 'owner' },
): Promise<AddContactResult> {
  if (ctx.role === 'agent' && input.notes !== undefined) {
    throw new Error("A contact's notes can only be set by the owner: they go into every call to this contact. Leave notes out to add the contact.");
  }
  try {
    const contact = await addContact(input);
    return { created: true, contact };
  } catch (err) {
    if (isContactsUniqueViolation(err)) {
      const existingContact = await getContactByPhoneNumber(input.phoneNumber);
      if (existingContact) {
        return {
          created: false,
          message: `A contact with phone number "${input.phoneNumber}" already exists: "${existingContact.displayName}". Use update_contact to change it, or find_contact to look it up.`,
          existingContact,
        };
      }
    }
    throw err;
  }
}
