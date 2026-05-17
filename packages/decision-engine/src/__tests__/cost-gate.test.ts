import { describe, it, expect } from 'vitest';
import { isTrivialAutoEmail } from '../cost-gate.js';

describe('isTrivialAutoEmail — sender heuristics', () => {
  it('flags noreply / no-reply / donotreply / do-not-reply / mailer-daemon / postmaster senders', () => {
    const trivial = [
      'noreply@example.com',
      'no-reply@example.com',
      'NO.REPLY@example.com',
      'donotreply@example.com',
      'do-not-reply@example.com',
      'Do_Not_Reply@example.com',
      'mailer-daemon@example.com',
      'postmaster@example.com',
    ];
    for (const from of trivial) {
      expect(isTrivialAutoEmail({ from, subject: 'anything' })).toBe(true);
    }
  });

  it('passes-through ordinary sender addresses', () => {
    const real = [
      'jane@example.com',
      'jay.zalowitz@example.com',
      'team@example.com',
      'notifications-team@example.com', // contains "notifications" but not the reply patterns
    ];
    for (const from of real) {
      expect(isTrivialAutoEmail({ from, subject: 'real reply' })).toBe(false);
    }
  });
});

describe('isTrivialAutoEmail — auto-reply / OOO subject heuristics', () => {
  it.each([
    'Out of office',
    'Out Of Office',
    'OUT OF OFFICE',
    'Out  of   office',
    'Auto: Out of office',
    'Re: Out-of-office',
  ])('flags OOO subject %p', (subject) => {
    expect(isTrivialAutoEmail({ from: 'real@example.com', subject })).toBe(true);
  });

  it.each([
    'Auto-reply: We received your message',
    'Auto reply: Thanks',
    'Auto_reply: I am away',
    'Autoreply',
    'Automatic reply: out of office',
    'Auto-responder',
  ])('flags auto-reply subject %p', (subject) => {
    expect(isTrivialAutoEmail({ from: 'real@example.com', subject })).toBe(true);
  });
});

describe('isTrivialAutoEmail — unsubscribe confirmation subjects', () => {
  it.each([
    'Unsubscribe confirmed',
    'Unsubscribe successful',
    'Unsubscribe complete',
    "You've been unsubscribed",
    'You have been unsubscribed',
  ])('flags unsubscribe subject %p', (subject) => {
    expect(isTrivialAutoEmail({ from: 'lists@example.com', subject })).toBe(true);
  });
});

describe('isTrivialAutoEmail — preserves real inbound emails', () => {
  it('does not flag a real reply with a normal subject', () => {
    expect(
      isTrivialAutoEmail({
        from: 'colleague@example.com',
        subject: 'Re: project timeline',
      }),
    ).toBe(false);
  });

  it('handles empty inputs without throwing', () => {
    expect(isTrivialAutoEmail({ from: '', subject: '' })).toBe(false);
    expect(isTrivialAutoEmail({ from: '', subject: 'normal' })).toBe(false);
    expect(isTrivialAutoEmail({ from: 'real@example.com', subject: '' })).toBe(false);
  });

  it('does not over-match on the bare word "office" or "reply"', () => {
    expect(
      isTrivialAutoEmail({
        from: 'colleague@example.com',
        subject: 'office party planning',
      }),
    ).toBe(false);
    expect(
      isTrivialAutoEmail({
        from: 'colleague@example.com',
        subject: 'reply when you can',
      }),
    ).toBe(false);
  });
});
