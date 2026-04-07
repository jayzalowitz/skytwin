import type {
  DecisionContext,
  DecisionObject,
  EpisodicMemory,
  WakeUpContext,
} from '@skytwin/shared-types';
import type { MemoryStack } from './memory-stack.js';
import type { EpisodeStore } from './episode-store.js';

/**
 * The MemoryRetriever enriches DecisionContext with relevant memories
 * from the Memory Palace. It is the primary integration point between
 * the mempalace system and the decision pipeline.
 */
export class MemoryRetriever {
  constructor(
    private readonly memoryStack: MemoryStack,
    private readonly episodeStore: EpisodeStore,
  ) {}

  /**
   * Enrich a DecisionContext with relevant episodic memories and
   * wake-up context from the memory palace.
   */
  async enrichContext(context: DecisionContext): Promise<DecisionContext> {
    // Always load wake-up context (L0 + L1)
    const wakeUpContext = await this.memoryStack.wakeUp(context.userId);

    // Find similar past episodes (L2/L3)
    const keywords = this.extractKeywords(context.decision);
    const episodes = await this.episodeStore.findSimilar(
      context.userId,
      context.decision.domain,
      context.decision.situationType,
      keywords,
      5,
    );

    return {
      ...context,
      episodicMemories: episodes,
      wakeUpContext,
    };
  }

  /**
   * Get just the wake-up context for a user (useful for proactive scans).
   */
  async getWakeUpContext(userId: string): Promise<WakeUpContext> {
    return this.memoryStack.wakeUp(userId);
  }

  /**
   * Find episodic memories relevant to a specific decision.
   */
  async findRelevantEpisodes(
    userId: string,
    decision: DecisionObject,
    limit: number = 5,
  ): Promise<EpisodicMemory[]> {
    const keywords = this.extractKeywords(decision);
    return this.episodeStore.findSimilar(
      userId,
      decision.domain,
      decision.situationType,
      keywords,
      limit,
    );
  }

  /**
   * Do a deep search across the entire memory palace.
   */
  async deepSearch(userId: string, query: string) {
    const terms = query.split(/\s+/).filter((t) => t.length > 2);
    return this.memoryStack.search(userId, terms);
  }

  /**
   * Score how relevant a set of episodes is to a current decision.
   */
  scoreEpisodeRelevance(
    episodes: EpisodicMemory[],
    decision: DecisionObject,
  ): Array<{ episode: EpisodicMemory; score: number }> {
    return episodes.map((episode) => ({
      episode,
      score: this.calculateRelevance(episode, decision),
    })).sort((a, b) => b.score - a.score);
  }

  // ── Private helpers ──────────────────────────────────────────────

  private extractKeywords(decision: DecisionObject): string[] {
    const words = new Set<string>();

    // From summary
    for (const word of decision.summary.split(/\s+/)) {
      if (word.length > 3) {
        words.add(word.toLowerCase().replace(/[^a-z0-9]/g, ''));
      }
    }

    // From domain
    words.add(decision.domain);

    // From raw data
    const data = decision.rawData;
    if (typeof data['from'] === 'string') words.add(data['from']);
    if (typeof data['subject'] === 'string') {
      for (const w of (data['subject'] as string).split(/\s+/)) {
        if (w.length > 3) words.add(w.toLowerCase());
      }
    }

    return [...words].slice(0, 10);
  }

  private calculateRelevance(
    episode: EpisodicMemory,
    decision: DecisionObject,
  ): number {
    let score = 0;

    // Same domain is a strong signal
    if (episode.domain === decision.domain) score += 0.3;

    // Same situation type is very strong
    if (episode.situationType === decision.situationType) score += 0.3;

    // Utility score indicates past usefulness
    score += episode.utilityScore * 0.2;

    // Recency bonus (episodes from last 7 days get a boost)
    const daysSince = (Date.now() - episode.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) score += 0.1;
    if (daysSince < 1) score += 0.1;

    return Math.min(score, 1.0);
  }
}
