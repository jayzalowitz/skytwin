import { describe, it, expect } from 'vitest';
import { deriveThreadTitle } from '../repositories/assistant-repository.js';

// Pure helper — no DB. The repo derives a thread title from the first
// user message so the threads-list UI has something to show without an
// LLM round-trip. Issue #135 phase 1.
describe('deriveThreadTitle', () => {
  it('returns the message verbatim when short and single-line', () => {
    expect(deriveThreadTitle('Hello world')).toBe('Hello world');
  });

  it('truncates messages longer than 80 chars and appends an ellipsis', () => {
    const long = 'a'.repeat(120);
    const title = deriveThreadTitle(long);
    expect(title.length).toBe(78); // 77 chars + ellipsis (1 codepoint)
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps only the first line for multi-line messages', () => {
    expect(deriveThreadTitle('First line\nSecond line\nThird line')).toBe('First line');
  });

  it('handles CRLF line endings', () => {
    expect(deriveThreadTitle('First\r\nSecond')).toBe('First');
  });

  it('trims surrounding whitespace', () => {
    expect(deriveThreadTitle('   spaced out   ')).toBe('spaced out');
  });

  it('falls back to "New conversation" for empty / whitespace-only input', () => {
    expect(deriveThreadTitle('')).toBe('New conversation');
    expect(deriveThreadTitle('   ')).toBe('New conversation');
    expect(deriveThreadTitle('\n\n')).toBe('New conversation');
  });

  it('preserves the message exactly at the 80-char boundary', () => {
    const exact = 'a'.repeat(80);
    expect(deriveThreadTitle(exact)).toBe(exact);
    expect(deriveThreadTitle(exact).length).toBe(80);
  });
});
