import type { ChatMessage, GenerateOptions } from '../types.js';
import { toMessages } from '../messages.js';
import { validateBaseUrl } from '../url-validation.js';

const DEFAULT_URL = 'http://localhost:11434';

/**
 * Ollama provider. Issue #149: switched from `/api/generate` (which takes
 * a single concatenated prompt) to `/api/chat` (which takes a messages
 * array natively). Both endpoints exist on every modern Ollama server;
 * `/api/chat` matches what every other provider in the chain uses and
 * frees us from the `systemPrompt + "\n\n" + userPrompt` flattening that
 * lost role boundaries.
 *
 * Back-compat: a string `prompt` still works — `toMessages` wraps it as
 * a single user message before the request body is built.
 */
export async function generate(
  _apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions & { baseUrl?: string } = {},
): Promise<string> {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  if (options.baseUrl) validateBaseUrl(options.baseUrl, 'ollama');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    // System prompt is supplied either via options.systemPrompt (legacy
    // path) or as a system-role message in the array (assistant package
    // injects context as a system turn). When both are present, the
    // inline ones win — matches OpenAI's behavior here.
    const inputMessages = toMessages(prompt);
    const hasInlineSystem = inputMessages.some((m) => m.role === 'system');
    const messages: ChatMessage[] = [];
    if (options.systemPrompt && !hasInlineSystem) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push(...inputMessages);

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.3,
          num_predict: options.maxTokens ?? 1024,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}`);
    }

    // /api/chat returns `{ message: { role, content } }` (vs.
    // /api/generate's `{ response }`). Both fields can be empty for an
    // empty model output — return '' rather than undefined for symmetry
    // with the other providers.
    const data = await res.json() as { message?: { content?: string } };
    return data.message?.content ?? '';
  } finally {
    clearTimeout(timeout);
  }
}
