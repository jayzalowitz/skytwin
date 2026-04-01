import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreferenceArchaeologist } from '../preference-archaeologist.js';
import type { TwinEvidence, Preference, FeedbackEvent } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

// ── Mock Repository ──────────────────────────────────────────────

function createMockRepository() {
  let evidenceStore: TwinEvidence[] = [];
  let feedbackStore: FeedbackEvent[] = [];
  let preferenceStore: Preference[] = [];

  return {
    getProfile: vi.fn(async () => null),
    createProfile: vi.fn(async (p: unknown) => p),
    updateProfile: vi.fn(async (p: unknown) => p),
    getPreferences: vi.fn(async () => preferenceStore),
    getPreferencesByDomain: vi.fn(async () => []),
    upsertPreference: vi.fn(async () => ({})),
    getInferences: vi.fn(async () => []),
    upsertInference: vi.fn(async () => ({})),
    addEvidence: vi.fn(async () => ({})),
    getEvidence: vi.fn(async () => evidenceStore),
    getEvidenceByIds: vi.fn(async () => []),
    addFeedback: vi.fn(async () => ({})),
    getFeedback: vi.fn(async () => feedbackStore),

    // Test helpers
    _setEvidence: (ev: TwinEvidence[]) => {
      evidenceStore = ev;
    },
    _setFeedback: (fb: FeedbackEvent[]) => {
      feedbackStore = fb;
    },
    _setPreferences: (prefs: Preference[]) => {
      preferenceStore = prefs;
    },
  };
}

function makeEvidence(
  id: string,
  domain: string,
  action: string,
  overrides?: Partial<TwinEvidence>,
): TwinEvidence {
  return {
    id,
    userId: 'user_1',
    source: 'test',
    type: 'user_action',
    data: { action },
    domain,
    timestamp: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('PreferenceArchaeologist', () => {
  let repo: ReturnType<typeof createMockRepository>;
  let archaeologist: PreferenceArchaeologist;

  beforeEach(() => {
    repo = createMockRepository();
    archaeologist = new PreferenceArchaeologist(repo as never);
  });

  it('returns empty when fewer than 5 evidence items in any group', async () => {
    // Only 3 items in one group -- below threshold
    repo._setEvidence([
      makeEvidence('ev_1', 'email', 'archive'),
      makeEvidence('ev_2', 'email', 'archive'),
      makeEvidence('ev_3', 'email', 'archive'),
    ]);

    const proposals = await archaeologist.analyze('user_1');

    expect(proposals).toEqual([]);
  });

  it('generates a proposal when 5+ consistent evidence items exist in a group', async () => {
    const evidence: TwinEvidence[] = [];
    for (let i = 0; i < 7; i++) {
      evidence.push(makeEvidence(`ev_${i}`, 'email', 'archive'));
    }
    repo._setEvidence(evidence);

    const proposals = await archaeologist.analyze('user_1');

    expect(proposals.length).toBe(1);
    expect(proposals[0]!.domain).toBe('email');
    expect(proposals[0]!.key).toBe('archive');
    expect(proposals[0]!.status).toBe('pending');
    expect(proposals[0]!.supportingEvidence.length).toBeGreaterThan(0);
  });

  it('does not re-propose existing explicit preferences', async () => {
    const evidence: TwinEvidence[] = [];
    for (let i = 0; i < 10; i++) {
      evidence.push(makeEvidence(`ev_${i}`, 'email', 'archive'));
    }
    repo._setEvidence(evidence);

    // Mark 'archive' as an existing explicit preference
    repo._setPreferences([
      {
        id: 'pref_1',
        domain: 'email',
        key: 'archive',
        value: true,
        confidence: ConfidenceLevel.HIGH,
        source: 'explicit',
        evidenceIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const proposals = await archaeologist.analyze('user_1');

    expect(proposals).toEqual([]);
  });

  it('confidence scales with evidence count: LOW for 5-9, MODERATE for 10-19, HIGH for 20+', async () => {
    // 6 items -> LOW
    const lowEvidence: TwinEvidence[] = [];
    for (let i = 0; i < 6; i++) {
      lowEvidence.push(makeEvidence(`ev_low_${i}`, 'email', 'archive'));
    }
    repo._setEvidence(lowEvidence);
    const lowProposals = await archaeologist.analyze('user_1');
    expect(lowProposals.length).toBe(1);
    expect(lowProposals[0]!.confidence).toBe(ConfidenceLevel.LOW);

    // 12 items -> MODERATE
    const modEvidence: TwinEvidence[] = [];
    for (let i = 0; i < 12; i++) {
      modEvidence.push(makeEvidence(`ev_mod_${i}`, 'calendar', 'decline'));
    }
    repo._setEvidence(modEvidence);
    repo._setPreferences([]);
    const modProposals = await archaeologist.analyze('user_1');
    expect(modProposals.length).toBe(1);
    expect(modProposals[0]!.confidence).toBe(ConfidenceLevel.MODERATE);

    // 25 items -> HIGH
    const highEvidence: TwinEvidence[] = [];
    for (let i = 0; i < 25; i++) {
      highEvidence.push(makeEvidence(`ev_high_${i}`, 'shopping', 'reorder'));
    }
    repo._setEvidence(highEvidence);
    const highProposals = await archaeologist.analyze('user_1');
    expect(highProposals.length).toBe(1);
    expect(highProposals[0]!.confidence).toBe(ConfidenceLevel.HIGH);
  });
});
