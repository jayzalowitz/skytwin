import type { GenerateOptions } from '../types.js';
import { validateBaseUrl } from '../url-validation.js';

const DEFAULT_URL = 'https://api.anthropic.com';

export async function generate(
  apiKey: string,
  model: string,
  prompt: string,
  options: GenerateOptions & { baseUrl?: string } = {},
): Promise<string> {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  if (options.baseUrl) validateBaseUrl(options.baseUrl, 'anthropic');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 1024,
        ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature ?? 0.3,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { content: { type: string; text: string }[] };
    const textBlock = data.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  } finally {
    clearTimeout(timeout);
  }
}
