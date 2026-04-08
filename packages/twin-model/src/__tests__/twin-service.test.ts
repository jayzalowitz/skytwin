import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TwinService } from '../twin-service.js';
import type { TwinProfile, Preference, TwinEvidence } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

// ── Mock TwinRepository ──────────────────────────────────────────

function createMockRepository() {
  let storedProfile: TwinProfile | null = null;
  const evidenceStore: TwinEvidence[] = [];
  const feedbackStore: unknown[] = [];

  return {
    getProfile: vi.fn(async (_userId: string) => storedProfile),

    createProfile: vi.fn(async (profile: TwinProfile) => {
      storedProfile = { ...profile };
      return storedProfile;
    }),

    updateProfile: vi.fn(async (profile: TwinProfile) => {
      storedProfile = { ...profile };
      return storedProfile;
    }),

    upsertPreference: vi.fn(async () => {}),
    upsertInference: vi.fn(async () => {}),

    addEvidence: vi.fn(async (evidence: TwinEvidence) => {
      evidenceStore.push(evidence);
    }),

    addFeedback: vi.fn(async (feedback: unknown) => {
      feedbackStore.push(feedback);
    }),

    getPreferencesByDomain: vi.fn(async (_userId: string, _domain: string) => {
      if (!storedProfile) return [];
      return storedProfile.preferences.filter((p) => p.domain === _domain);
    }),

    getInferences: vi.fn(async (_userId: string) => {
      if (!storedProfile) return [];
      return storedProfile.inferences;
    }),

    // Allow tests to set the stored profile directly
    _setProfile: (profile: TwinProfile | null) => {
      storedProfile = profile;
    },
    _getEvidenceStore: () => evidenceStore,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('TwinService', () => {
  let repo: ReturnType<typeof createMockRepository>;
  let service: TwinService;

  beforeEach(() => {
    repo = createMockRepository();
    service = new TwinService(repo as never);
  });

  describe('Profile creation', () => {
    it('should create a default profile when none exists', async () => {
      const profile = await service.getOrCreateProfile('user_new');

      expect(profile).toBeDefined();
      expect(profile.userId).toBe('user_new');
      expect(profile.version).toBe(1);
      expect(profile.preferences).toEqual([]);
      expect(profile.inferences).toEqual([]);
      expect(repo.createProfile).toHaveBeenCalledOnce();
    });

    it('should return existing profile when one exists', async () => {
      const existingProfile: TwinProfile = {
        id: 'twin_existing',
        userId: 'user_existing',
        version: 5,
        preferences: [
          {
            id: 'pref_1',
            domain: 'email',
            key: 'auto_archive',
            value: true,
            confidence: ConfidenceLevel.HIGH,
            source: 'explicit',
            evidenceIds: ['ev_1'],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      repo._setProfile(existingProfile);

      const profile = await service.getOrCreateProfile('user_existing');

      expect(profile.id).toBe('twin_existing');
      expect(profile.version).toBe(5);
      expect(profile.preferences.length).toBe(1);
      expect(repo.createProfile).not.toHaveBeenCalled();
    });
  });

  describe('Preference updates', () => {
    it('should add a new preference and increment version', async () => {
      // Start with an empty profile
      const initialProfile: TwinProfile = {
        id: 'twin_1',
        userId: 'user_1',
        version: 1,
        preferences: [],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      repo._setProfile(initialProfile);

      const newPref: Preference = {
        id: 'pref_new',
        domain: 'email',
        key: 'auto_archive',
        value: true,
        confidence: ConfidenceLevel.MODERATE,
        source: 'explicit',
        evidenceIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedProfile = await service.updatePreference('user_1', newPref);

      expect(updatedProfile.version).toBe(2);
      expect(updatedProfile.preferences.length).toBe(1);
      expect(updatedProfile.preferences[0]?.key).toBe('auto_archive');
      expect(repo.upsertPreference).toHaveBeenCalled();
      expect(repo.updateProfile).toHaveBeenCalled();
    });

    it('should update an existing preference with the same domain+key', async () => {
      const existingPref: Preference = {
        id: 'pref_existing',
        domain: 'email',
        key: 'auto_archive',
        value: false,
        confidence: ConfidenceLevel.LOW,
        source: 'inferred',
        evidenceIds: ['ev_1'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      repo._setProfile({
        id: 'twin_1',
        userId: 'user_1',
        version: 3,
        preferences: [existingPref],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updatedPref: Preference = {
        id: 'pref_updated',
        domain: 'email',
        key: 'auto_archive',
        value: true,
        confidence: ConfidenceLevel.CONFIRMED,
        source: 'explicit',
        evidenceIds: ['ev_1', 'ev_2'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedProfile = await service.updatePreference('user_1', updatedPref);

      // Version should increment
      expect(updatedProfile.version).toBe(4);
      // Should still have exactly one preference (updated, not duplicated)
      expect(updatedProfile.preferences.length).toBe(1);
      // Should preserve the original id
      expect(updatedProfile.preferences[0]?.id).toBe('pref_existing');
      // Evidence should be merged
      expect(updatedProfile.preferences[0]?.evidenceIds).toContain('ev_1');
      expect(updatedProfile.preferences[0]?.evidenceIds).toContain('ev_2');
    });
  });

  describe('Evidence processing', () => {
    it('should persist evidence when added', async () => {
      repo._setProfile({
        id: 'twin_1',
        userId: 'user_1',
        version: 1,
        preferences: [],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evidence: TwinEvidence = {
        id: 'ev_test_1',
        userId: 'user_1',
        source: 'email_triage',
        type: 'auto_archive',
        data: { action: 'archive', from: 'newsletter@example.com' },
        domain: 'email',
        timestamp: new Date(),
      };

      await service.addEvidence('user_1', evidence);

      expect(repo.addEvidence).toHaveBeenCalledWith(evidence);
    });

    it('should update inferences after processing evidence', async () => {
      repo._setProfile({
        id: 'twin_1',
        userId: 'user_1',
        version: 1,
        preferences: [],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evidence: TwinEvidence = {
        id: 'ev_test_2',
        userId: 'user_1',
        source: 'email_triage',
        type: 'user_action',
        data: { action: 'archive', preference_key: 'auto_archive', preference_value: true },
        domain: 'email',
        timestamp: new Date(),
      };

      const result = await service.addEvidence('user_1', evidence);

      // Should have called updateProfile with updated inferences
      expect(repo.updateProfile).toHaveBeenCalled();
      expect(result.version).toBeGreaterThan(1);
    });
  });

  describe('Confidence calculation', () => {
    it('should return the configured confidence for a known preference', async () => {
      repo._setProfile({
        id: 'twin_1',
        userId: 'user_1',
        version: 1,
        preferences: [
          {
            id: 'pref_1',
            domain: 'email',
            key: 'auto_archive',
            value: true,
            confidence: ConfidenceLevel.HIGH,
            source: 'explicit',
            evidenceIds: ['ev_1'],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const confidence = await service.getConfidenceFor('user_1', 'email', 'auto_archive');
      expect(confidence).toBe(ConfidenceLevel.HIGH);
    });

    it('should return speculative for unknown preferences', async () => {
      repo._setProfile({
        id: 'twin_1',
        userId: 'user_1',
        version: 1,
        preferences: [],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const confidence = await service.getConfidenceFor('user_1', 'email', 'unknown_key');
      expect(confidence).toBe(ConfidenceLevel.SPECULATIVE);
    });

    it('should fall back to inference confidence when no preference exists', async () => {
      repo._setProfile({
        id: 'twin_1',
        userId: 'user_1',
        version: 1,
        preferences: [],
        inferences: [
          {
            id: 'inf_1',
            domain: 'email',
            key: 'reply_style',
            value: 'brief',
            confidence: ConfidenceLevel.MODERATE,
            supportingEvidenceIds: ['ev_1', 'ev_2'],
            contradictingEvidenceIds: [],
            reasoning: 'Inferred from 2 evidence items',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const confidence = await service.getConfidenceFor('user_1', 'email', 'reply_style');
      expect(confidence).toBe(ConfidenceLevel.MODERATE);
    });
  });

  describe('Insight correction and removal', () => {
    it('updateProfileInferences removes an inference and increments version', async () => {
      const inf1 = {
        id: 'inf_1', domain: 'email', key: 'reply_style', value: 'brief',
        confidence: ConfidenceLevel.MODERATE, supportingEvidenceIds: [], contradictingEvidenceIds: [],
        reasoning: '', createdAt: new Date(), updatedAt: new Date(),
      };
      const inf2 = {
        id: 'inf_2', domain: 'calendar', key: 'morning_free', value: true,
        confidence: ConfidenceLevel.LOW, supportingEvidenceIds: [], contradictingEvidenceIds: [],
        reasoning: '', createdAt: new Date(), updatedAt: new Date(),
      };
      repo._setProfile({
        id: 'twin_1', userId: 'user_1', version: 5,
        preferences: [], inferences: [inf1, inf2],
        createdAt: new Date(), updatedAt: new Date(),
      });

      const result = await service.updateProfileInferences('user_1', [inf2]);

      expect(result.version).toBe(6);
      expect(result.inferences).toHaveLength(1);
      expect(result.inferences[0]?.key).toBe('morning_free');
    });

    it('replaceProfileInsights replaces both preferences and inferences', async () => {
      const pref = {
        id: 'pref_1', domain: 'email', key: 'auto_archive', value: true,
        confidence: ConfidenceLevel.HIGH, source: 'explicit' as const,
        evidenceIds: [], createdAt: new Date(), updatedAt: new Date(),
      };
      const inf = {
        id: 'inf_1', domain: 'email', key: 'reply_style', value: 'brief',
        confidence: ConfidenceLevel.MODERATE, supportingEvidenceIds: [], contradictingEvidenceIds: [],
        reasoning: '', createdAt: new Date(), updatedAt: new Date(),
      };
      repo._setProfile({
        id: 'twin_1', userId: 'user_1', version: 3,
        preferences: [pref], inferences: [inf],
        createdAt: new Date(), updatedAt: new Date(),
      });

      const result = await service.replaceProfileInsights('user_1', [], []);

      expect(result.version).toBe(4);
      expect(result.preferences).toHaveLength(0);
      expect(result.inferences).toHaveLength(0);
    });
  });

  describe('Relevant preferences', () => {
    it('should return preferences matching the domain', async () => {
      repo._setProfile({
        id: 'twin_1',
        userId: 'user_1',
        version: 1,
        preferences: [
          {
            id: 'pref_email_1',
            domain: 'email',
            key: 'auto_archive',
            value: true,
            confidence: ConfidenceLevel.HIGH,
            source: 'explicit',
            evidenceIds: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: 'pref_calendar_1',
            domain: 'calendar',
            key: 'auto_accept',
            value: false,
            confidence: ConfidenceLevel.MODERATE,
            source: 'inferred',
            evidenceIds: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const prefs = await service.getRelevantPreferences(
        'user_1',
        'email',
        'Newsletter from tech digest',
      );

      // Should include email preferences
      const emailPrefs = prefs.filter((p) => p.domain === 'email');
      expect(emailPrefs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
