import { query } from '../connection.js';
import type { BehavioralPattern, CrossDomainTrait, ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Row shape returned from the behavioral_patterns table.
 */
interface BehavioralPatternRow {
  id: string;
  user_id: string;
  pattern_type: string;
  description: string;
  trigger_config: Record<string, unknown>;
  observed_action: string;
  frequency: number;
  confidence: string;
  first_observed_at: Date;
  last_observed_at: Date;
  metadata: Record<string, unknown>;
}

/**
 * Row shape returned from the cross_domain_traits table.
 */
interface CrossDomainTraitRow {
  id: string;
  user_id: string;
  trait_name: string;
  confidence: string;
  supporting_domains: string[];
  evidence_count: number;
  description: string;
  created_at: Date;
  updated_at: Date;
}

function rowToPattern(row: BehavioralPatternRow): BehavioralPattern {
  return {
    id: row.id,
    userId: row.user_id,
    patternType: row.pattern_type as BehavioralPattern['patternType'],
    description: row.description,
    trigger: row.trigger_config as unknown as BehavioralPattern['trigger'],
    observedAction: row.observed_action,
    frequency: row.frequency,
    confidence: row.confidence as ConfidenceLevel,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    metadata: row.metadata,
  };
}

function rowToTrait(row: CrossDomainTraitRow): CrossDomainTrait {
  return {
    id: row.id,
    traitName: row.trait_name,
    confidence: row.confidence as ConfidenceLevel,
    supportingDomains: row.supporting_domains,
    evidenceCount: row.evidence_count,
    description: row.description,
  };
}

/**
 * Repository for behavioral patterns and cross-domain traits.
 * Implements the PatternRepositoryPort interface from @skytwin/twin-model.
 */
export const patternRepository = {
  async getPatterns(userId: string): Promise<BehavioralPattern[]> {
    const result = await query<BehavioralPatternRow>(
      `SELECT * FROM behavioral_patterns
       WHERE user_id = $1
       ORDER BY frequency DESC, last_observed_at DESC`,
      [userId],
    );
    return result.rows.map(rowToPattern);
  },

  async upsertPattern(userId: string, pattern: BehavioralPattern): Promise<BehavioralPattern> {
    const result = await query<BehavioralPatternRow>(
      `INSERT INTO behavioral_patterns (
        id, user_id, pattern_type, description, trigger_config,
        observed_action, frequency, confidence,
        first_observed_at, last_observed_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        description = EXCLUDED.description,
        trigger_config = EXCLUDED.trigger_config,
        observed_action = EXCLUDED.observed_action,
        frequency = EXCLUDED.frequency,
        confidence = EXCLUDED.confidence,
        last_observed_at = EXCLUDED.last_observed_at,
        metadata = EXCLUDED.metadata
      RETURNING *`,
      [
        pattern.id,
        userId,
        pattern.patternType,
        pattern.description,
        JSON.stringify(pattern.trigger),
        pattern.observedAction,
        pattern.frequency,
        pattern.confidence,
        pattern.firstObservedAt,
        pattern.lastObservedAt,
        JSON.stringify(pattern.metadata),
      ],
    );
    return rowToPattern(result.rows[0]!);
  },

  async getTraits(userId: string): Promise<CrossDomainTrait[]> {
    const result = await query<CrossDomainTraitRow>(
      `SELECT * FROM cross_domain_traits
       WHERE user_id = $1
       ORDER BY evidence_count DESC`,
      [userId],
    );
    return result.rows.map(rowToTrait);
  },

  async upsertTrait(userId: string, trait: CrossDomainTrait): Promise<CrossDomainTrait> {
    const result = await query<CrossDomainTraitRow>(
      `INSERT INTO cross_domain_traits (
        id, user_id, trait_name, confidence, supporting_domains,
        evidence_count, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, trait_name) DO UPDATE SET
        confidence = EXCLUDED.confidence,
        supporting_domains = EXCLUDED.supporting_domains,
        evidence_count = EXCLUDED.evidence_count,
        description = EXCLUDED.description,
        updated_at = now()
      RETURNING *`,
      [
        trait.id,
        userId,
        trait.traitName,
        trait.confidence,
        trait.supportingDomains,
        trait.evidenceCount,
        trait.description,
      ],
    );
    return rowToTrait(result.rows[0]!);
  },
};
