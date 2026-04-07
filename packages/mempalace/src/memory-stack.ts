import type {
  WakeUpContext,
  RecallResult,
  MemorySearchResult,
  MemoryCloset,
  KnowledgeTriple,
} from '@skytwin/shared-types';
import { MemoryLayer } from '@skytwin/shared-types';
import type { PalaceRepositoryPort } from './palace.js';
import type { EpisodeRepositoryPort } from './episode-store.js';

/**
 * Port for closet storage (compressed summaries).
 */
export interface ClosetRepositoryPort {
  getClosets(userId: string, roomId?: string): Promise<MemoryCloset[]>;
  createCloset(input: {
    roomId: string;
    wingId: string;
    userId: string;
    compressedContent: string;
    sourceDrawerIds: string[];
    tokenCount: number;
  }): Promise<MemoryCloset>;
}

/**
 * Port for knowledge triple search.
 */
export interface TripleSearchPort {
  queryTriples(userId: string, options?: { subject?: string; predicate?: string; asOf?: Date; limit?: number }): Promise<KnowledgeTriple[]>;
}

/**
 * The MemoryStack implements the 4-layer retrieval system from MemPalace.
 *
 * - L0 (Identity): ~100 tokens, always loaded. Core user identity.
 * - L1 (Essential Story): ~500-800 tokens, always loaded. Top patterns and key episodes.
 * - L2 (On-Demand): ~200-500 tokens each, loaded per topic/wing.
 * - L3 (Deep Search): Unlimited, full search across all drawers and episodes.
 */
export class MemoryStack {
  constructor(
    private readonly palaceRepo: PalaceRepositoryPort,
    private readonly episodeRepo: EpisodeRepositoryPort,
    private readonly closetRepo: ClosetRepositoryPort,
    private readonly tripleSearch: TripleSearchPort,
  ) {}

  /**
   * Generate the wake-up context (L0 + L1) for a user.
   * This is loaded at the start of every decision cycle.
   */
  async wakeUp(userId: string): Promise<WakeUpContext> {
    const identity = await this.generateL0(userId);
    const essentialStory = await this.generateL1(userId);

    const tokenCount = this.estimateTokens(identity) + this.estimateTokens(essentialStory);

    return {
      userId,
      identity,
      essentialStory,
      tokenCount,
      generatedAt: new Date(),
    };
  }

  /**
   * L2: On-demand recall for a specific wing/topic.
   */
  async recall(userId: string, wingName: string): Promise<RecallResult> {
    const wings = await this.palaceRepo.getWings(userId);
    const wing = wings.find((w) => w.name === wingName);

    if (!wing) {
      return {
        wingName,
        closets: [],
        recentDrawers: [],
        relevantEpisodes: [],
        tokenCount: 0,
      };
    }

    const closets = await this.closetRepo.getClosets(userId);
    const wingClosets = closets.filter((c) => {
      // Match closets belonging to this wing
      return (c as unknown as { wingId: string }).wingId === wing.id;
    });

    const recentDrawers = await this.palaceRepo.getDrawers(userId, {
      wingId: wing.id,
      limit: 10,
    });

    // Get episodes related to this wing's domains
    const episodes = await this.episodeRepo.getEpisodes(userId, {
      domain: wing.domains[0],
      limit: 5,
      minUtility: 0.3,
    });

    const tokenCount = wingClosets.reduce((sum, c) => sum + c.tokenCount, 0)
      + this.estimateTokens(recentDrawers.map((d) => d.content).join('\n'))
      + this.estimateTokens(episodes.map((e) => e.situationSummary).join('\n'));

    return {
      wingName,
      closets: wingClosets,
      recentDrawers,
      relevantEpisodes: episodes,
      tokenCount,
    };
  }

  /**
   * L3: Deep search across all drawers, episodes, and triples.
   */
  async search(userId: string, searchTerms: string[], limit: number = 20): Promise<MemorySearchResult> {
    const [drawers, episodes, triples] = await Promise.all([
      this.palaceRepo.searchDrawers(userId, searchTerms, limit),
      this.episodeRepo.searchEpisodes(userId, searchTerms, Math.ceil(limit / 2)),
      this.searchTriples(userId, searchTerms),
    ]);

    return {
      drawers,
      episodes,
      triples,
      totalFound: drawers.length + episodes.length + triples.length,
      searchedAt: new Date(),
    };
  }

  /**
   * Get the appropriate memory layer for a given context.
   */
  getLayerForContext(hasSpecificTopic: boolean, needsDeepSearch: boolean): MemoryLayer {
    if (needsDeepSearch) return MemoryLayer.L3_DEEP_SEARCH;
    if (hasSpecificTopic) return MemoryLayer.L2_ON_DEMAND;
    return MemoryLayer.L1_ESSENTIAL;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * L0: Generate identity summary from core facts and high-confidence preferences.
   */
  private async generateL0(userId: string): Promise<string> {
    // Get the highest-utility episodes and core triples
    const triples = await this.tripleSearch.queryTriples(userId, {
      predicate: 'is',
      asOf: new Date(),
      limit: 10,
    });

    if (triples.length === 0) {
      return `User ${userId}: No identity context established yet.`;
    }

    const facts = triples
      .map((t) => `${t.subject} ${t.predicate} ${t.object}`)
      .join('. ');

    return `Identity: ${facts}`;
  }

  /**
   * L1: Generate essential story from top drawers, patterns, and recent episodes.
   */
  private async generateL1(userId: string): Promise<string> {
    // Get most important drawers across all wings
    const allDrawers = await this.palaceRepo.getDrawers(userId, { limit: 20 });
    const topDrawers = allDrawers
      .sort((a, b) => (b.metadata.importance ?? 0) - (a.metadata.importance ?? 0))
      .slice(0, 5);

    // Get highest-utility episodes
    const episodes = await this.episodeRepo.getEpisodes(userId, {
      limit: 5,
      minUtility: 0.6,
    });

    const parts: string[] = [];

    if (topDrawers.length > 0) {
      parts.push('Key memories: ' + topDrawers.map((d) => d.content).join(' | '));
    }

    if (episodes.length > 0) {
      const episodeSummaries = episodes.map((e) => {
        const outcome = e.feedbackType === 'approve' ? '[good]'
          : e.feedbackType === 'reject' ? '[bad]'
          : '';
        return `${e.situationSummary} → ${e.actionTaken ?? 'no action'} ${outcome}`;
      });
      parts.push('Key episodes: ' + episodeSummaries.join(' | '));
    }

    return parts.join('\n') || 'No essential context available yet.';
  }

  /**
   * Search triples by matching against subject, predicate, or object text.
   */
  private async searchTriples(userId: string, terms: string[]): Promise<KnowledgeTriple[]> {
    const results: KnowledgeTriple[] = [];
    for (const term of terms) {
      const bySubject = await this.tripleSearch.queryTriples(userId, {
        subject: term,
        asOf: new Date(),
        limit: 5,
      });
      results.push(...bySubject);
    }
    // Dedupe by id
    const seen = new Set<string>();
    return results.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }

  /**
   * Rough token estimation (~4 chars per token).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
