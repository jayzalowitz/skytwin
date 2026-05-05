import { describe, it, expect, vi } from 'vitest';
import {
  AssistantService,
  formatHistoryAsPrompt,
  MAX_HISTORY_TURNS,
  type ChatTurn,
} from '../assistant-service.js';
import type { LlmClient } from '@skytwin/llm-client';

// Build a stub LlmClient that returns a deterministic response. We don't
// import the real one — the service depends only on the `generate` method's
// shape, and stubbing avoids dragging the provider chain into a unit test.
function stubLlm(content = 'stub reply', overrides: Partial<{ provider: string; model: string; latencyMs: number }> = {}): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content,
      provider: overrides.provider ?? 'anthropic',
      model: overrides.model ?? 'claude-test',
      latencyMs: overrides.latencyMs ?? 42,
    }),
    hasProviders: true,
  } as unknown as LlmClient;
}

describe('AssistantService.reply', () => {
  it('passes the conversation history into the LLM and returns reply + metadata', async () => {
    const llm = stubLlm('Hello back!');
    const service = new AssistantService(llm);

    const history: ChatTurn[] = [
      { role: 'user', content: 'Hi there' },
    ];
    const result = await service.reply(history);

    expect(result.content).toBe('Hello back!');
    expect(result.metadata).toEqual({ provider: 'anthropic', model: 'claude-test', latencyMs: 42 });
    expect(llm.generate).toHaveBeenCalledTimes(1);

    // The default system prompt is passed through so the model knows its role.
    const [, options] = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.systemPrompt).toMatch(/SkyTwin/);
  });

  it('honors a custom system prompt when one is supplied', async () => {
    const llm = stubLlm();
    const service = new AssistantService(llm, 'You are a specialist test bot.');

    await service.reply([{ role: 'user', content: 'q' }]);
    const [, options] = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(options.systemPrompt).toBe('You are a specialist test bot.');
  });

  it('caps history at MAX_HISTORY_TURNS turns (drops oldest, keeps latest)', async () => {
    const llm = stubLlm();
    const service = new AssistantService(llm);

    // 30 turns — we should only see the most recent MAX_HISTORY_TURNS in
    // the prompt. The oldest "turn-0" should NOT appear; the latest
    // "turn-29" must.
    const history: ChatTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as ChatTurn['role'],
      content: `turn-${i}`,
    }));

    await service.reply(history);
    const [prompt] = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(prompt).not.toContain('turn-0\n');
    expect(prompt).not.toContain('turn-9\n');
    expect(prompt).toContain('turn-29');
    expect(prompt).toContain(`turn-${30 - MAX_HISTORY_TURNS}`);
  });

  it('propagates provider failures to the caller', async () => {
    const llm = {
      generate: vi.fn().mockRejectedValue(new Error('boom')),
      hasProviders: true,
    } as unknown as LlmClient;
    const service = new AssistantService(llm);
    await expect(service.reply([{ role: 'user', content: 'x' }])).rejects.toThrow('boom');
  });

  // ── Issue #147 (phase 2b) — twin/memory enrichment ──────────────────

  it('prepends ContextBuilder output to the system prompt when enrichment is supplied', async () => {
    const llm = stubLlm();
    const builder = {
      build: vi.fn().mockResolvedValue('## What I know about you\nTrust tier: high_autonomy'),
    };
    // Cast — the service only depends on the .build() method shape.
    const service = new AssistantService(llm, undefined, builder as unknown as ConstructorParameters<typeof AssistantService>[2]);

    await service.reply(
      [{ role: 'user', content: 'hi' }],
      { userId: 'user-1', query: 'hi' },
    );

    expect(builder.build).toHaveBeenCalledWith('user-1', 'hi');
    const [, options] = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // Context block lands BEFORE the default system prompt so the
    // assistant reads the user-specific facts first.
    expect(options.systemPrompt.startsWith('## What I know about you\nTrust tier: high_autonomy')).toBe(true);
    expect(options.systemPrompt).toContain('SkyTwin'); // the default prompt is still appended
  });

  it('falls back to the bare system prompt when ContextBuilder returns empty', async () => {
    const llm = stubLlm();
    const builder = { build: vi.fn().mockResolvedValue('') };
    const service = new AssistantService(llm, undefined, builder as unknown as ConstructorParameters<typeof AssistantService>[2]);

    await service.reply(
      [{ role: 'user', content: 'q' }],
      { userId: 'user-1', query: 'q' },
    );
    const [, options] = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // No enrichment prefix — system prompt is unchanged.
    expect(options.systemPrompt).toMatch(/^You are SkyTwin/);
  });

  it('skips ContextBuilder when no enrichment is supplied (back-compat)', async () => {
    const llm = stubLlm();
    const builder = { build: vi.fn() };
    const service = new AssistantService(llm, undefined, builder as unknown as ConstructorParameters<typeof AssistantService>[2]);

    await service.reply([{ role: 'user', content: 'q' }]);
    expect(builder.build).not.toHaveBeenCalled();
  });

  it('skips ContextBuilder when no builder was injected (early bring-up)', async () => {
    const llm = stubLlm();
    const service = new AssistantService(llm); // no builder

    // Passing enrichment is fine — without a builder it's a no-op.
    await service.reply(
      [{ role: 'user', content: 'q' }],
      { userId: 'user-1', query: 'q' },
    );
    const [, options] = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(options.systemPrompt).toMatch(/^You are SkyTwin/);
  });
});

describe('formatHistoryAsPrompt', () => {
  it('labels user and assistant turns and ends with an Assistant: prompt', () => {
    const out = formatHistoryAsPrompt([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'How are you?' },
    ]);

    expect(out).toContain('User: Hi');
    expect(out).toContain('Assistant: Hello');
    expect(out).toContain('User: How are you?');
    // Trailing 'Assistant:' so the model knows it's its turn to speak.
    expect(out.endsWith('Assistant:')).toBe(true);
  });

  it('passes system turns through unlabelled (they ride in `systemPrompt` or as raw text)', () => {
    const out = formatHistoryAsPrompt([
      { role: 'system', content: 'Stay in character.' },
      { role: 'user', content: 'go' },
    ]);
    expect(out).toContain('Stay in character.');
    expect(out).not.toContain('System: Stay in character.');
  });

  it('handles empty history (just emits the trailing Assistant: marker)', () => {
    expect(formatHistoryAsPrompt([])).toBe('Assistant:');
  });
});
