import type {
  KnowledgeEntity,
  KnowledgeTriple,
} from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Port interface for knowledge graph persistence.
 */
export interface KnowledgeGraphRepositoryPort {
  upsertEntity(userId: string, name: string, entityType: string, properties: Record<string, unknown>, aliases: string[]): Promise<KnowledgeEntity>;
  getEntities(userId: string, entityType?: string): Promise<KnowledgeEntity[]>;
  findEntity(userId: string, name: string): Promise<KnowledgeEntity | null>;

  addTriple(userId: string, subject: string, predicate: string, object: string, validFrom: Date, confidence: ConfidenceLevel, sourceDrawerId?: string): Promise<KnowledgeTriple>;
  queryTriples(userId: string, options?: { subject?: string; predicate?: string; object?: string; asOf?: Date; limit?: number }): Promise<KnowledgeTriple[]>;
  invalidateTriple(tripleId: string, validTo?: Date): Promise<void>;
}

/**
 * The KnowledgeGraph manages entities and temporal fact triples.
 * It supports point-in-time queries ("what was true on date X?")
 * and fact invalidation when things change.
 */
export class KnowledgeGraph {
  constructor(private readonly repository: KnowledgeGraphRepositoryPort) {}

  /**
   * Record a known entity (person, place, project, etc.)
   */
  async recordEntity(
    userId: string,
    name: string,
    entityType: KnowledgeEntity['entityType'],
    properties: Record<string, unknown> = {},
    aliases: string[] = [],
  ): Promise<KnowledgeEntity> {
    return this.repository.upsertEntity(userId, name, entityType, properties, aliases);
  }

  /**
   * Record a fact about the world with temporal validity.
   * E.g., "Alice works at Acme Corp" valid from 2025-03.
   */
  async recordFact(
    userId: string,
    subject: string,
    predicate: string,
    object: string,
    options?: {
      validFrom?: Date;
      confidence?: ConfidenceLevel;
      sourceDrawerId?: string;
    },
  ): Promise<KnowledgeTriple> {
    // Check if there's an existing active triple with the same subject+predicate
    // and different object — if so, invalidate the old one first
    const existing = await this.repository.queryTriples(userId, {
      subject,
      predicate,
      asOf: new Date(),
    });

    for (const triple of existing) {
      if (triple.object !== object) {
        // This fact has changed — invalidate the old one
        await this.repository.invalidateTriple(triple.id);
      }
    }

    return this.repository.addTriple(
      userId,
      subject,
      predicate,
      object,
      options?.validFrom ?? new Date(),
      options?.confidence ?? ConfidenceLevel.MODERATE,
      options?.sourceDrawerId,
    );
  }

  /**
   * Query what was true about a subject at a specific point in time.
   */
  async queryEntity(
    userId: string,
    subject: string,
    asOf?: Date,
  ): Promise<KnowledgeTriple[]> {
    return this.repository.queryTriples(userId, {
      subject,
      asOf: asOf ?? new Date(),
    });
  }

  /**
   * Query all facts matching a predicate (e.g., all "works_at" relationships).
   */
  async queryByPredicate(
    userId: string,
    predicate: string,
    asOf?: Date,
  ): Promise<KnowledgeTriple[]> {
    return this.repository.queryTriples(userId, {
      predicate,
      asOf: asOf ?? new Date(),
    });
  }

  /**
   * Find all entities of a specific type.
   */
  async findEntities(
    userId: string,
    entityType?: KnowledgeEntity['entityType'],
  ): Promise<KnowledgeEntity[]> {
    return this.repository.getEntities(userId, entityType);
  }

  /**
   * Find an entity by name or alias.
   */
  async findEntity(userId: string, name: string): Promise<KnowledgeEntity | null> {
    return this.repository.findEntity(userId, name);
  }

  /**
   * Mark a fact as no longer true.
   */
  async invalidateFact(tripleId: string, endDate?: Date): Promise<void> {
    return this.repository.invalidateTriple(tripleId, endDate);
  }

  /**
   * Build a timeline for an entity: all facts about them over time.
   */
  async getTimeline(
    userId: string,
    subject: string,
  ): Promise<KnowledgeTriple[]> {
    // Get all triples for this subject (active and expired)
    return this.repository.queryTriples(userId, {
      subject,
      limit: 200,
    });
  }

  /**
   * Extract entities and facts from a text-based drawer content.
   * This is a simple rule-based extraction — can be enhanced with LLM later.
   */
  extractEntitiesFromText(text: string): Array<{
    name: string;
    entityType: KnowledgeEntity['entityType'];
  }> {
    const entities: Array<{ name: string; entityType: KnowledgeEntity['entityType'] }> = [];

    // Simple heuristic: look for capitalized multi-word phrases
    const capitalizedPhrases = text.match(/(?:[A-Z][a-z]+ ){1,3}[A-Z][a-z]+/g) ?? [];
    for (const phrase of capitalizedPhrases) {
      // Skip common sentence starters
      if (['The', 'This', 'That', 'When', 'What', 'Where', 'How'].some((w) => phrase.startsWith(w))) {
        continue;
      }
      entities.push({ name: phrase.trim(), entityType: 'person' });
    }

    // Look for email-style references
    const emailDomains = text.match(/@[\w.-]+\.\w+/g) ?? [];
    for (const domain of emailDomains) {
      entities.push({ name: domain.replace('@', ''), entityType: 'organization' });
    }

    return entities;
  }
}
