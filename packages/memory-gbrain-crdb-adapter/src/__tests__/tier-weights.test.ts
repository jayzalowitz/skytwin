import { describe, it, expect } from 'vitest';
import {
  tierMultiplier,
  buildTierWeightFn,
  calibrationFromSentVolume,
  BRIEF_BODY_THRESHOLD,
} from '../tier-weights.js';

describe('tierMultiplier — authoring-tier base weights', () => {
  it('returns 1.0 (identity) for unknown / missing metadata', () => {
    expect(tierMultiplier(null, 'normal')).toBe(1.0);
    expect(tierMultiplier(undefined, 'normal')).toBe(1.0);
    expect(tierMultiplier({}, 'normal')).toBe(1.0);
    expect(tierMultiplier({ authoringTier: 'who_knows' }, 'normal')).toBe(1.0);
    expect(tierMultiplier({ authoringTier: 42 }, 'normal')).toBe(1.0);
  });

  it('applies the normal band weights for each tier', () => {
    const m = (tier: string) => tierMultiplier({ authoringTier: tier }, 'normal');
    expect(m('user_sent_originated')).toBe(1.5);
    expect(m('user_sent_reply')).toBe(1.2);
    expect(m('inbox_personal')).toBe(1.0);
    expect(m('inbox_broadcast')).toBe(0.8);
    expect(m('inbox_newsletter')).toBe(0.4);
    expect(m('inbox_automated')).toBe(0.2);
  });

  it('sparse calibration compresses the spread', () => {
    const m = (tier: string) => tierMultiplier({ authoringTier: tier }, 'sparse');
    expect(m('user_sent_originated')).toBe(1.2);
    expect(m('user_sent_reply')).toBe(1.1);
    expect(m('inbox_newsletter')).toBe(0.5);
    expect(m('inbox_automated')).toBe(0.5);
  });

  it('dense calibration widens the spread', () => {
    const m = (tier: string) => tierMultiplier({ authoringTier: tier }, 'dense');
    expect(m('user_sent_originated')).toBe(2.0);
    expect(m('user_sent_reply')).toBe(1.5);
    expect(m('inbox_newsletter')).toBe(0.3);
    expect(m('inbox_automated')).toBe(0.1);
  });
});

describe('tierMultiplier — userOverride composes orthogonally', () => {
  it("pinned doubles whatever the tier weight would otherwise be", () => {
    // pinned + originated (normal band) = 1.5 * 2 = 3.0
    expect(
      tierMultiplier(
        { authoringTier: 'user_sent_originated', userOverride: 'pinned' },
        'normal',
      ),
    ).toBe(3.0);
    // pinned + newsletter (normal band) = 0.4 * 2 = 0.8
    expect(
      tierMultiplier(
        { authoringTier: 'inbox_newsletter', userOverride: 'pinned' },
        'normal',
      ),
    ).toBe(0.8);
  });

  it('pinned alone (no tier) still boosts to 2.0', () => {
    expect(tierMultiplier({ userOverride: 'pinned' }, 'normal')).toBe(2.0);
  });

  it("hidden forces 0 — page is dropped from retrieval entirely", () => {
    expect(
      tierMultiplier(
        { authoringTier: 'user_sent_originated', userOverride: 'hidden' },
        'normal',
      ),
    ).toBe(0);
    expect(tierMultiplier({ userOverride: 'hidden' }, 'normal')).toBe(0);
  });
});

describe('tierMultiplier — brief authored-reply downweight', () => {
  it('treats short user_sent_reply as inbox_personal weight', () => {
    // 1.2 (reply) would apply, but bodyLen < 50 drops to 1.0 (personal).
    const w = tierMultiplier(
      {
        authoringTier: 'user_sent_reply',
        bodyLen: BRIEF_BODY_THRESHOLD - 1,
      },
      'normal',
    );
    expect(w).toBe(1.0);
  });

  it('a long user_sent_reply keeps the full authored weight', () => {
    const w = tierMultiplier(
      { authoringTier: 'user_sent_reply', bodyLen: 500 },
      'normal',
    );
    expect(w).toBe(1.2);
  });

  it('short user_sent_originated is also downweighted (proactive but tiny)', () => {
    const w = tierMultiplier(
      { authoringTier: 'user_sent_originated', bodyLen: 20 },
      'normal',
    );
    expect(w).toBe(1.0);
  });

  it('bodyLen is ignored for inbox_* tiers — they get their normal weight', () => {
    const w = tierMultiplier(
      { authoringTier: 'inbox_personal', bodyLen: 10 },
      'normal',
    );
    expect(w).toBe(1.0);
  });

  it('non-numeric bodyLen is treated as absent', () => {
    const w = tierMultiplier(
      { authoringTier: 'user_sent_reply', bodyLen: 'short' },
      'normal',
    );
    expect(w).toBe(1.2);
  });
});

describe('buildTierWeightFn closes over the calibration band', () => {
  it('returned function is stable per calibration', () => {
    const fn = buildTierWeightFn('dense');
    expect(fn({ authoringTier: 'user_sent_originated' })).toBe(2.0);
    expect(fn({ authoringTier: 'inbox_newsletter' })).toBe(0.3);
    expect(fn({})).toBe(1.0);
  });
});

describe('calibrationFromSentVolume — thresholds', () => {
  it('< 100 user_sent_* in last 90d → sparse', () => {
    expect(calibrationFromSentVolume(0)).toBe('sparse');
    expect(calibrationFromSentVolume(99)).toBe('sparse');
  });

  it('100..1000 → normal', () => {
    expect(calibrationFromSentVolume(100)).toBe('normal');
    expect(calibrationFromSentVolume(500)).toBe('normal');
    expect(calibrationFromSentVolume(1000)).toBe('normal');
  });

  it('> 1000 → dense', () => {
    expect(calibrationFromSentVolume(1001)).toBe('dense');
    expect(calibrationFromSentVolume(10_000)).toBe('dense');
  });
});
