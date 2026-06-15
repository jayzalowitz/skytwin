import { describe, it, expect } from 'vitest';
import {
  shouldShowTierLadderIntro,
  renderTierLadderIntroCard,
  renderTierLadderIntro,
} from '../tier-ladder-intro.js';
import { tierLadderIntroSeenKey } from '../../storage-keys.js';

/**
 * Tests for the #483 tier-ladder INTRODUCTION card (AC 3c):
 * a cold-start `observer` user is shown a one-time, dismissable intro;
 * an existing (promoted) user — or one who already dismissed it — is not.
 *
 * The web app has no jsdom in its test env, so the component is split into
 * pure functions (decision + HTML builder) plus a storage-injectable wrapper
 * exercised here. The DOM side effect (`dismissTierLadderIntro`) is the only
 * untested seam and is a one-liner `getElementById(...).remove()`.
 */

/** Minimal in-memory Storage stand-in. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe('shouldShowTierLadderIntro', () => {
  it('shows for a cold-start observer who has not dismissed', () => {
    expect(shouldShowTierLadderIntro({ currentTier: 'observer', dismissed: false })).toBe(true);
  });

  it('hides once dismissed, even for an observer', () => {
    expect(shouldShowTierLadderIntro({ currentTier: 'observer', dismissed: true })).toBe(false);
  });

  it('hides for a user who has climbed past observer', () => {
    for (const tier of ['suggest', 'low_autonomy', 'moderate_autonomy', 'high_autonomy']) {
      expect(shouldShowTierLadderIntro({ currentTier: tier, dismissed: false })).toBe(false);
    }
  });

  it('hides when the tier is unknown/missing (fail safe — no nag)', () => {
    expect(shouldShowTierLadderIntro({})).toBe(false);
    expect(shouldShowTierLadderIntro({ currentTier: undefined, dismissed: false })).toBe(false);
  });
});

describe('renderTierLadderIntroCard', () => {
  it('renders a dismissable card with the data-action + data-key wired', () => {
    const key = tierLadderIntroSeenKey('user-123');
    const html = renderTierLadderIntroCard(key);
    expect(html).toContain('id="tier-ladder-intro"');
    expect(html).toContain('data-action="dismiss-tier-ladder-intro"');
    expect(html).toContain(`data-key="${key}"`);
  });

  it('does NOT use any inline event-handler attribute (CLAUDE.md)', () => {
    const html = renderTierLadderIntroCard(tierLadderIntroSeenKey('user-123'));
    expect(html).not.toMatch(/on(click|keydown|keyup|mousedown|change|input)\s*=/i);
  });

  it('introduces the ladder, naming the bottom rung in human copy', () => {
    const html = renderTierLadderIntroCard('skytwin_tier_ladder_intro_seen_x');
    // Reuses existing tier labels rather than inventing new prose.
    expect(html).toContain('Watch &amp; Suggest');
    expect(html).toContain('Ask me first');
    expect(html).toContain('Handle small stuff');
    expect(html).toContain('Handle most things');
  });

  it('escapes a key that contains HTML-significant characters', () => {
    const html = renderTierLadderIntroCard('a"><img src=x>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&quot;');
  });
});

describe('renderTierLadderIntro (storage-gated wrapper)', () => {
  it('renders the card for a fresh observer with empty storage', () => {
    const html = renderTierLadderIntro({
      userId: 'u1',
      currentTier: 'observer',
      storage: fakeStorage(),
    });
    expect(html).toContain('id="tier-ladder-intro"');
    expect(html).toContain(tierLadderIntroSeenKey('u1'));
  });

  it('returns empty string when the dismissal flag is already set', () => {
    const key = tierLadderIntroSeenKey('u1');
    const html = renderTierLadderIntro({
      userId: 'u1',
      currentTier: 'observer',
      storage: fakeStorage({ [key]: '1' }),
    });
    expect(html).toBe('');
  });

  it('returns empty string for a promoted user', () => {
    const html = renderTierLadderIntro({
      userId: 'u1',
      currentTier: 'suggest',
      storage: fakeStorage(),
    });
    expect(html).toBe('');
  });

  it('returns empty string when userId is missing', () => {
    expect(renderTierLadderIntro({ currentTier: 'observer', storage: fakeStorage() })).toBe('');
  });

  it('fails safe to empty string when storage throws (private mode)', () => {
    const throwingStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => {},
      removeItem: () => {},
    };
    const html = renderTierLadderIntro({
      userId: 'u1',
      currentTier: 'observer',
      storage: throwingStorage,
    });
    expect(html).toBe('');
  });

  it('scopes the dismissal flag per user', () => {
    const key1 = tierLadderIntroSeenKey('alice');
    const storage = fakeStorage({ [key1]: '1' });
    // alice dismissed → hidden
    expect(renderTierLadderIntro({ userId: 'alice', currentTier: 'observer', storage })).toBe('');
    // bob, same browser, has not → still shown
    expect(renderTierLadderIntro({ userId: 'bob', currentTier: 'observer', storage }))
      .toContain('id="tier-ladder-intro"');
  });
});
