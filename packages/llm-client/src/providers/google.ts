import type { GenerateOptions } from '../types.js';
import { validateBaseUrl } from '../url-validation.js';

const DEFAULT_URL = 'https://generativelanguage.googleapis.com';

export async function generate(
  apiKey: string,
  model: string,
  prompt: string,
  options: GenerateOptions & { baseUrl?: string } = {},
): Promise<string> {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  if (options.baseUrl) validateBaseUrl(options.baseUrl, 'google');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    const contents: unknown[] = [];
    if (options.systemPrompt) {
      contents.push({ role: 'user', parts: [{ text: options.systemPrompt }] });
      contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
    }
    contents.push({ role: 'user', parts: [{ text: prompt }] });

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
