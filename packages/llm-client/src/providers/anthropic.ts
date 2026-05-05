import type { ChatMessage, GenerateOptions } from '../types.js';
import { splitSystemAndConversation, toMessages } from '../messages.js';
import { validateBaseUrl } from '../url-validation.js';

const DEFAULT_URL = 'https://api.anthropic.com';

/**
 * Build the Anthropic `/v1/messages` request body from either a string
 * (back-compat: single user turn) or a `ChatMessage[]` (multi-turn).
 *
 * Anthropic takes `system` as a top-level field separate from the
 * `messages` array, so we split system messages out of the conversation
 * — see `splitSystemAndConversation`. Adjacent same-role messages are
 * NOT merged here (Anthropic accepts them) but the API rejects empty
 * conversations, so we always have at least one message after the split.
 */
function buildAnthropicBody(
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { system, conversation } = splitSystemAndConversation(
    toMessages(prompt),
    options.systemPrompt,
  );
  return {
    model,
    max_tokens: options.maxTokens ?? 1024,
    ...(system ? { system } : {}),
    messages: conversation,
    temperature: options.temperature ?? 0.3,
    ...extra,
  };
}

export async function generate(
  apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
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
      body: JSON.stringify(buildAnthropicBody(model, prompt, options)),
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

/**
 * Native streaming via Anthropic's SSE messages endpoint. Yields one
 * string per `content_block_delta` event with `delta.type === 'text_delta'`.
 *
 * Issue #146 (phase 2a). The same request shape as `generate()` but with
 * `stream: true` and `Accept: text/event-stream`. We tolerate the entire
 * Anthropic event taxonomy by ignoring everything except the text deltas
 * — `message_start`, `content_block_start`, `ping`, `message_delta`,
 * `message_stop` are all benign here.
 *
 * Errors during the stream surface as a thrown `Error`. The provider
 * chain in `LlmClient.generateStream` records that as a circuit-breaker
 * failure and falls through to the next provider.
 */
export async function* streamGenerate(
  apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions & { baseUrl?: string } = {},
): AsyncIterable<string> {
  const baseUrl = options.baseUrl || DEFAULT_URL;
  if (options.baseUrl) validateBaseUrl(options.baseUrl, 'anthropic');
  const controller = new AbortController();
  // Streaming requests can take longer than sync ones (the model is still
  // generating while we read), but a hung connection still needs to time
  // out — use 2x the sync default. Caller-provided timeoutMs wins.
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(buildAnthropicBody(model, prompt, options, { stream: true })),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic stream API error ${res.status}: ${body.slice(0, 200)}`);
    }
    if (!res.body) {
      throw new Error('Anthropic stream API returned no body');
    }

    yield* parseAnthropicSseStream(res.body);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse Anthropic's SSE byte stream into text-delta strings.
 *
 * SSE events look like:
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 * Events are separated by a blank line. We split on `\n\n`, strip the
 * `data: ` prefix, and yield the `delta.text` for any text-delta event.
 * Other event types are ignored.
 *
 * Buffering matters: a chunk from `reader.read()` can split mid-event,
 * so we keep a tail buffer between iterations. Exported so the parser
 * can be unit-tested with a synthetic stream — much easier than mocking
 * fetch + Response.
 */
export async function* parseAnthropicSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE event boundary is a blank line (\n\n). The last fragment
      // may be incomplete — keep it in the buffer for the next read.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const text = extractTextDelta(rawEvent);
        if (text !== null) yield text;
        boundary = buffer.indexOf('\n\n');
      }
    }
    // Flush anything left in the buffer (defensive — Anthropic always
    // ends with a `message_stop` event followed by `\n\n`, but if a
    // server cuts off mid-event we don't want a stuck reader).
    const tail = buffer.trim();
    if (tail.length > 0) {
      const text = extractTextDelta(tail);
      if (text !== null) yield text;
    }
  } finally {
    // Important: release the reader so the underlying connection can be
    // returned to the pool (avoids socket exhaustion under load).
    reader.releaseLock();
  }
}

interface AnthropicDeltaEvent {
  type: string;
  delta?: { type?: string; text?: string };
}

function extractTextDelta(rawEvent: string): string | null {
  // An SSE event can have multiple lines (event:, data:, id:). We only
  // care about `data:` lines and only when they parse to JSON whose
  // `delta.type === 'text_delta'`.
  for (const line of rawEvent.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as AnthropicDeltaEvent;
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        return parsed.delta.text ?? '';
      }
    } catch {
      // Malformed line — log to console, swallow, keep streaming.
      // (Don't kill the whole stream because of one bad event; the
      // model will still emit good ones afterward.)
      // eslint-disable-next-line no-console
      console.warn('[anthropic.stream] failed to parse SSE event line:', payload.slice(0, 100));
    }
  }
  return null;
}
