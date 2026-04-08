import type {
  TwinProfile,
  Preference,
  TwinEvidence,
  Inference,
  FeedbackEvent,
  BehavioralPattern,
  CrossDomainTrait,
  TemporalProfile,
  TwinExport,
} from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';
import { InferenceEngine } from './inference-engine.js';
import { PreferenceEvolutionTracker, type PreferenceHistoryRepositoryPort } from './preference-evolution.js';

/**
 * Port interface for twin profile persistence.
 *
 * Business logic depends on this interface, not on a concrete database
 * implementation. Adapters (e.g., wrapping @skytwin/db's concrete
 * twinRepository) satisfy this contract at composition time.
 */
export interface TwinRepositoryPort {
  getProfile(userId: string): Promise<TwinProfile | null>;
  createProfile(profile: TwinProfile): Promise<TwinProfile>;
  updateProfile(profile: TwinProfile): Promise<TwinProfile>;

  getPreferences(userId: string): Promise<Preference[]>;
  getPreferencesByDomain(userId: string, domain: string): Promise<Preference[]>;
  upsertPreference(userId: string, preference: Preference): Promise<Preference>;

  getInferences(userId: string): Promise<Inference[]>;
  upsertInference(userId: string, inference: Inference): Promise<Inference>;

  addEvidence(evidence: TwinEvidence): Promise<TwinEvidence>;
  getEvidence(userId: string, limit?: number): Promise<TwinEvidence[]>;
  getEvidenceByIds(ids: string[]): Promise<TwinEvidence[]>;

  addFeedback(feedback: FeedbackEvent): Promise<FeedbackEvent>;
  getFeedback(userId: string, limit?: number): Promise<FeedbackEvent[]>;
}

/**
 * Port interface for behavioral pattern and cross-domain trait persistence.
 */
export interface PatternRepositoryPort {
  getPatterns(userId: string): Promise<BehavioralPattern[]>;
  upsertPattern(userId: string, pattern: BehavioralPattern): Promise<BehavioralPattern>;
  getTraits(userId: string): Promise<CrossDomainTrait[]>;
  upsertTrait(userId: string, trait: CrossDomainTrait): Promise<CrossDomainTrait>;
}

/**
 * TwinService is the primary interface for managing a user's digital twin.
 * It orchestrates profile CRUD, preference management, evidence collection,
 * and inference updates.
 */
export class TwinService {
  private readonly inferenceEngine: InferenceEngine;
  private readonly patternRepository: PatternRepositoryPort | null;
  readonly evolutionTracker: PreferenceEvolutionTracker;
  private readonly temporalProfiles = new Map<string, TemporalProfile>();

  constructor(
    private readonly repository: TwinRepositoryPort,
    patternRepository?: PatternRepositoryPort,
    preferenceHistoryRepository?: PreferenceHistoryRepositoryPort,
  ) {
    this.inferenceEngine = new InferenceEngine();
    this.patternRepository = patternRepository ?? null;
    this.evolutionTracker = new PreferenceEvolutionTracker(preferenceHistoryRepository ?? null);
  }

  /**
   * Get an existing twin profile or create a default one for the user.
   */
  async getOrCreateProfile(userId: string): Promise<TwinProfile> {
    const existing = await this.repository.getProfile(userId);
    if (existing) {
      return existing;
    }

    const defaultProfile: TwinProfile = {
      id: crypto.randomUUID(),
      userId,
      version: 1,
      preferences: [],
      inferences: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return this.repository.createProfile(defaultProfile);
  }

  /**
   * Update a single preference for a user. If a preference with the same
   * domain+key exists, it is updated (creating a new version). Otherwise
   * a new preference is created.
   */
  async updatePreference(
    userId: string,
    preference: Preference,
  ): Promise<TwinProfile> {
    const profile = await this.getOrCreateProfile(userId);

    // Find existing preference with same domain+key
    const existingIdx = profile.preferences.findIndex(
      (p) => p.domain === preference.domain && p.key === preference.key,
    );

    const updatedPreferences = [...profile.preferences];
    const now = new Date();

    if (existingIdx >= 0) {
      // Update existing preference, preserving history via evidence IDs
      const existing = updatedPreferences[existingIdx]!;
      updatedPreferences[existingIdx] = {
        ...preference,
        id: existing.id,
        evidenceIds: [...new Set([...existing.evidenceIds, ...preference.evidenceIds])],
        updatedAt: now,
      };
    } else {
      // Add new preference
      updatedPreferences.push({
        ...preference,
        id: preference.id || `pref_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Also persist via the repository
    await this.repository.upsertPreference(userId, preference);

    // Track preference evolution
    const previousPref = existingIdx >= 0 ? profile.preferences[existingIdx]! : null;
    await this.evolutionTracker.recordChange(userId, previousPref, preference, 'explicit');

    const updatedProfile: TwinProfile = {
      ...profile,
      preferences: updatedPreferences,
      version: profile.version + 1,
      updatedAt: now,
    };

    return this.repository.updateProfile(updatedProfile);
  }

  /**
   * Replace the inferences array on a user's profile (e.g. to remove a
   * dismissed inference while leaving preferences intact).
   */
  async updateProfileInferences(
    userId: string,
    inferences: Inference[],
  ): Promise<TwinProfile> {
    const profile = await this.getOrCreateProfile(userId);
    const updatedProfile: TwinProfile = {
      ...profile,
      inferences,
      version: profile.version + 1,
      updatedAt: new Date(),
    };
    return this.repository.updateProfile(updatedProfile);
  }

  /**
   * Replace both preferences and inferences on a user's profile
   * (used for removing/dismissing insights from the twin page).
   */
  async replaceProfileInsights(
    userId: string,
    preferences: Preference[],
    inferences: Inference[],
  ): Promise<TwinProfile> {
    const profile = await this.getOrCreateProfile(userId);
    const updatedProfile: TwinProfile = {
      ...profile,
      preferences,
      inferences,
      version: profile.version + 1,
      updatedAt: new Date(),
    };
    return this.repository.updateProfile(updatedProfile);
  }

  /**
   * Add evidence to the twin and potentially update inferences.
   * When a pattern repository is available, also runs pattern detection
   * and cross-domain trait analysis.
   */
  async addEvidence(
    userId: string,
    evidence: TwinEvidence,
  ): Promise<TwinProfile> {
    // Persist the evidence
    await this.repository.addEvidence(evidence);

    const profile = await this.getOrCreateProfile(userId);

    if (this.patternRepository) {
      // Run full analysis pipeline
      const existingPatterns = await this.patternRepository.getPatterns(userId);
      const allEvidence = await this.repository.getEvidence(userId, 100);
      const result = this.inferenceEngine.analyzeWithPatterns(
        profile.inferences,
        allEvidence,
        existingPatterns,
      );

      // Persist patterns and traits
      for (const pattern of result.patterns) {
        await this.patternRepository.upsertPattern(userId, pattern);
      }
      for (const trait of result.traits) {
        await this.patternRepository.upsertTrait(userId, trait);
      }

      // Cache temporal profile
      this.temporalProfiles.set(userId, result.temporalProfile);

      // Persist updated inferences
      for (const inference of result.inferences) {
        await this.repository.upsertInference(userId, inference);
      }

      const updatedProfile: TwinProfile = {
        ...profile,
        inferences: result.inferences,
        version: profile.version + 1,
        updatedAt: new Date(),
      };

      return this.repository.updateProfile(updatedProfile);
    }

    // Fallback: basic inference only
    const updatedInferences = this.inferenceEngine.analyzeEvidence(
      profile.inferences,
      [evidence],
    );

    for (const inference of updatedInferences) {
      await this.repository.upsertInference(userId, inference);
    }

    const updatedProfile: TwinProfile = {
      ...profile,
      inferences: updatedInferences,
      version: profile.version + 1,
      updatedAt: new Date(),
    };

    return this.repository.updateProfile(updatedProfile);
  }

  /**
   * Given a batch of new signals (evidence), update the twin's inferences.
   */
  async inferPreferences(
    userId: string,
    signals: TwinEvidence[],
  ): Promise<TwinProfile> {
    const profile = await this.getOrCreateProfile(userId);

    // Persist all evidence
    for (const signal of signals) {
      await this.repository.addEvidence(signal);
    }

    // Run inference engine across all new signals
    const updatedInferences = this.inferenceEngine.analyzeEvidence(
      profile.inferences,
      signals,
    );

    // Convert strong inferences into preferences
    const newPreferences = this.promoteInferences(
      profile.preferences,
      updatedInferences,
    );

    // Persist
    for (const inference of updatedInferences) {
      await this.repository.upsertInference(userId, inference);
    }
    for (const pref of newPreferences) {
      await this.repository.upsertPreference(userId, pref);
    }

    const updatedProfile: TwinProfile = {
      ...profile,
      inferences: updatedInferences,
      preferences: newPreferences,
      version: profile.version + 1,
      updatedAt: new Date(),
    };

    return this.repository.updateProfile(updatedProfile);
  }

  /**
   * Query the twin for preferences relevant to a specific decision domain
   * and situation.
   */
  async getRelevantPreferences(
    userId: string,
    domain: string,
    situation: string,
  ): Promise<Preference[]> {
    const domainPreferences = await this.repository.getPreferencesByDomain(userId, domain);

    // Also include "general" preferences that apply across domains
    const generalPreferences = await this.repository.getPreferencesByDomain(userId, 'general');

    const allRelevant = [...domainPreferences, ...generalPreferences];

    // Filter by situation relevance using keyword matching
    const situationKeywords = situation.toLowerCase().split(/\s+/);

    return allRelevant.filter((pref) => {
      // Always include domain-specific preferences
      if (pref.domain === domain) return true;

      // For general preferences, check if they're relevant to the situation
      const prefKeywords = [
        pref.key.toLowerCase(),
        String(pref.value).toLowerCase(),
      ].join(' ');

      return situationKeywords.some((keyword) => prefKeywords.includes(keyword));
    });
  }

  /**
   * Get the confidence level for a specific preference key in a domain.
   */
  async getConfidenceFor(
    userId: string,
    domain: string,
    key: string,
  ): Promise<ConfidenceLevel> {
    const preferences = await this.repository.getPreferencesByDomain(userId, domain);
    const matching = preferences.find((p) => p.key === key);

    if (matching) {
      return matching.confidence;
    }

    // Check inferences
    const inferences = await this.repository.getInferences(userId);
    const matchingInference = inferences.find(
      (inf) => inf.domain === domain && inf.key === key,
    );

    if (matchingInference) {
      return matchingInference.confidence;
    }

    return ConfidenceLevel.SPECULATIVE;
  }

  /**
   * Process feedback and update the twin's inferences accordingly.
   *
   * Undo feedback receives special treatment: the correction is applied
   * twice (2x weight) so the model learns more aggressively from undone
   * actions.  For "severe" undo reasoning the confidence of every
   * affected inference is additionally reduced by one level.
   */
  async processFeedback(
    userId: string,
    feedback: FeedbackEvent,
  ): Promise<TwinProfile> {
    await this.repository.addFeedback(feedback);

    const profile = await this.getOrCreateProfile(userId);
    let updatedInferences = this.inferenceEngine.updateInferencesFromFeedback(
      profile,
      feedback,
    );

    // Undo feedback gets 2x weight — apply correction twice
    if (feedback.feedbackType === 'undo' && feedback.undoReasoning) {
      updatedInferences = this.inferenceEngine.updateInferencesFromFeedback(
        { ...profile, inferences: updatedInferences },
        feedback,
      );

      // Severe undo reasoning triggers an extra confidence reduction
      if (feedback.undoReasoning.severity === 'severe') {
        for (const inference of updatedInferences) {
          if (inference.supportingEvidenceIds.length > 0) {
            inference.confidence = this.decreaseConfidence(inference.confidence);
            inference.updatedAt = new Date();
          }
        }
      }
    }

    for (const inference of updatedInferences) {
      await this.repository.upsertInference(userId, inference);
    }

    // Track inference changes as preference evolution (feedback attribution)
    for (const updated of updatedInferences) {
      const original = profile.inferences.find(
        (inf) => inf.domain === updated.domain && inf.key === updated.key,
      );
      if (
        original &&
        (original.confidence !== updated.confidence ||
          JSON.stringify(original.value) !== JSON.stringify(updated.value))
      ) {
        await this.evolutionTracker.recordChange(
          userId,
          {
            id: original.id,
            domain: original.domain,
            key: original.key,
            value: original.value,
            confidence: original.confidence,
            source: 'inferred',
            evidenceIds: original.supportingEvidenceIds,
            createdAt: original.createdAt,
            updatedAt: original.updatedAt,
          },
          {
            id: updated.id,
            domain: updated.domain,
            key: updated.key,
            value: updated.value,
            confidence: updated.confidence,
            source: 'inferred',
            evidenceIds: updated.supportingEvidenceIds,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
          },
          'feedback',
          feedback.id,
        );
      }
    }

    const updatedProfile: TwinProfile = {
      ...profile,
      inferences: updatedInferences,
      version: profile.version + 1,
      updatedAt: new Date(),
    };

    return this.repository.updateProfile(updatedProfile);
  }

  /**
   * Get detected behavioral patterns for a user.
   */
  async getPatterns(userId: string): Promise<BehavioralPattern[]> {
    if (!this.patternRepository) return [];
    return this.patternRepository.getPatterns(userId);
  }

  /**
   * Get detected cross-domain traits for a user.
   */
  async getTraits(userId: string): Promise<CrossDomainTrait[]> {
    if (!this.patternRepository) return [];
    return this.patternRepository.getTraits(userId);
  }

  /**
   * Get the temporal profile for a user (cached from last evidence analysis).
   */
  async getTemporalProfile(userId: string): Promise<TemporalProfile> {
    const cached = this.temporalProfiles.get(userId);
    if (cached) return cached;

    // Build from evidence if not cached
    const evidence = await this.repository.getEvidence(userId, 100);
    if (evidence.length === 0) {
      return {
        userId,
        activeHours: { start: 8, end: 22 },
        peakResponseTimes: {},
        weekdayPatterns: {},
        urgencyThresholds: {},
      };
    }

    // Import dynamically to avoid circular deps at construction
    const { TemporalAnalyzer } = await import('./analyzers/temporal-analyzer.js');
    const analyzer = new TemporalAnalyzer();
    const profile = analyzer.analyzeTemporalPatterns(evidence);
    this.temporalProfiles.set(userId, profile);
    return profile;
  }

  // ── Export / Portability ────────────────────────────────────────

  /**
   * Export a complete, portable snapshot of the user's digital twin.
   */
  async exportTwin(userId: string, format: 'json' | 'markdown'): Promise<TwinExport> {
    const profile = await this.getOrCreateProfile(userId);
    const patterns = await this.getPatterns(userId);
    const traits = await this.getTraits(userId);
    const temporalProfile = await this.getTemporalProfile(userId);

    return {
      userId,
      exportedAt: new Date(),
      format,
      profile,
      patterns,
      traits,
      temporalProfile,
    };
  }

  /**
   * Convert a TwinExport to a human-readable markdown document.
   */
  formatAsMarkdown(exportData: TwinExport): string {
    const lines: string[] = [];

    lines.push(`# Twin Export for ${exportData.userId}`);
    lines.push('');

    // Profile section
    lines.push('## Profile');
    lines.push('');
    lines.push(`- **Version:** ${exportData.profile.version}`);
    lines.push(`- **Created:** ${exportData.profile.createdAt.toISOString()}`);
    lines.push(`- **Updated:** ${exportData.profile.updatedAt.toISOString()}`);
    lines.push('');

    // Preferences section
    lines.push('## Preferences');
    lines.push('');
    if (exportData.profile.preferences.length === 0) {
      lines.push('_No preferences recorded._');
    } else {
      lines.push('| Domain | Key | Value | Confidence | Source |');
      lines.push('|--------|-----|-------|------------|--------|');
      for (const pref of exportData.profile.preferences) {
        lines.push(
          `| ${pref.domain} | ${pref.key} | ${String(pref.value)} | ${pref.confidence} | ${pref.source} |`,
        );
      }
    }
    lines.push('');

    // Inferences section
    lines.push('## Inferences');
    lines.push('');
    if (exportData.profile.inferences.length === 0) {
      lines.push('_No inferences recorded._');
    } else {
      lines.push('| Domain | Key | Value | Confidence |');
      lines.push('|--------|-----|-------|------------|');
      for (const inf of exportData.profile.inferences) {
        lines.push(
          `| ${inf.domain} | ${inf.key} | ${String(inf.value)} | ${inf.confidence} |`,
        );
      }
    }
    lines.push('');

    // Behavioral Patterns section
    lines.push('## Behavioral Patterns');
    lines.push('');
    if (exportData.patterns.length === 0) {
      lines.push('_No behavioral patterns detected._');
    } else {
      for (const pattern of exportData.patterns) {
        lines.push(`- **${pattern.description}**`);
        lines.push(`  - Trigger: ${JSON.stringify(pattern.trigger.conditions)}`);
        lines.push(`  - Frequency: ${pattern.frequency}`);
        lines.push('');
      }
    }

    // Cross-Domain Traits section
    lines.push('## Cross-Domain Traits');
    lines.push('');
    if (exportData.traits.length === 0) {
      lines.push('_No cross-domain traits detected._');
    } else {
      for (const trait of exportData.traits) {
        lines.push(`- **${trait.traitName}** (confidence: ${trait.confidence})`);
        lines.push(`  - Domains: ${trait.supportingDomains.join(', ')}`);
        lines.push('');
      }
    }

    // Temporal Profile section
    lines.push('## Temporal Profile');
    lines.push('');
    lines.push(`- **Active Hours:** ${exportData.temporalProfile.activeHours.start}:00 – ${exportData.temporalProfile.activeHours.end}:00`);

    const peakTimes = Object.entries(exportData.temporalProfile.peakResponseTimes);
    if (peakTimes.length > 0) {
      lines.push('- **Peak Response Times:**');
      for (const [key, value] of peakTimes) {
        lines.push(`  - ${key}: ${value}`);
      }
    }

    return lines.join('\n');
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Promote high-confidence inferences into explicit preferences.
   */
  private promoteInferences(
    existingPreferences: Preference[],
    inferences: Inference[],
  ): Preference[] {
    const preferences = [...existingPreferences];

    for (const inference of inferences) {
      // Only promote inferences with at least high confidence
      if (
        inference.confidence !== ConfidenceLevel.HIGH &&
        inference.confidence !== ConfidenceLevel.CONFIRMED
      ) {
        continue;
      }

      // Check if preference already exists
      const existingIdx = preferences.findIndex(
        (p) => p.domain === inference.domain && p.key === inference.key,
      );

      const promoted: Preference = {
        id: `pref_promoted_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        domain: inference.domain,
        key: inference.key,
        value: inference.value,
        confidence: inference.confidence,
        source: 'inferred',
        evidenceIds: inference.supportingEvidenceIds,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      if (existingIdx >= 0) {
        const existing = preferences[existingIdx]!;
        // Only overwrite if inference is more confident
        if (this.confidenceRank(inference.confidence) > this.confidenceRank(existing.confidence)) {
          preferences[existingIdx] = { ...promoted, id: existing.id };
        }
      } else {
        preferences.push(promoted);
      }
    }

    return preferences;
  }

  private confidenceRank(level: ConfidenceLevel): number {
    const ranks: Record<ConfidenceLevel, number> = {
      [ConfidenceLevel.SPECULATIVE]: 0,
      [ConfidenceLevel.LOW]: 1,
      [ConfidenceLevel.MODERATE]: 2,
      [ConfidenceLevel.HIGH]: 3,
      [ConfidenceLevel.CONFIRMED]: 4,
    };
    return ranks[level];
  }

  private decreaseConfidence(current: ConfidenceLevel): ConfidenceLevel {
    const levels = [
      ConfidenceLevel.SPECULATIVE,
      ConfidenceLevel.LOW,
      ConfidenceLevel.MODERATE,
      ConfidenceLevel.HIGH,
      ConfidenceLevel.CONFIRMED,
    ];
    const idx = levels.indexOf(current);
    return levels[Math.max(idx - 1, 0)]!;
  }
}
