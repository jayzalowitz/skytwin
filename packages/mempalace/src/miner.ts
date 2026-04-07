import type {
  TwinEvidence,
  FeedbackEvent,
  DecisionOutcome,
  Preference,
  BehavioralPattern,
  MemoryDrawer,
  MemoryHall,
  DrawerMetadata,
} from '@skytwin/shared-types';
import type { Palace, PalaceRepositoryPort } from './palace.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { EpisodeStore, EpisodeRepositoryPort } from './episode-store.js';

/**
 * The MemoryMiner extracts structured memories from raw signals,
 * decisions, and feedback. It is the bridge between the SkyTwin
 * event system and the Memory Palace storage.
 */
export class MemoryMiner {
  constructor(
    private readonly palace: Palace,
    private readonly knowledgeGraph: KnowledgeGraph,
    private readonly episodeStore: EpisodeStore,
    private readonly palaceRepo?: PalaceRepositoryPort,
    private readonly episodeRepo?: EpisodeRepositoryPort,
  ) {}

  /**
   * Mine a new piece of evidence (signal) into the memory palace.
   * Creates drawers in the appropriate wing/room and extracts entities.
   * Idempotent: if a drawer already exists for this evidence's sourceId,
   * it is returned without creating a duplicate.
   */
  async mineEvidence(userId: string, evidence: TwinEvidence): Promise<MemoryDrawer> {
    // Dedup: check if this evidence has already been mined
    if (this.palaceRepo && evidence.id) {
      const existing = await this.palaceRepo.findDrawerBySourceId(userId, 'signal', evidence.id);
      if (existing) return existing;
    }

    const hall = this.evidenceToHall(evidence);
    const topic = this.evidenceToTopic(evidence);
    const content = this.evidenceToContent(evidence);

    const metadata: Partial<DrawerMetadata> = {
      domain: evidence.domain,
      signalIds: [evidence.id],
      people: this.extractPeople(evidence.data),
      tags: this.extractTags(evidence),
      importance: this.assessImportance(evidence),
      temporalContext: {
        timeOfDay: this.getTimeOfDay(evidence.timestamp),
        dayOfWeek: evidence.timestamp.getDay(),
        isWorkHours: this.isWorkHours(evidence.timestamp),
      },
    };

    // File the memory
    const drawer = await this.palace.fileMemory(
      userId,
      evidence.domain,
      topic,
      hall,
      content,
      metadata,
      'signal',
      evidence.id,
    );

    // Extract and record entities
    const entities = this.knowledgeGraph.extractEntitiesFromText(content);
    for (const entity of entities) {
      await this.knowledgeGraph.recordEntity(userId, entity.name, entity.entityType);
    }

    // Extract facts from structured signal data
    await this.extractFacts(userId, evidence, drawer.id);

    return drawer;
  }

  /**
   * Mine a decision outcome into the memory palace.
   * Creates an episodic memory and records decision-related drawers.
   * Idempotent: skips if an episode already exists for this decision.
   */
  async mineDecision(
    userId: string,
    domain: string,
    situationType: string,
    situationSummary: string,
    outcome: DecisionOutcome,
    activePreferences: Preference[],
    activePatterns: BehavioralPattern[],
  ): Promise<void> {
    // Dedup: check if this decision has already been mined as an episode
    if (this.episodeRepo && outcome.decisionId) {
      const existing = await this.episodeRepo.getEpisodeByDecision(outcome.decisionId);
      if (existing) return;
    }

    // Create the episodic memory
    await this.episodeStore.recordFromDecision(
      userId,
      domain,
      situationType,
      situationSummary,
      outcome,
      activePreferences,
      activePatterns,
    );

    // If there was a selected action, also file it as an "advice" drawer
    if (outcome.selectedAction) {
      const content = `Decision: ${situationSummary} → Action: ${outcome.selectedAction.description}. Reasoning: ${outcome.reasoning}`;

      await this.palace.fileMemory(
        userId,
        domain,
        this.situationToTopic(situationType),
        'advice',
        content,
        {
          decisionId: outcome.decisionId,
          importance: outcome.autoExecute ? 0.7 : 0.5,
          situationType,
        },
        'decision',
        outcome.id,
      );
    }
  }

  /**
   * Mine user feedback into the memory palace.
   * Updates the episodic memory and creates discovery drawers for corrections.
   */
  async mineFeedback(userId: string, feedback: FeedbackEvent): Promise<void> {
    // Update the episode
    await this.episodeStore.recordFeedback(feedback);

    // For corrections, record a discovery
    if (feedback.feedbackType === 'correct' || feedback.feedbackType === 'undo') {
      const content = feedback.feedbackType === 'undo'
        ? `User undid action on decision ${feedback.decisionId}. Reason: ${feedback.reason ?? 'not specified'}. Preferred: ${feedback.correctedAction ?? 'unknown'}`
        : `User corrected decision ${feedback.decisionId}. Original rejected, preferred: ${feedback.correctedAction ?? feedback.correctedValue ?? 'different approach'}`;

      await this.palace.fileMemory(
        userId,
        'general',
        'corrections',
        'discoveries',
        content,
        {
          decisionId: feedback.decisionId,
          importance: feedback.feedbackType === 'undo' ? 0.9 : 0.7,
          tags: ['correction', feedback.feedbackType],
        },
        'feedback',
        feedback.id,
      );
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private evidenceToHall(evidence: TwinEvidence): MemoryHall {
    switch (evidence.type) {
      case 'preference':
      case 'setting':
        return 'preferences';
      case 'action':
      case 'event':
      case 'interaction':
        return 'events';
      case 'pattern':
      case 'observation':
        return 'discoveries';
      default:
        return 'facts';
    }
  }

  private evidenceToTopic(evidence: TwinEvidence): string {
    // Use source + type as topic, e.g., "gmail-inbox", "calendar-events"
    return `${evidence.source}-${evidence.type}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  private evidenceToContent(evidence: TwinEvidence): string {
    const parts: string[] = [];
    parts.push(`[${evidence.source}/${evidence.type}]`);

    const data = evidence.data;
    if (data['subject']) parts.push(`Subject: ${String(data['subject'])}`);
    if (data['from']) parts.push(`From: ${String(data['from'])}`);
    if (data['to']) parts.push(`To: ${String(data['to'])}`);
    if (data['summary']) parts.push(String(data['summary']));
    if (data['title']) parts.push(String(data['title']));
    if (data['description']) parts.push(String(data['description']));
    if (data['amount']) parts.push(`Amount: ${String(data['amount'])}`);

    if (parts.length === 1) {
      // No structured fields found, use raw JSON summary
      parts.push(JSON.stringify(data).slice(0, 200));
    }

    return parts.join('. ');
  }

  private extractPeople(data: Record<string, unknown>): string[] {
    const people: string[] = [];
    if (typeof data['from'] === 'string') people.push(data['from']);
    if (typeof data['to'] === 'string') people.push(data['to']);
    if (Array.isArray(data['attendees'])) {
      people.push(...data['attendees'].filter((a): a is string => typeof a === 'string'));
    }
    if (typeof data['sender'] === 'string') people.push(data['sender']);
    return [...new Set(people)];
  }

  private extractTags(evidence: TwinEvidence): string[] {
    const tags: string[] = [evidence.source, evidence.type, evidence.domain];
    const data = evidence.data;

    if (data['labels'] && Array.isArray(data['labels'])) {
      tags.push(...data['labels'].filter((l): l is string => typeof l === 'string'));
    }
    if (data['category'] && typeof data['category'] === 'string') {
      tags.push(data['category']);
    }

    return [...new Set(tags)];
  }

  private assessImportance(evidence: TwinEvidence): number {
    let importance = 0.5;

    const data = evidence.data;
    // Financial signals are more important
    if (evidence.domain === 'finance' || data['amount']) importance += 0.2;
    // Calendar events with conflicts
    if (data['hasConflict']) importance += 0.2;
    // High urgency
    if (data['urgency'] === 'high' || data['urgency'] === 'critical') importance += 0.2;
    // From known important people
    if (data['vip'] || data['important']) importance += 0.1;

    return Math.min(importance, 1.0);
  }

  private async extractFacts(
    userId: string,
    evidence: TwinEvidence,
    drawerId: string,
  ): Promise<void> {
    const data = evidence.data;

    // Extract "person works at org" from email domains
    if (typeof data['from'] === 'string') {
      const emailMatch = (data['from'] as string).match(/@([\w.-]+)/);
      if (emailMatch?.[1] && !['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'].includes(emailMatch[1])) {
        const name = (data['from'] as string).split('@')[0]?.replace(/[._]/g, ' ') ?? 'unknown';
        await this.knowledgeGraph.recordFact(
          userId,
          name,
          'emails_from',
          emailMatch[1],
          { sourceDrawerId: drawerId },
        );
      }
    }

    // Extract "event at location" facts
    if (typeof data['location'] === 'string' && typeof data['title'] === 'string') {
      await this.knowledgeGraph.recordFact(
        userId,
        data['title'] as string,
        'at',
        data['location'] as string,
        { sourceDrawerId: drawerId },
      );
    }
  }

  private situationToTopic(situationType: string): string {
    return situationType.toLowerCase().replace(/_/g, '-');
  }

  private getTimeOfDay(date: Date): 'morning' | 'afternoon' | 'evening' | 'night' {
    const hour = date.getHours();
    if (hour < 6) return 'night';
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
  }

  private isWorkHours(date: Date): boolean {
    const hour = date.getHours();
    const day = date.getDay();
    return day >= 1 && day <= 5 && hour >= 9 && hour < 17;
  }
}
