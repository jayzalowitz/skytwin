import { describe, it, expect } from 'vitest';
import { resolveRequestedScopes } from '../routes/oauth.js';

/**
 * Tier-gating tests for the Google OAuth scope set.
 *
 * The rule: requesting Gmail scopes from the bundled (SkyTwin-team)
 * OAuth client is intentionally NOT allowed at launch, because that
 * client is not enrolled in Google's annual CASA security assessment
 * (~$15k–$50k) required for restricted scopes. User-supplied OAuth
 * credentials sidestep the gate because Google does not require app
 * verification for a user's own OAuth client used only by themselves.
 *
 * Failure modes these tests would catch:
 *   - A future refactor that silently includes Gmail in the bundled
 *     scope list (would trigger an "invalid_scope" from Google AT
 *     BEST, or worse, a "compliance violation: this client is not
 *     approved for the requested scope" suspension).
 *   - Dropping the `skipped` reporting so the dashboard can no longer
 *     surface a "Connect Gmail" CTA — the silent-coverage-gap bug.
 */
describe('resolveRequestedScopes — tier gating', () => {
  it('bundled client + no Gmail request → identity + calendar only', () => {
    const { scopes, skipped } = resolveRequestedScopes({
      source: 'bundled',
      includeGmail: false,
    });
    expect(scopes).toContain('openid');
    expect(scopes).toContain('email');
    expect(scopes).toContain('profile');
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.readonly');
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scopes.some((s) => s.includes('gmail'))).toBe(false);
    expect(skipped).toEqual([]);
  });

  it('bundled client + Gmail requested → Gmail dropped, skipped reports the gap', () => {
    const { scopes, skipped } = resolveRequestedScopes({
      source: 'bundled',
      includeGmail: true,
    });
    expect(scopes.some((s) => s.includes('gmail'))).toBe(false);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toEqual({
      capability: 'gmail',
      reason: 'bundled-client-not-verified-for-restricted-scopes',
    });
  });

  it('user-supplied client + Gmail requested → Gmail included', () => {
    const { scopes, skipped } = resolveRequestedScopes({
      source: 'user-supplied',
      includeGmail: true,
    });
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(skipped).toEqual([]);
  });

  it('user-supplied client + no Gmail requested → Gmail NOT included even though it could be', () => {
    // Avoid over-asking. If the caller didn't ask for Gmail, Google's
    // consent screen shouldn't surface the Gmail prompt — only ask for
    // what's actually being used.
    const { scopes, skipped } = resolveRequestedScopes({
      source: 'user-supplied',
      includeGmail: false,
    });
    expect(scopes.some((s) => s.includes('gmail'))).toBe(false);
    expect(skipped).toEqual([]);
  });

  it('unset client + Gmail requested → still drops Gmail, still reports skipped', () => {
    // The /authorize route returns 503 before reaching scope resolution
    // when there's no clientId at all, but if a future caller does
    // reach this helper with an unset config it should behave the same
    // way as the bundled case: don't include restricted scopes.
    const { scopes, skipped } = resolveRequestedScopes({
      source: 'unset',
      includeGmail: true,
    });
    expect(scopes.some((s) => s.includes('gmail'))).toBe(false);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.capability).toBe('gmail');
  });

  it('always includes the identity scope set (openid + email + profile)', () => {
    // Without verified identity we can't key the local user row on the
    // Google email. Every branch must include these three.
    for (const source of ['bundled', 'user-supplied', 'unset'] as const) {
      for (const includeGmail of [false, true]) {
        const { scopes } = resolveRequestedScopes({ source, includeGmail });
        expect(scopes).toContain('openid');
        expect(scopes).toContain('email');
        expect(scopes).toContain('profile');
      }
    }
  });
});
