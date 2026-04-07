import type {
  EpisodicMemory,
  EpisodeContext,
  EpisodeOutcome,
  DecisionOutcome,
  FeedbackEvent,
  Preference,
  BehavioralPattern,
} from '@skytwin/shared-types';

/**
 * Port interface for episodic memory persistence.
 */
export interface EpisodeRepositoryPort {
  createEpisode(input: {
    userId: string;
    situationSummary: string;
    domain: string;
    situationType: string;
    contextSnapshot: EpisodeContext;
    actionTaken?: string;
    outcome?: EpisodeOutcome;
    decisionId?: string;
    signalIds?: string[];
    drawerIds?: string[];
    utilityScore?: number;
  }): Promise<EpisodicMemory>;

  getEpisodes(userId: string, options?: {
    domain?: string;
    situationType?: string;
    limit?: number;
    minUtility?: number;
  }): Promise<EpisodicMemory[]>;

  getEpisodeByDecision(decisionId: string): Promise<EpisodicMemory | null>;

  updateEpisode(episodeId: string, updates: {
    outcome?: EpisodeOutcome;
    feedbackType?: string;
    feedbackDetail?: string;
    utilityScore?: number;
    actionTaken?: string;
    drawerIds?: string[];
  }): Promise<EpisodicMemory | null>;

  searchEpisodes(userId: string, terms: string[], limit?: number): Promise<EpisodicMemory[]>;
}

/**
 * The EpisodeStore creates and manages episodic memories.
 * It records decision episodes (situation → action → outcome → feedback)
 * and retrieves similar past episodes to enrich future decisions.
 */
export class EpisodeStore {
  constructor(private readonly repository: EpisodeRepositoryPort) {}

  /**
   * Record a new episode from a decision outcome.
   */
  async recordFromDecision(
    userId: string,
    domain: string,
    situationType: string,
    situationSummary: string,
    outcome: DecisionOutcome,
    activePreferences: Preference[],
    activePatterns: BehavioralPattern[],
  ): Promise<EpisodicMemory> {
    const now = new Date();
    const hour = now.getHours();
    const timeOfDay = hour < 6 ? 'night'
      : hour < 12 ? 'morning'
      : hour < 18 ? 'afternoon'
      : 'evening';

    const contextSnapshot: EpisodeContext = {
      timeOfDay,
      dayOfWeek: now.getDay(),
      urgency: undefined,
      activePreferences: activePreferences.slice(0, 5).map((p) => ({
        domain: p.domain,
        key: p.key,
        value: p.value,
      })),
      activePatterns: activePatterns.slice(0, 5).map((p) => p.description),
    };

    const episodeOutcome: EpisodeOutcome | undefined = outcome.selectedAction
      ? {
          success: outcome.autoExecute,
          description: outcome.reasoning,
          userIntervened: outcome.requiresApproval,
        }
      : undefined;

    return this.repository.createEpisode({
      userId,
      situationSummary,
      domain,
      situationType,
      contextSnapshot,
      actionTaken: outcome.selectedAction?.description,
      outcome: episodeOutcome,
      decisionId: outcome.decisionId,
      utilityScore: this.calculateInitialUtility(outcome),
    });
  }

  /**
   * Update an episode with feedback from the user.
   */
  async recordFeedback(
    feedback: FeedbackEvent,
  ): Promise<EpisodicMemory | null> {
    const episode = await this.repository.getEpisodeByDecision(feedback.decisionId);
    if (!episode) return null;

    const utilityDelta = this.feedbackToUtilityDelta(feedback);
    const newUtility = Math.max(0, Math.min(1, episode.utilityScore + utilityDelta));

    const outcome: EpisodeOutcome = {
      success: feedback.feedbackType === 'approve',
      description: feedback.reason ?? feedback.feedbackType,
      userIntervened: feedback.feedbackType !== 'approve',
      betterAlternative: feedback.correctedAction ?? undefined,
    };

    return this.repository.updateEpisode(episode.id, {
      feedbackType: feedback.feedbackType,
      feedbackDetail: feedback.reason,
      outcome,
      utilityScore: newUtility,
    });
  }

  /**
   * Find similar past episodes to a current situation.
   * Uses domain, situation type, and keyword matching.
   */
  async findSimilar(
    userId: string,
    domain: string,
    situationType: string,
    keywords: string[],
    limit: number = 5,
  ): Promise<EpisodicMemory[]> {
    // First try exact domain + situation type match
    const exact = await this.repository.getEpisodes(userId, {
      domain,
      situationType,
      limit,
      minUtility: 0.3,
    });

    if (exact.length >= limit) return exact.slice(0, limit);

    // Supplement with keyword search
    if (keywords.length > 0) {
      const keywordResults = await this.repository.searchEpisodes(userId, keywords, limit);
      // Merge and dedupe
      const seen = new Set(exact.map((e) => e.id));
      for (const episode of keywordResults) {
        if (!seen.has(episode.id) && exact.length < limit) {
          exact.push(episode);
          seen.add(episode.id);
        }
      }
    }

    return exact;
  }

  /**
   * Get the most useful episodes for a user (top utility scores).
   */
  async getTopEpisodes(userId: string, limit: number = 10): Promise<EpisodicMemory[]> {
    return this.repository.getEpisodes(userId, {
      limit,
      minUtility: 0.5,
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  private calculateInitialUtility(outcome: DecisionOutcome): number {
    let utility = 0.5;

    if (outcome.autoExecute) utility += 0.1;
    if (outcome.selectedAction) utility += 0.1;
    if (!outcome.requiresApproval) utility += 0.1;

    return Math.min(utility, 1.0);
  }

  private feedbackToUtilityDelta(feedback: FeedbackEvent): number {
    switch (feedback.feedbackType) {
      case 'approve': return 0.2;
      case 'correct': return -0.1;
      case 'reject': return -0.3;
      case 'undo': return -0.4;
      case 'ignore': return -0.05;
      default: return 0;
    }
  }
}
