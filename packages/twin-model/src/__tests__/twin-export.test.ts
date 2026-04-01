import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TwinService } from '../twin-service.js';
import type {
  TwinProfile,
  BehavioralPattern,
  CrossDomainTrait,
} from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

// ── Mock Repositories ────────────────────────────────────────────

function createMockRepository() {
  const profile: TwinProfile = {
    id: 'twin_export_test',
    userId: 'user_export',
    version: 3,
    preferences: [
      {
        id: 'pref_1',
        domain: 'email',
        key: 'auto_archive',
        value: true,
        confidence: ConfidenceLevel.HIGH,
        source: 'explicit',
        evidenceIds: ['ev_1'],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-03-15'),
      },
      {
        id: 'pref_2',
        domain: 'calendar',
        key: 'decline_weekends',
        value: true,
        confidence: ConfidenceLevel.MODERATE,
        source: 'inferred',
        evidenceIds: ['ev_2', 'ev_3'],
        createdAt: new Date('2026-02-01'),
        updatedAt: new Date('2026-03-20'),
      },
    ],
    inferences: [
      {
        id: 'inf_1',
        domain: 'email',
        key: 'reply_style',
        value: 'brief',
        confidence: ConfidenceLevel.MODERATE,
        supportingEvidenceIds: ['ev_4'],
        contradictingEvidenceIds: [],
        reasoning: 'Inferred from 3 evidence items.',
        createdAt: new Date('2026-02-15'),
        updatedAt: new Date('2026-03-10'),
      },
    ],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-03-20'),
  };

  return {
    getProfile: vi.fn(async () => profile),
    createProfile: vi.fn(async (p: TwinProfile) => p),
    updateProfile: vi.fn(async (p: TwinProfile) => p),
    getPreferences: vi.fn(async () => profile.preferences),
    getPreferencesByDomain: vi.fn(async () => []),
    upsertPreference: vi.fn(async () => ({})),
    getInferences: vi.fn(async () => profile.inferences),
    upsertInference: vi.fn(async () => ({})),
    addEvidence: vi.fn(async () => ({})),
    getEvidence: vi.fn(async () => []),
    getEvidenceByIds: vi.fn(async () => []),
    addFeedback: vi.fn(async () => ({})),
    getFeedback: vi.fn(async () => []),
  };
}

function createMockPatternRepository() {
  const patterns: BehavioralPattern[] = [
    {
      id: 'pat_1',
      userId: 'user_export',
      patternType: 'habit',
      description: 'Archives newsletters every morning',
      trigger: {
        domain: 'email',
        conditions: { sender: '*@newsletter.com' },
      },
      observedAction: 'archive',
      frequency: 15,
      confidence: ConfidenceLevel.HIGH,
      firstObservedAt: new Date('2026-01-10'),
      lastObservedAt: new Date('2026-03-18'),
      metadata: {},
    },
  ];

  const traits: CrossDomainTrait[] = [
    {
      id: 'trait_1',
      traitName: 'efficiency-oriented',
      confidence: ConfidenceLevel.MODERATE,
      supportingDomains: ['email', 'calendar'],
      evidenceCount: 12,
      description: 'Consistently prefers quick, automated actions.',
    },
  ];

  return {
    getPatterns: vi.fn(async () => patterns),
    upsertPattern: vi.fn(async () => ({})),
    getTraits: vi.fn(async () => traits),
    upsertTrait: vi.fn(async () => ({})),
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Twin Export', () => {
  let repo: ReturnType<typeof createMockRepository>;
  let patternRepo: ReturnType<typeof createMockPatternRepository>;
  let service: TwinService;

  beforeEach(() => {
    repo = createMockRepository();
    patternRepo = createMockPatternRepository();
    service = new TwinService(repo as never, patternRepo as never);
  });

  describe('exportTwin', () => {
    it('returns complete export data with all sections populated', async () => {
      const exportData = await service.exportTwin('user_export', 'json');

      expect(exportData.userId).toBe('user_export');
      expect(exportData.format).toBe('json');
      expect(exportData.exportedAt).toBeInstanceOf(Date);

      // Profile
      expect(exportData.profile.id).toBe('twin_export_test');
      expect(exportData.profile.version).toBe(3);
      expect(exportData.profile.preferences.length).toBe(2);
      expect(exportData.profile.inferences.length).toBe(1);

      // Patterns
      expect(exportData.patterns.length).toBe(1);
      expect(exportData.patterns[0]!.description).toBe('Archives newsletters every morning');

      // Traits
      expect(exportData.traits.length).toBe(1);
      expect(exportData.traits[0]!.traitName).toBe('efficiency-oriented');

      // Temporal profile
      expect(exportData.temporalProfile).toBeDefined();
      expect(exportData.temporalProfile.activeHours).toBeDefined();
    });
  });

  describe('formatAsMarkdown', () => {
    it('produces valid markdown with all expected sections', async () => {
      const exportData = await service.exportTwin('user_export', 'markdown');
      const markdown = service.formatAsMarkdown(exportData);

      // Main heading
      expect(markdown).toContain('# Twin Export for user_export');

      // Profile section
      expect(markdown).toContain('## Profile');
      expect(markdown).toContain('**Version:** 3');

      // Preferences table
      expect(markdown).toContain('## Preferences');
      expect(markdown).toContain('| Domain | Key | Value | Confidence | Source |');
      expect(markdown).toContain('| email | auto_archive | true | high | explicit |');
      expect(markdown).toContain('| calendar | decline_weekends | true | moderate | inferred |');

      // Inferences table
      expect(markdown).toContain('## Inferences');
      expect(markdown).toContain('| Domain | Key | Value | Confidence |');
      expect(markdown).toContain('| email | reply_style | brief | moderate |');

      // Behavioral patterns
      expect(markdown).toContain('## Behavioral Patterns');
      expect(markdown).toContain('Archives newsletters every morning');
      expect(markdown).toContain('Frequency: 15');

      // Cross-domain traits
      expect(markdown).toContain('## Cross-Domain Traits');
      expect(markdown).toContain('efficiency-oriented');
      expect(markdown).toContain('email, calendar');

      // Temporal profile
      expect(markdown).toContain('## Temporal Profile');
      expect(markdown).toContain('Active Hours');
    });
  });
});
