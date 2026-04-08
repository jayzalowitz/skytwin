import type { GenerateOptions } from '../types.js';
import { validateBaseUrl } from '../url-validation.js';

const DEFAULT_URL = 'http://localhost:11434';

export async function generate(
  _apiKey: string,
  model: string,
  prompt: string,
  options: GenerateOptions & { baseUrl?: string } = {},
): Promise<string> {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  if (options.baseUrl) validateBaseUrl(options.baseUrl, 'ollama');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: fullPrompt,
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

    const data = await res.json() as { response: string };
    return data.response ?? '';
  } finally {
    clearTimeout(timeout);
  }
}
