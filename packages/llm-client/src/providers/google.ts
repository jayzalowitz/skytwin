import type { ChatMessage, GenerateOptions } from '../types.js';
import { splitSystemAndConversation, toMessages } from '../messages.js';
import { validateBaseUrl } from '../url-validation.js';

const DEFAULT_URL = 'https://generativelanguage.googleapis.com';

/**
 * Translate a `ChatMessage` to Gemini's `contents` entry.
 *
 * Gemini's role vocabulary is `'user' | 'model'` (no separate
 * `'assistant'`). System messages are NOT in the contents array — they
 * go in the top-level `system_instruction` field. This function only
 * handles user/assistant; system messages are split off upstream.
 */
function toGeminiContent(m: ChatMessage): { role: string; parts: { text: string }[] } {
  const role = m.role === 'assistant' ? 'model' : 'user';
  return { role, parts: [{ text: m.content }] };
}

export async function generate(
  apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions & { baseUrl?: string } = {},
): Promise<string> {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  if (options.baseUrl) validateBaseUrl(options.baseUrl, 'google');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    // Issue #149: pass through multi-turn history natively. System messages
    // go in the top-level `system_instruction` field (Gemini's native shape)
    // — previous code emulated it by injecting a "user: <prompt>" + fake
    // "model: Understood." pair at the head of `contents`, which wasted
    // tokens and was easy to drift on.
    const { system, conversation } = splitSystemAndConversation(
      toMessages(prompt),
      options.systemPrompt,
    );
    const contents = conversation.map(toGeminiContent);

    const res = await fetch(
      `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents,
          ...(system
            ? { system_instruction: { parts: [{ text: system }] } }
            : {}),
          generationConfig: {
            temperature: options.temperature ?? 0.3,
            maxOutputTokens: options.maxTokens ?? 1024,
          },
        }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      candidates: { content: { parts: { text: string }[] } }[];
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } finally {
    clearTimeout(timeout);
  }
}
