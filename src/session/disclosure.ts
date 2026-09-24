import { AI_WORD } from '../config/index.js';

/**
 * Did the call open by saying it's an AI? (#8)
 *
 * Disclosure is a prompt rule, not an enforced verbatim opener, so this is
 * the backstop: it looks at the first thing Banjo actually said. Before #8
 * every demo call opened "I'm calling on behalf of Steve" and only said "AI"
 * when asked. Checks for the word, not the exact DISCLOSURE_LINE — the model
 * paraphrases, and saying it's an AI is what matters.
 */
export type DisclosureResult = 'disclosed' | 'missed' | 'no_speech';

export function checkDisclosure(firstAssistantLine: string | undefined): DisclosureResult {
  if (firstAssistantLine === undefined) return 'no_speech';
  return AI_WORD.test(firstAssistantLine) ? 'disclosed' : 'missed';
}
