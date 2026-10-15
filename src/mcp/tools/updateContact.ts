import { z } from 'zod';
import { updateContact } from '../../contacts/service.js';
import { preferredChannelEnum } from '../../contacts/schema.js';
import type { Contact } from '../../contacts/schema.js';
import type { McpRole } from '../role.js';

export const updateContactInputSchema = z.object({
  id: z.string().uuid().describe('Id of the contact to update.'),
  preferredChannel: z
    .enum(preferredChannelEnum.enumValues)
    .optional()
    .describe("How the assistant's owner prefers this contact be reached going forward — set this once they state a preference so future tasks don't have to ask again."),
  bookingUrl: z.string().url().optional().describe('Online booking URL for this contact.'),
  notes: z.string().optional().describe('Free-text notes to store on this contact (overwrites existing notes).'),
});

/**
 * A contact's notes go into the prompt of every call to them, so the agent
 * key (MCP_AGENT_API_KEY) can't change them: otherwise an agent could change
 * what a call says after the owner approved it.
 */
export async function updateContactHandler(
  input: z.infer<typeof updateContactInputSchema>,
  ctx: { role: McpRole } = { role: 'owner' },
): Promise<Contact> {
  if (ctx.role === 'agent' && input.notes !== undefined) {
    throw new Error("A contact's notes can only be changed by the owner: they go into every call to this contact. Leave notes out to update the rest.");
  }
  const { id, ...patch } = input;
  return updateContact(id, patch);
}
