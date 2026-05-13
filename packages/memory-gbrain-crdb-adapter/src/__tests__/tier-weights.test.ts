import { describe, it, expect } from 'vitest';
import {
  tierBonus,
  buildTierBonusFn,
  calibrationFromSentVolume,
  relationshipTierFromThreadCount,
  BRIEF_BODY_THRESHOLD,
  HIDDEN_SENTINEL,
  PINNED_BOOST,
  // Back-compat aliases.
  tierMultiplier,
  buildTierWeightFn,
} from '../tier-weights.js';

describe('tierBonus — authoring-tier additive bonuses (#251 additive rewrite)', () => {
  it('returns 0 (no contribution) for unknown / missing metadata', () => {
    expect(tierBonus(null, 'normal')).toBe(0);
    expect(tierBonus(undefined, 'normal')).toBe(0);
    expect(tierBonus({}, 'normal')).toBe(0);
    expect(tierBonus({ authoringTier: 'who_knows' }, 'normal')).toBe(0);
    expect(tierBonus({ authoringTier: 42 }, 'normal')).toBe(0);
  });

  it('applies the normal-band bonuses for each tier (promote only — no received demote)', () => {
    const b = (tier: string) => tierBonus({ authoringTier: tier }, 'normal');
    // Promote authored on close calls. Received tiers are 0 (untouched)
    // because the real-embedding ablation showed that any negative
    // bonus pushes legitimate primary hits below distractors on queries
    // without an authored alternative.
    expect(b('user_sent_originated')).toBeCloseTo(0.005);
    expect(b('user_sent_reply')).toBeCloseTo(0.003);
    expect(b('inbox_personal')).toBe(0);
    expect(b('inbox_broadcast')).toBe(0);
    expect(b('inbox_newsletter')).toBe(0);
    expect(b('inbox_automated')).toBe(0);
  });

  it('sparse calibration compresses the spread', () => {
    const b = (tier: string) => tierBonus({ authoringTier: tier }, 'sparse');
    expect(b('user_sent_originated')).toBeCloseTo(0.002);
    expect(b('user_sent_reply')).toBeCloseTo(0.001);
    expect(b('inbox_newsletter')).toBe(0);
    expect(b('inbox_automated')).toBe(0);
  });

  it('dense calibration widens the spread', () => {
    const b = (tier: string) => tierBonus({ authoringTier: tier }, 'dense');
    expect(b('user_sent_originated')).toBeCloseTo(0.008);
    expect(b('user_sent_reply')).toBeCloseTo(0.005);
    expect(b('inbox_newsletter')).toBe(0);
    expect(b('inbox_automated')).toBe(0);
  });

  it('all bonuses are small relative to typical rrfScore (~0.016)', () => {
    // Sanity check on the absolute scale: a bonus should be enough to
    // flip a near-tie (rank-1 vs rank-2 raw differ by ~0.0003 at rrfK=60)
    // without leapfrogging strong matches (rank-1-in-both at ~0.033 vs
    // rank-10-in-one at ~0.014).
    for (const calibration of ['sparse', 'normal', 'dense'] as const) {
      for (const tier of [
        'user_sent_originated',
        'user_sent_reply',
        'inbox_personal',
        'inbox_broadcast',
        'inbox_newsletter',
        'inbox_automated',
      ]) {
        const b = tierBonus({ authoringTier: tier }, calibration);
        expect(Math.abs(b)).toBeLessThan(0.015); // half the gap to strong-match top
      }
    }
  });
});

describe('tierBonus — userOverride composes additively', () => {
  it('pinned adds PINNED_BOOST on top of the tier bonus', () => {
    // pinned + originated (normal band) = 0.005 + 0.012 = 0.017
    expect(
      tierBonus(
        { authoringTier: 'user_sent_originated', userOverride: 'pinned' },
        'normal',
      ),
    ).toBeCloseTo(0.005 + PINNED_BOOST);
    // pinned + newsletter (normal band) = 0 + 0.012 = 0.012
    // (newsletter tier bonus is 0 in the promote-only configuration)
    expect(
      tierBonus(
        { authoringTier: 'inbox_newsletter', userOverride: 'pinned' },
        'normal',
      ),
    ).toBeCloseTo(PINNED_BOOST);
  });

  it('pinned alone (no tier) still boosts by PINNED_BOOST', () => {
    expect(tierBonus({ userOverride: 'pinned' }, 'normal')).toBeCloseTo(PINNED_BOOST);
  });

  it('hidden returns HIDDEN_SENTINEL — page gets dropped in the RRF fold', () => {
    expect(
      tierBonus(
        { authoringTier: 'user_sent_originated', userOverride: 'hidden' },
        'normal',
      ),
    ).toBe(HIDDEN_SENTINEL);
    expect(tierBonus({ userOverride: 'hidden' }, 'normal')).toBe(HIDDEN_SENTINEL);
  });
});

describe('tierBonus — brief authored-reply downweight', () => {
  it('treats short user_sent_reply as inbox_personal bonus (zero)', () => {
    const b = tierBonus(
      {
        authoringTier: 'user_sent_reply',
        bodyLen: BRIEF_BODY_THRESHOLD - 1,
      },
      'normal',
    );
    expect(b).toBe(0);
  });

  it('a long user_sent_reply keeps the full authored bonus', () => {
    const b = tierBonus(
      { authoringTier: 'user_sent_reply', bodyLen: 500 },
      'normal',
    );
    expect(b).toBeCloseTo(0.003);
  });

  it('short user_sent_originated is also downweighted (proactive but tiny)', () => {
    const b = tierBonus(
      { authoringTier: 'user_sent_originated', bodyLen: 20 },
      'normal',
    );
    expect(b).toBe(0);
  });

  it('bodyLen is ignored for inbox_* tiers — they get their normal bonus', () => {
    const b = tierBonus(
      { authoringTier: 'inbox_personal', bodyLen: 10 },
      'normal',
    );
    expect(b).toBe(0);
  });

  it('non-numeric bodyLen is treated as absent', () => {
    const b = tierBonus(
      { authoringTier: 'user_sent_reply', bodyLen: 'short' },
      'normal',
    );
    expect(b).toBeCloseTo(0.003);
  });
});

describe('buildTierBonusFn closes over the calibration band', () => {
  it('returned function is stable per calibration', () => {
    const fn = buildTierBonusFn('dense');
    expect(fn({ authoringTier: 'user_sent_originated' })).toBeCloseTo(0.008);
    expect(fn({ authoringTier: 'inbox_newsletter' })).toBe(0);
    expect(fn({})).toBe(0);
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

describe('relationshipTier — Phase 2 axis composes additively with authoring', () => {
  it('returns 0 contribution when relationshipTier is missing or unknown', () => {
    expect(tierBonus({ authoringTier: 'inbox_personal' }, 'normal')).toBe(0);
    expect(
      tierBonus(
        { authoringTier: 'inbox_personal', relationshipTier: 'who_knows' },
        'normal',
      ),
    ).toBe(0);
  });

  it('adds the relationship bonus on top of the authoring bonus (normal)', () => {
    // inbox_personal authoring = 0; core relationship = 0.004 → 0.004
    expect(
      tierBonus(
        { authoringTier: 'inbox_personal', relationshipTier: 'core' },
        'normal',
      ),
    ).toBeCloseTo(0.004);
    // user_sent_originated = 0.005; core = 0.004 → 0.009 strong promote
    expect(
      tierBonus(
        { authoringTier: 'user_sent_originated', relationshipTier: 'core' },
        'normal',
      ),
    ).toBeCloseTo(0.009);
    // user_sent_originated = 0.005; stranger = 0 → 0.005 (no rel demote)
    expect(
      tierBonus(
        { authoringTier: 'user_sent_originated', relationshipTier: 'stranger' },
        'normal',
      ),
    ).toBeCloseTo(0.005);
  });

  it('sparse and dense calibrations also scale the relationship band', () => {
    expect(
      tierBonus(
        { authoringTier: 'inbox_personal', relationshipTier: 'core' },
        'sparse',
      ),
    ).toBeCloseTo(0.002);
    expect(
      tierBonus(
        { authoringTier: 'inbox_personal', relationshipTier: 'core' },
        'dense',
      ),
    ).toBeCloseTo(0.006);
  });

  it('relationship bonus composes with pinned override too', () => {
    // user_sent_originated + core + pinned = 0.005 + 0.004 + 0.012 = 0.021
    expect(
      tierBonus(
        {
          authoringTier: 'user_sent_originated',
          relationshipTier: 'core',
          userOverride: 'pinned',
        },
        'normal',
      ),
    ).toBeCloseTo(0.005 + 0.004 + 0.012);
  });

  it('hidden override still drops the page even with relationship bonus', () => {
    expect(
      tierBonus(
        {
          authoringTier: 'inbox_personal',
          relationshipTier: 'core',
          userOverride: 'hidden',
        },
        'normal',
      ),
    ).toBe(HIDDEN_SENTINEL);
  });
});

describe('relationshipTierFromThreadCount thresholds', () => {
  it('0 → stranger', () => {
    expect(relationshipTierFromThreadCount(0)).toBe('stranger');
  });
  it('1..2 → occasional', () => {
    expect(relationshipTierFromThreadCount(1)).toBe('occasional');
    expect(relationshipTierFromThreadCount(2)).toBe('occasional');
  });
  it('3..9 → frequent', () => {
    expect(relationshipTierFromThreadCount(3)).toBe('frequent');
    expect(relationshipTierFromThreadCount(9)).toBe('frequent');
  });
  it('>=10 → core', () => {
    expect(relationshipTierFromThreadCount(10)).toBe('core');
    expect(relationshipTierFromThreadCount(500)).toBe('core');
  });
});

describe('back-compat aliases', () => {
  it('tierMultiplier and tierBonus are the same function', () => {
    expect(tierMultiplier).toBe(tierBonus);
  });
  it('buildTierWeightFn and buildTierBonusFn are the same function', () => {
    expect(buildTierWeightFn).toBe(buildTierBonusFn);
  });
});
