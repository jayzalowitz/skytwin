import type { ExplanationRepositoryPort } from '@skytwin/explanations';
import type {
  ExplanationRecord,
  EvidenceReference,
  PreferenceReference,
} from '@skytwin/shared-types';
import { ConfidenceLevel, RiskTier } from '@skytwin/shared-types';
import { explanationRepository } from '../repositories/index.js';
import type { ExplanationRecordRow } from '../types.js';

// ── Enum parsers ─────────────────────────────────────────────────────────────

/**
 * Parse a string into a ConfidenceLevel enum value.
 * Falls back to ConfidenceLevel.SPECULATIVE for unrecognised values.
 */
function parseConfidenceLevel(value: string): ConfidenceLevel {
  const values = Object.values(ConfidenceLevel) as string[];
  if (values.includes(value)) {
    return value as ConfidenceLevel;
  }
  return ConfidenceLevel.SPECULATIVE;
}

/**
 * Parse a string into a RiskTier enum value.
 * Falls back to RiskTier.NEGLIGIBLE for unrecognised values.
 */
function parseRiskTier(value: string): RiskTier {
  const values = Object.values(RiskTier) as string[];
  if (values.includes(value)) {
    return value as RiskTier;
  }
  return RiskTier.NEGLIGIBLE;
}

// ── Row-to-domain mappers ────────────────────────────────────────────────────

/**
 * Convert the DB row's `evidence_used` JSONB array into typed
 * EvidenceReference objects. Each element may be a full object or a plain
 * string; we normalise both.
 */
function parseEvidenceUsed(raw: unknown[]): EvidenceReference[] {
  return raw.map((item): EvidenceReference => {
    if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      return {
        evidenceId: (obj['evidenceId'] as string) ?? '',
        source: (obj['source'] as string) ?? '',
        summary: (obj['summary'] as string) ?? '',
        relevance: (obj['relevance'] as string) ?? '',
      };
    }

    // Plain string fallback
    return {
      evidenceId: '',
      source: '',
      summary: String(item),
      relevance: '',
    };
  });
}

/**
 * Convert the DB row's `preferences_invoked` string array into typed
 * PreferenceReference objects. The DB stores a simplified array; we
 * reconstruct as much as possible.
 */
function parsePreferencesInvoked(raw: string[]): PreferenceReference[] {
  return raw.map((item): PreferenceReference => {
    // Attempt to parse if stored as JSON string
    if (item.startsWith('{')) {
      try {
        const obj = JSON.parse(item) as Record<string, unknown>;
        return {
          preferenceId: (obj['preferenceId'] as string) ?? '',
          domain: (obj['domain'] as string) ?? '',
          key: (obj['key'] as string) ?? '',
          confidence: parseConfidenceLevel(
            (obj['confidence'] as string) ?? '',
          ),
          howUsed: (obj['howUsed'] as string) ?? '',
        };
      } catch {
        // Fall through to plain string handling
      }
    }

    return {
      preferenceId: '',
      domain: '',
      key: item,
      confidence: ConfidenceLevel.SPECULATIVE,
      howUsed: '',
    };
  });
}

/**
 * Map an ExplanationRecordRow from the database to the domain
 * ExplanationRecord type.
 *
 * Some domain fields (userId, riskTier, overallConfidence) are not stored
 * directly in the explanation_records table. We reconstruct them from the
 * JSONB evidence_used column when possible, falling back to sensible defaults.
 */
function isAdapterMeta(entry: unknown): entry is Record<string, unknown> {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    '__adapter_meta' in (entry as Record<string, unknown>)
  );
}

function explanationRowToDomain(
  row: ExplanationRecordRow,
): ExplanationRecord {
  const preferencesInvoked = parsePreferencesInvoked(
    row.preferences_invoked,
  );

  // Try to recover riskTier, overallConfidence, and userId if they were
  // stashed in the evidence_used array as metadata by the save() method.
  let riskTier: RiskTier = RiskTier.NEGLIGIBLE;
  let overallConfidence: ConfidenceLevel = ConfidenceLevel.SPECULATIVE;
  let userId = '';

  const metaEntry = row.evidence_used.find(isAdapterMeta);

  if (metaEntry) {
    riskTier = parseRiskTier((metaEntry['riskTier'] as string) ?? '');
    overallConfidence = parseConfidenceLevel(
      (metaEntry['overallConfidence'] as string) ?? '',
    );
    userId = (metaEntry['userId'] as string) ?? '';
  }

  // Parse evidence, excluding the adapter metadata entry.
  const rawEvidence = row.evidence_used.filter(
    (entry) => !isAdapterMeta(entry),
  );
  const evidenceUsed = parseEvidenceUsed(rawEvidence);

  return {
    id: row.id,
    decisionId: row.decision_id,
    userId,
    summary: row.what_happened,
    evidenceUsed,
    preferencesInvoked,
    confidenceReasoning: row.confidence_reasoning,
    actionRationale: row.action_rationale,
    escalationRationale: row.escalation_rationale ?? undefined,
    correctionGuidance: row.correction_guidance,
    riskTier,
    overallConfidence,
    createdAt: row.created_at,
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Adapter that bridges the ExplanationRepositoryPort interface used by
 * business logic to the concrete explanationRepository backed by CockroachDB.
 */
export const explanationRepositoryAdapter: ExplanationRepositoryPort = {
  async save(record: ExplanationRecord): Promise<ExplanationRecord> {
    // Serialise EvidenceReference[] into plain objects for JSONB storage.
    // We also stash riskTier, overallConfidence, and userId as a metadata
    // entry so they survive the round-trip (the DB schema does not have
    // dedicated columns for these fields).
    const evidenceSerialized: unknown[] = record.evidenceUsed.map((e) => ({
      evidenceId: e.evidenceId,
      source: e.source,
      summary: e.summary,
      relevance: e.relevance,
    }));

    evidenceSerialized.push({
      __adapter_meta: true,
      riskTier: record.riskTier,
      overallConfidence: record.overallConfidence,
      userId: record.userId,
    });

    // Serialise PreferenceReference[] into JSON strings for the
    // string[] column.
    const preferencesSerialized: string[] = record.preferencesInvoked.map(
      (p) =>
        JSON.stringify({
          preferenceId: p.preferenceId,
          domain: p.domain,
          key: p.key,
          confidence: p.confidence,
          howUsed: p.howUsed,
        }),
    );

    // Decision IDs from the in-memory engine may not be UUIDs; pass null
    // so the DB default (gen_random_uuid) generates a proper one.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const safeDecisionId = uuidRegex.test(record.decisionId) ? record.decisionId : null;
    const row = await explanationRepository.create({
      decisionId: safeDecisionId as string,
      whatHappened: record.summary,
      evidenceUsed: evidenceSerialized,
      preferencesInvoked: preferencesSerialized,
      confidenceReasoning: record.confidenceReasoning,
      actionRationale: record.actionRationale,
      escalationRationale: record.escalationRationale ?? null,
      correctionGuidance: record.correctionGuidance,
    });

    return explanationRowToDomain(row);
  },

  async getByDecisionId(
    decisionId: string,
  ): Promise<ExplanationRecord | null> {
    const row = await explanationRepository.findByDecision(decisionId);
    if (!row) return null;
    return explanationRowToDomain(row);
  },

  async getByUserId(
    userId: string,
    limit?: number,
  ): Promise<ExplanationRecord[]> {
    const rows = await explanationRepository.findByUser(userId, {
      limit: limit ?? 50,
    });
    return rows.map(explanationRowToDomain);
  },
};
