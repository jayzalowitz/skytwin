import type { ChatMessage, GenerateOptions } from '../types.js';
import { toMessages } from '../messages.js';
import { validateBaseUrl } from '../url-validation.js';

const DEFAULT_URL = 'https://api.openai.com';

export async function generate(
  apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions & { baseUrl?: string } = {},
): Promise<string> {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  if (options.baseUrl) validateBaseUrl(options.baseUrl, 'openai');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    // OpenAI's chat-completion API is already message-array native, so
    // multi-turn translation is essentially a no-op. Issue #149.
    //
    // The systemPrompt option still works for back-compat: it's prepended
    // as a system message UNLESS the input array already contains a
    // system message (then the inline one wins — matches what the
    // assistant package does when it injects context).
    const inputMessages = toMessages(prompt);
    const hasInlineSystem = inputMessages.some((m) => m.role === 'system');
    const messages: ChatMessage[] = [];
    if (options.systemPrompt && !hasInlineSystem) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push(...inputMessages);

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.3,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timeout);
  }
}
