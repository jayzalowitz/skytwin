import { describe, it, expect } from 'vitest';
import { toMessages, splitSystemAndConversation } from '../messages.js';

// Issue #149 — pure helpers used by every provider's chat-completion
// translation. Tested in isolation so the per-provider tests can focus
// on wire-format translation rather than re-asserting the same boundary
// behavior in four places.

describe('toMessages', () => {
  it('wraps a string as a single user-role message (back-compat)', () => {
    expect(toMessages('hello')).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('passes a ChatMessage[] through unchanged', () => {
    const input = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hey' },
    ];
    expect(toMessages(input)).toBe(input);
  });

  it('wraps an empty string (preserves boundary; provider may reject)', () => {
    // We don't second-guess the caller — if they passed an empty
    // string, they get a one-message array with empty content. The
    // provider's API will reject this, which is the right error to
    // surface (vs. us silently dropping the request).
    expect(toMessages('')).toEqual([{ role: 'user', content: '' }]);
  });
});

describe('splitSystemAndConversation', () => {
  it('separates system messages from the conversation array', () => {
    const result = splitSystemAndConversation([
      { role: 'system', content: 'You are a test bot.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(result.system).toBe('You are a test bot.');
    expect(result.conversation).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('joins multiple system messages with a blank line', () => {
    // The assistant package injects context as a system turn at the
    // head of the array; if a future caller adds more, they all merge
    // rather than the last one winning silently.
    const result = splitSystemAndConversation([
      { role: 'system', content: 'Context block.' },
      { role: 'system', content: 'Another instruction.' },
      { role: 'user', content: 'q' },
    ]);
    expect(result.system).toBe('Context block.\n\nAnother instruction.');
  });

  it('uses the fallback when no inline system messages are present', () => {
    const result = splitSystemAndConversation(
      [{ role: 'user', content: 'q' }],
      'Fallback system.',
    );
    expect(result.system).toBe('Fallback system.');
  });

  it('inline system messages WIN over the fallback (assistant context precedence)', () => {
    // The assistant prepends a context block as a system message; the
    // route also passes the default system prompt via options.systemPrompt
    // (the fallback). The inline one must win — that's where the
    // user-specific facts live. Without this, generic instructions
    // would silently override the personalized context.
    const result = splitSystemAndConversation(
      [
        { role: 'system', content: 'Inline context with user facts.' },
        { role: 'user', content: 'q' },
      ],
      'Generic fallback.',
    );
    expect(result.system).toBe('Inline context with user facts.');
  });

  it('returns empty system when neither source has content', () => {
    const result = splitSystemAndConversation([{ role: 'user', content: 'q' }]);
    expect(result.system).toBe('');
    expect(result.conversation).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('handles an all-system input (provider may reject; we don\'t)', () => {
    const result = splitSystemAndConversation([
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
    ]);
    expect(result.system).toBe('one\n\ntwo');
    expect(result.conversation).toEqual([]);
  });
});
