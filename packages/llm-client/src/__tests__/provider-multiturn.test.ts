import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generate as anthropicGenerate,
  streamGenerate as anthropicStreamGenerate,
} from '../providers/anthropic.js';
import { generate as openaiGenerate } from '../providers/openai.js';
import { generate as googleGenerate } from '../providers/google.js';
import { generate as ollamaGenerate } from '../providers/ollama.js';
import { canonicalizeProviderBaseUrl } from '@skytwin/shared-types';

// Issue #149 — verify each provider correctly translates `string |
// ChatMessage[]` into its native chat-completion wire format. Tests
// stub fetch and assert against the parsed request body, which is the
// load-bearing surface for multi-turn behavior.

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function captureFetch(responseBody: unknown): { spy: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const spy = (async (input: string | URL | { url: string }, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    captured.push({ url, body });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { spy, captured };
}

function captureVerifiedLocalOllamaFetch(
  chatResponseBody: unknown,
  version: unknown = '0.18.0',
): { spy: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const spy = (async (input: string | URL | { url: string }, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    captured.push({ url, body });
    return new Response(JSON.stringify(
      url.endsWith('/api/version') ? { version } : chatResponseBody,
    ), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { spy, captured };
}

describe('Anthropic provider — multi-turn translation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborts and cancels a custom stream when its consumer stops early', async () => {
    const encoded = new TextEncoder().encode(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"first"}}\n\n',
    );
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel,
    });
    const request: { signal?: AbortSignal } = {};
    vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => {
      request.signal = init?.signal as AbortSignal;
      return new Response(body, { status: 200 });
    }));

    const stream = anthropicStreamGenerate(
      'key',
      'claude-test',
      'hello',
      { baseUrl: 'https://93.184.216.34' },
    )[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toEqual({ done: false, value: 'first' });
    await stream.return?.(undefined);

    expect(request.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('wraps a string prompt as a single user-role message', async () => {
    const { spy, captured } = captureFetch({ content: [{ type: 'text', text: 'ok' }] });
    vi.stubGlobal('fetch', spy);
    await anthropicGenerate('key', 'claude-test', 'hello world');
    expect(captured[0]!.body.messages).toEqual([{ role: 'user', content: 'hello world' }]);
  });

  it('passes a ChatMessage[] through to the messages field', async () => {
    const { spy, captured } = captureFetch({ content: [{ type: 'text', text: 'ok' }] });
    vi.stubGlobal('fetch', spy);
    await anthropicGenerate('key', 'claude-test', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'how are you?' },
    ]);
    expect(captured[0]!.body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'how are you?' },
    ]);
  });

  it('hoists inline system messages to the top-level `system` field', async () => {
    const { spy, captured } = captureFetch({ content: [{ type: 'text', text: 'ok' }] });
    vi.stubGlobal('fetch', spy);
    await anthropicGenerate('key', 'claude-test', [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(captured[0]!.body.system).toBe('You are concise.');
    // System should NOT appear in the messages array (Anthropic rejects it there).
    expect(captured[0]!.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('inline system wins over options.systemPrompt fallback', async () => {
    const { spy, captured } = captureFetch({ content: [{ type: 'text', text: 'ok' }] });
    vi.stubGlobal('fetch', spy);
    await anthropicGenerate(
      'key',
      'claude-test',
      [
        { role: 'system', content: 'Inline wins.' },
        { role: 'user', content: 'q' },
      ],
      { systemPrompt: 'Fallback loses.' },
    );
    expect(captured[0]!.body.system).toBe('Inline wins.');
  });
});

describe('OpenAI provider — multi-turn translation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wraps a string prompt as a single user message + prepended system', async () => {
    const { spy, captured } = captureFetch({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', spy);
    await openaiGenerate('key', 'gpt-test', 'hello', { systemPrompt: 'Be brief.' });
    expect(captured[0]!.body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('appends one API path separator to a canonical origin-only base URL', async () => {
    const { spy, captured } = captureFetch({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', spy);
    await openaiGenerate('key', 'gpt-test', 'hello', {
      baseUrl: canonicalizeProviderBaseUrl('https://93.184.216.34/'),
    });
    expect(captured[0]!.url).toBe('https://93.184.216.34/v1/chat/completions');
  });

  it('appends one API path separator after a canonical custom base path', async () => {
    const { spy, captured } = captureFetch({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', spy);
    await openaiGenerate('key', 'gpt-test', 'hello', {
      baseUrl: canonicalizeProviderBaseUrl('https://93.184.216.34/gateway///'),
    });
    expect(captured[0]!.url).toBe('https://93.184.216.34/gateway/v1/chat/completions');
  });

  it('canonicalizes a raw custom base URL at the provider boundary', async () => {
    const { spy, captured } = captureFetch({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', spy);
    await openaiGenerate('key', 'gpt-test', 'hello', {
      baseUrl: 'https://93.184.216.34/gateway///',
    });
    expect(captured[0]!.url).toBe('https://93.184.216.34/gateway/v1/chat/completions');
  });

  it('passes a ChatMessage[] through unchanged', async () => {
    const { spy, captured } = captureFetch({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', spy);
    await openaiGenerate('key', 'gpt-test', [
      { role: 'system', content: 'context' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(captured[0]!.body.messages).toEqual([
      { role: 'system', content: 'context' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('does NOT duplicate the system message when both inline and options are supplied', async () => {
    // The fallback (options.systemPrompt) gets dropped silently when the
    // array already has a system message. Without this guard we'd ship
    // two system messages and the model might prefer the wrong one.
    const { spy, captured } = captureFetch({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', spy);
    await openaiGenerate(
      'key',
      'gpt-test',
      [
        { role: 'system', content: 'Inline wins.' },
        { role: 'user', content: 'q' },
      ],
      { systemPrompt: 'Fallback loses.' },
    );
    const messages = captured[0]!.body.messages as Array<{ role: string }>;
    expect(messages.filter((m) => m.role === 'system').length).toBe(1);
    expect(messages[0]).toEqual({ role: 'system', content: 'Inline wins.' });
  });
});

describe('Google/Gemini provider — multi-turn translation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('translates assistant role to "model" in contents (Gemini vocabulary)', async () => {
    const { spy, captured } = captureFetch({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
    vi.stubGlobal('fetch', spy);
    await googleGenerate('key', 'gemini-test', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'q' },
    ]);
    expect(captured[0]!.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hey' }] },
      { role: 'user', parts: [{ text: 'q' }] },
    ]);
  });

  it('puts system messages in top-level system_instruction (no fake user/model pair)', async () => {
    // Pre-#149 the provider injected a "user: <prompt>" + fake
    // "model: Understood." pair to emulate a system message. Now we
    // use Gemini's native system_instruction field — saves tokens.
    const { spy, captured } = captureFetch({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
    vi.stubGlobal('fetch', spy);
    await googleGenerate('key', 'gemini-test', [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'q' },
    ]);
    expect(captured[0]!.body.system_instruction).toEqual({
      parts: [{ text: 'You are concise.' }],
    });
    // No fake "model: Understood." entry — contents has just the user turn.
    expect(captured[0]!.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
    ]);
  });

  it('falls back to options.systemPrompt for system_instruction when no inline system', async () => {
    const { spy, captured } = captureFetch({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
    vi.stubGlobal('fetch', spy);
    await googleGenerate('key', 'gemini-test', 'q', { systemPrompt: 'Be brief.' });
    expect(captured[0]!.body.system_instruction).toEqual({
      parts: [{ text: 'Be brief.' }],
    });
  });

  it('omits system_instruction entirely when no system content exists', async () => {
    const { spy, captured } = captureFetch({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
    vi.stubGlobal('fetch', spy);
    await googleGenerate('key', 'gemini-test', 'q');
    expect(captured[0]!.body).not.toHaveProperty('system_instruction');
  });
});

describe('Ollama provider — switched to /api/chat', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits /api/chat (not /api/generate) and sends a messages array', async () => {
    const { spy, captured } = captureVerifiedLocalOllamaFetch({ message: { content: 'ok' } });
    vi.stubGlobal('fetch', spy);
    await ollamaGenerate('', 'llama-test', 'hello', { reasoningMode: 'on_device' });
    expect(captured[0]!.url).toContain('/api/version');
    expect(captured[1]!.url).toContain('/api/chat');
    expect(captured[1]!.url).not.toContain('/api/generate');
    expect(captured[1]!.body.model).toBe('llama-test:local');
    expect(captured[1]!.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('canonicalizes a raw loopback base URL before appending API paths', async () => {
    const { spy, captured } = captureVerifiedLocalOllamaFetch({ message: { content: 'ok' } });
    vi.stubGlobal('fetch', spy);
    await ollamaGenerate('', 'llama-test', 'hello', {
      baseUrl: 'http://127.1:11434///',
      reasoningMode: 'on_device',
    });
    expect(captured[0]!.url).toBe('http://127.0.0.1:11434/api/version');
    expect(captured[1]!.url).toBe('http://127.0.0.1:11434/api/chat');
  });

  it('rejects redirects from the default loopback endpoint', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.18.0' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 307, headers: { Location: 'https://external.example/collect' },
      }));
    vi.stubGlobal('fetch', spy);

    await expect(ollamaGenerate('', 'llama-test', 'private prompt', {
      reasoningMode: 'on_device',
    })).rejects.toThrow(
      'Redirects are not allowed',
    );
    expect(spy).toHaveBeenLastCalledWith(
      'http://127.0.0.1:11434/api/chat',
      expect.objectContaining({ redirect: 'manual', dispatcher: expect.any(Object) }),
    );
  });

  it('source-qualifies arbitrary aliases for on-device execution', async () => {
    const { spy, captured } = captureVerifiedLocalOllamaFetch({ message: { content: 'ok' } });
    vi.stubGlobal('fetch', spy);
    await ollamaGenerate('', 'private-alias', 'private prompt', {
      reasoningMode: 'on_device',
    });
    expect(captured[1]!.body.model).toBe('private-alias:local');
  });

  it('does not add a second local source selector', async () => {
    const { spy, captured } = captureVerifiedLocalOllamaFetch({ message: { content: 'ok' } });
    vi.stubGlobal('fetch', spy);
    await ollamaGenerate('', 'llama-test:LOCAL', 'private prompt', {
      reasoningMode: 'on_device',
    });
    expect(captured[1]!.body.model).toBe('llama-test:local');
  });

  it('rejects explicit cloud selectors before making an on-device request', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(ollamaGenerate('', 'gpt-oss:120b-cloud', 'private prompt', {
      reasoningMode: 'on_device',
    })).rejects.toThrow('not eligible for on-device reasoning');
    expect(spy).not.toHaveBeenCalled();
  });

  it('preserves the configured model for bring-your-own-provider requests', async () => {
    const { spy, captured } = captureFetch({ message: { content: 'ok' } });
    vi.stubGlobal('fetch', spy);
    await ollamaGenerate('', 'qwen3:cloud', 'intentional remote prompt', {
      reasoningMode: 'bring_your_own_provider',
    });
    expect(captured[0]!.body.model).toBe('qwen3:cloud');
  });

  it('refuses an old or malformed Ollama version before sending a prompt', async () => {
    for (const version of ['0.17.6', 'unknown', null]) {
      const { spy, captured } = captureVerifiedLocalOllamaFetch(
        { message: { content: 'must not run' } },
        version,
      );
      vi.stubGlobal('fetch', spy);
      await expect(ollamaGenerate('', 'llama-test', 'private prompt', {
        reasoningMode: 'on_device',
      })).rejects.toThrow('requires version 0.18.0 or newer');
      expect(captured.map(({ url }) => url)).toEqual([
        'http://127.0.0.1:11434/api/version',
      ]);
    }
  });

  it('rejects unexpected remote-execution metadata on an on-device response', async () => {
    const { spy } = captureVerifiedLocalOllamaFetch({
      message: { content: 'must not return' },
      remote_host: 'https://ollama.com',
      remote_model: 'remote-model',
    });
    vi.stubGlobal('fetch', spy);
    await expect(ollamaGenerate('', 'llama-test', 'private prompt', {
      reasoningMode: 'on_device',
    })).rejects.toThrow('reported remote inference');
  });

  it('passes a multi-turn ChatMessage[] through unchanged', async () => {
    const { spy, captured } = captureFetch({ message: { content: 'ok' } });
    vi.stubGlobal('fetch', spy);
    await ollamaGenerate('', 'llama-test', [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(captured[0]!.body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('parses /api/chat response shape ({message: {content}}) — not /api/generate', async () => {
    const { spy } = captureFetch({ message: { content: 'real reply' } });
    vi.stubGlobal('fetch', spy);
    const result = await ollamaGenerate('', 'llama-test', 'hello');
    expect(result).toBe('real reply');
  });

  it('returns "" for an empty model response (defensive)', async () => {
    const { spy } = captureFetch({ message: {} });
    vi.stubGlobal('fetch', spy);
    const result = await ollamaGenerate('', 'llama-test', 'hello');
    expect(result).toBe('');
  });
});
