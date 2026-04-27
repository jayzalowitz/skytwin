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

  // ── Action key fallback chain ─────────────────────────────────────

  it('extracts action from data.preference_key when data.action is absent', async () => {
    const evidence: TwinEvidence[] = [];
    for (let i = 0; i < 6; i++) {
      evidence.push({
        id: `ev_${i}`,
        userId: 'user_1',
        source: 'test',
        type: 'observation',
        data: { preference_key: 'protect_morning_focus' },
        domain: 'calendar',
        timestamp: new Date(),
      });
    }
    repo._setEvidence(evidence);
    const proposals = await archaeologist.analyze('user_1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.key).toBe('protect_morning_focus');
  });

  it('extracts action from data.behavior when neither action nor preference_key present', async () => {
    const evidence: TwinEvidence[] = [];
    for (let i = 0; i < 6; i++) {
      evidence.push({
        id: `ev_${i}`,
        userId: 'user_1',
        source: 'test',
        type: 'observation',
        data: { behavior: 'late_replier' },
        domain: 'email',
        timestamp: new Date(),
      });
    }
    repo._setEvidence(evidence);
    const proposals = await archaeologist.analyze('user_1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.key).toBe('late_replier');
  });

  it('skips evidence items where no recognizable action key exists', async () => {
    const evidence: TwinEvidence[] = [];
    // 6 items but none have action/preference_key/behavior — should be skipped
    for (let i = 0; i < 6; i++) {
      evidence.push({
        id: `ev_${i}`,
        userId: 'user_1',
        source: 'test',
        type: 'observation',
        data: { unrelated: 'value' },
        domain: 'email',
        timestamp: new Date(),
      });
    }
    repo._setEvidence(evidence);
    const proposals = await archaeologist.analyze('user_1');
    expect(proposals).toEqual([]);
  });

  // ── Multiple groups in one analysis ───────────────────────────────

  it('produces a proposal per group when multiple distinct domain:action pairs each meet threshold', async () => {
    const evidence: TwinEvidence[] = [];
    for (let i = 0; i < 6; i++) {
      evidence.push(makeEvidence(`ev_email_${i}`, 'email', 'archive'));
      evidence.push(makeEvidence(`ev_cal_${i}`, 'calendar', 'decline'));
    }
    repo._setEvidence(evidence);
    const proposals = await archaeologist.analyze('user_1');
    expect(proposals).toHaveLength(2);
    const keys = proposals.map((p) => `${p.domain}:${p.key}`).sort();
    expect(keys).toEqual(['calendar:decline', 'email:archive']);
  });

  it('only emits groups that meet the threshold; sub-threshold groups are dropped', async () => {
    const evidence: TwinEvidence[] = [];
    // archive: 6 (above), label: 3 (below)
    for (let i = 0; i < 6; i++) evidence.push(makeEvidence(`ev_a_${i}`, 'email', 'archive'));
    for (let i = 0; i < 3; i++) evidence.push(makeEvidence(`ev_l_${i}`, 'email', 'label'));
    repo._setEvidence(evidence);
    const proposals = await archaeologist.analyze('user_1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.key).toBe('archive');
  });

  // ── supportingEvidence cap ───────────────────────────────────────

  it('caps supportingEvidence at 10 even when many items exist', async () => {
    const evidence: TwinEvidence[] = [];
    for (let i = 0; i < 25; i++) {
      evidence.push(makeEvidence(`ev_${i}`, 'email', 'archive'));
    }
    repo._setEvidence(evidence);
    const proposals = await archaeologist.analyze('user_1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.supportingEvidence).toHaveLength(10);
  });

  // ── Expiry window ─────────────────────────────────────────────────

  it('sets expiresAt approximately 30 days from detectedAt', async () => {
    const evidence: TwinEvidence[] = [];
    for (let i = 0; i < 6; i++) evidence.push(makeEvidence(`ev_${i}`, 'email', 'archive'));
    repo._setEvidence(evidence);
    const before = Date.now();
    const proposals = await archaeologist.analyze('user_1');
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    const actualMs = proposal.expiresAt.getTime() - before;
    // Allow some slack for the few ms between `before` capture and proposal creation
    expect(actualMs).toBeGreaterThan(expectedMs - 5_000);
    expect(actualMs).toBeLessThan(expectedMs + 5_000);
  });

  // ── Existing inferred preferences are NOT skipped (only explicit are) ─

  it('still proposes when matching key exists with source != explicit', async () => {
    const evidence: TwinEvidence[] = [];
    for (let i = 0; i < 6; i++) evidence.push(makeEvidence(`ev_${i}`, 'email', 'archive'));
    repo._setEvidence(evidence);
    repo._setPreferences([
      {
        id: 'pref_1',
        domain: 'email',
        key: 'archive',
        value: true,
        confidence: ConfidenceLevel.LOW,
        source: 'inferred',
        evidenceIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const proposals = await archaeologist.analyze('user_1');
    expect(proposals).toHaveLength(1);
  });
});
