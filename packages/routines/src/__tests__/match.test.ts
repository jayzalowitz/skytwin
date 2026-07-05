import { describe, it, expect } from 'vitest';
import { matchesFilter, type MatchableSignal } from '../match.js';
import type { RoutineFilter } from '@skytwin/shared-types';

function sig(over: Partial<MatchableSignal> = {}): MatchableSignal {
  return { source: 'gmail', from: 'boss@acme.com', text: 'Q3 budget review', ...over };
}

describe('matchesFilter', () => {
  it('an empty filter matches everything', () => {
    expect(matchesFilter(sig(), {} as RoutineFilter)).toBe(true);
  });

  it('sources: matches only the listed channels', () => {
    expect(matchesFilter(sig({ source: 'outlook' }), { sources: ['outlook', 'gmail'] })).toBe(true);
    expect(matchesFilter(sig({ source: 'google_calendar' }), { sources: ['gmail'] })).toBe(false);
  });

  it('fromContains: case-insensitive substring on the sender', () => {
    expect(matchesFilter(sig({ from: 'Boss@ACME.com' }), { fromContains: ['acme.com'] })).toBe(true);
    expect(matchesFilter(sig({ from: 'someone@else.com' }), { fromContains: ['acme.com'] })).toBe(false);
  });

  it('keywords: case-insensitive substring on the text', () => {
    expect(matchesFilter(sig({ text: 'the Q3 BUDGET is ready' }), { keywords: ['budget'] })).toBe(true);
    expect(matchesFilter(sig({ text: 'lunch plans' }), { keywords: ['budget'] })).toBe(false);
  });

  it('domains expand to related terms (a security watch catches phishing/suspicious)', () => {
    // 'security' expands so the text need not literally say "security".
    expect(matchesFilter(sig({ text: 'a suspicious login attempt' }), { domains: ['security'] })).toBe(true);
    expect(matchesFilter(sig({ text: 'possible phishing email' }), { domains: ['security'] })).toBe(true);
    expect(matchesFilter(sig({ text: 'calendar conflict detected' }), { domains: ['scheduling'] })).toBe(true);
    expect(matchesFilter(sig({ text: 'all clear' }), { domains: ['security'] })).toBe(false);
  });

  it('an unknown domain falls back to a literal match', () => {
    expect(matchesFilter(sig({ text: 'the invoice is attached' }), { domains: ['invoice'] })).toBe(true);
    expect(matchesFilter(sig({ text: 'lunch plans' }), { domains: ['invoice'] })).toBe(false);
  });

  it('AND across fields: source matches but sender does not → no match', () => {
    expect(
      matchesFilter(sig({ source: 'gmail', from: 'stranger@x.com' }), {
        sources: ['gmail'],
        fromContains: ['acme.com'],
      }),
    ).toBe(false);
  });

  it('OR within a field: any keyword matching is enough', () => {
    expect(matchesFilter(sig({ text: 'hiring update' }), { keywords: ['budget', 'hiring'] })).toBe(true);
  });

  it('all fields present and all satisfied → match', () => {
    expect(
      matchesFilter(sig({ source: 'gmail', from: 'boss@acme.com', text: 'Q3 budget' }), {
        sources: ['gmail'],
        fromContains: ['acme.com'],
        keywords: ['budget'],
      }),
    ).toBe(true);
  });
});
