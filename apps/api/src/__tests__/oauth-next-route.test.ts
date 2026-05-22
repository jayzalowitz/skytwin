import { describe, it, expect } from 'vitest';
import {
  NEXT_HASH_ROUTES,
  _signStatePayloadForTests,
  _parseSignedStateForTests,
  _stateTtlMsForTests,
} from '../routes/oauth.js';

/**
 * Tests for the post-callback `next=` deep-link routing.
 *
 * The onboarding wizard wants to land the user on /#/connect-gmail
 * immediately after Google OAuth completes, not on the dashboard root
 * where a CTA card would tell them "now connect Gmail too." The path
 * is opt-in (passed as ?next=connect-gmail to /authorize) and
 * whitelisted server-side, because a free-form `next` URL would be an
 * open-redirect waiting to happen.
 *
 * Failure modes these tests would catch:
 *   - Free-form `next=` accepted (would let an attacker craft an
 *     authorize URL that bounces the user to evil.com after consent).
 *   - The tag round-trip dropping nextHash (the dashboard would silently
 *     never deep-link, regressing the onboarding flow).
 *   - HMAC signature accidentally NOT covering the `next` tag (would
 *     let an attacker rewrite the redirect target post-issue).
 */
describe('OAuth post-callback next= routing', () => {
  it('NEXT_HASH_ROUTES contains the connect-gmail mapping and only known routes', () => {
    // The whitelist IS the security boundary. Anything missing here can't
    // be used as a redirect target; anything extra is a new attack surface.
    expect(NEXT_HASH_ROUTES['connect-gmail']).toBe('#/connect-gmail');
    // The whitelist should be small — every entry is a route the dashboard
    // SPA actually renders. Catch typos or hash-route drift.
    for (const route of Object.values(NEXT_HASH_ROUTES)) {
      expect(route).toMatch(/^#\//);
    }
  });

  it('state round-trip with next=connect-gmail decodes back to the mapped hash route', () => {
    const expiresAt = Date.now() + _stateTtlMsForTests;
    const state = _signStatePayloadForTests('user-1|next=connect-gmail', expiresAt);

    const parsed = _parseSignedStateForTests(state);

    expect(parsed.userId).toBe('user-1');
    expect(parsed.nextHash).toBe('#/connect-gmail');
  });

  it('state round-trip without a next tag yields nextHash=null', () => {
    const expiresAt = Date.now() + _stateTtlMsForTests;
    const state = _signStatePayloadForTests('user-1|desktop', expiresAt);

    const parsed = _parseSignedStateForTests(state);

    expect(parsed.userId).toBe('user-1');
    expect(parsed.desktop).toBe(true);
    expect(parsed.nextHash).toBeNull();
  });

  it('state round-trip with an unknown next= value drops nextHash to null (not the unknown value)', () => {
    // Even if a state token somehow lands with `next=evil-site` (rolled
    // back deploy, manual fuzz), the parser must not surface a route the
    // whitelist doesn't acknowledge. nextHash must be null so the caller
    // falls through to the default `#/`.
    const expiresAt = Date.now() + _stateTtlMsForTests;
    const state = _signStatePayloadForTests('user-1|next=evil-redirect', expiresAt);

    const parsed = _parseSignedStateForTests(state);

    expect(parsed.nextHash).toBeNull();
  });

  it('flipping a bit in the state breaks signature verification', () => {
    // Sanity check that the `next` tag is inside the HMAC-covered payload,
    // not appended post-sign. If it weren't, an attacker could rewrite
    // the redirect after Google's consent screen.
    const expiresAt = Date.now() + _stateTtlMsForTests;
    const state = _signStatePayloadForTests('user-1|next=connect-gmail', expiresAt);
    // Replace `connect-gmail` with `evil` and re-pack — same shape, same
    // length category, no signature change.
    const tampered = state.replace('next=connect-gmail', 'next=evil-redirect');

    expect(() => _parseSignedStateForTests(tampered)).toThrow(/signature mismatch/);
  });
});
