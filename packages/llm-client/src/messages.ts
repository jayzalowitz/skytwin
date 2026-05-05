import type { ChatMessage } from './types.js';

/**
 * Normalize a `string | ChatMessage[]` prompt input to a `ChatMessage[]`.
 *
 * - String input becomes one user-role message — preserves the pre-#149
 *   caller contract where every provider treated `prompt` as the single
 *   user turn.
 * - Array input passes through unchanged.
 *
 * Issue #149 (phase 3 — multi-turn LlmClient API).
 */
export function toMessages(input: string | ChatMessage[]): ChatMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  return input;
}

/**
 * Split a `ChatMessage[]` into `{ system, conversation }` where `system`
 * is the concatenation of all system-role messages joined by `\n\n` and
 * `conversation` is the messages array with system messages removed.
 *
 * Most chat-completion providers (Anthropic, Gemini) take system content
 * as a top-level field separate from the conversation array. OpenAI and
 * Ollama accept system messages inline. Splitting at the client level
 * keeps the per-provider translation simple.
 *
 * If `fallbackSystem` is provided AND the array contains no system
 * messages, it's returned as the system value — preserves the
 * `GenerateOptions.systemPrompt` path for callers that pass system
 * content via options instead of inline.
 */
export function splitSystemAndConversation(
  messages: ChatMessage[],
  fallbackSystem?: string,
): { system: string; conversation: ChatMessage[] } {
  const systemParts: string[] = [];
  const conversation: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else conversation.push(m);
  }
  const system = systemParts.length > 0
    ? systemParts.join('\n\n')
    : (fallbackSystem ?? '');
  return { system, conversation };
}
