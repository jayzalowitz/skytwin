import { describe, it, expect } from 'vitest';
import { redactPromptPii } from '../redact.js';

describe('redactPromptPii (#375)', () => {
  it('masks a single email address', () => {
    expect(redactPromptPii('From: bob@acme.com')).toBe('From: [redacted:email]');
  });

  it('masks every email address in the text', () => {
    const input = 'from alice@example.org to bob.smith+tag@sub.acme.co.uk';
    expect(redactPromptPii(input)).toBe('from [redacted:email] to [redacted:email]');
  });

  it('masks an address embedded in a JSON dump (the rawData leak path)', () => {
    const raw = JSON.stringify({ from: 'sender@corp.com', subject: 'Q3 report' });
    const out = redactPromptPii(raw);
    expect(out).not.toContain('sender@corp.com');
    expect(out).toContain('[redacted:email]');
    // The non-PII content the model reasons about is preserved.
    expect(out).toContain('Q3 report');
  });

  it('leaves prose, dates, deadlines, and numbers intact (no reasoning-context loss)', () => {
    const input = 'Reply by 2026-06-15 about the $250 invoice; call 5 vendors. Order 1234567.';
    // No email → unchanged. Critically, the ISO date and numbers survive.
    expect(redactPromptPii(input)).toBe(input);
  });

  it('does not match a bare a@b (needs a real TLD)', () => {
    expect(redactPromptPii('the rate is 3@5 widgets')).toBe('the rate is 3@5 widgets');
  });

  it('is idempotent — re-running over redacted text is a no-op', () => {
    const once = redactPromptPii('contact carol@team.io');
    expect(redactPromptPii(once)).toBe(once);
    expect(once).toBe('contact [redacted:email]');
  });

  it('returns empty / nullish input unchanged', () => {
    expect(redactPromptPii('')).toBe('');
    // The nullish overload accepts undefined/null without @ts-expect-error.
    expect(redactPromptPii(undefined)).toBe(undefined);
    expect(redactPromptPii(null)).toBe(null);
  });

  it('handles addresses with subdomains and plus-addressing', () => {
    expect(redactPromptPii('jay+skytwin@mail.corp.example.com')).toBe('[redacted:email]');
  });

  it('does not hang on pathological input (ReDoS guard — input is untrusted inbound email)', () => {
    // `a@` + thousands of dots with no TLD is the backtracking-bait shape. The
    // length-bounded quantifiers must keep this near-instant, not quadratic.
    const evil = `a@${'.'.repeat(50000)}`;
    const start = Date.now();
    const out = redactPromptPii(evil);
    expect(Date.now() - start).toBeLessThan(1000);
    // No valid TLD → nothing masked; the string passes through unchanged.
    expect(out).toBe(evil);
  });
});
