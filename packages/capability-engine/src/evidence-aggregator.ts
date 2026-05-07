import type { SignalMention, AppSuggestionInput, EvidenceSource } from './types.js';
import { scoreConfidence } from './confidence-scorer.js';

const MAX_EVIDENCE_SOURCES = 5;

/**
 * Groups signal mentions by registryId and aggregates them into
 * AppSuggestionInput objects, ready for the surfacing-threshold check.
 */
export function aggregateMentions(
  userId: string,
  mentions: SignalMention[],
  displayNames: Map<string, string>,
): Map<string, AppSuggestionInput> {
  const grouped = new Map<string, SignalMention[]>();

  for (const mention of mentions) {
    const existing = grouped.get(mention.registryId) ?? [];
    existing.push(mention);
    grouped.set(mention.registryId, existing);
  }

  const result = new Map<string, AppSuggestionInput>();

  for (const [registryId, entries] of grouped) {
    const sortedByTime = [...entries].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );

    const distinctKinds = new Set(sortedByTime.map((e) => e.signalKind));
    const kindsDistinct = distinctKinds.size;
    const evidenceCount = sortedByTime.length;

    const firstEvidenceAt = sortedByTime[0]!.occurredAt;
    const lastEvidenceAt = sortedByTime[sortedByTime.length - 1]!.occurredAt;

    const sources: EvidenceSource[] = sortedByTime.slice(-MAX_EVIDENCE_SOURCES).map((e) => ({
      kind: e.signalKind,
      ref: e.signalId,
      excerpt: e.excerpt,
      at: e.occurredAt.toISOString(),
    }));

    const confidenceScore = scoreConfidence(evidenceCount, kindsDistinct);
    const displayName = displayNames.get(registryId) ?? registryId;

    const kindList = [...distinctKinds].join(', ');
    const reasonSummary =
      `Mentioned ${evidenceCount} time(s) across ${kindsDistinct} signal kind(s) (${kindList}).`;

    result.set(registryId, {
      userId,
      registryId,
      displayName,
      evidenceCount,
      evidenceSources: sources,
      evidenceKindsDistinct: kindsDistinct,
      firstEvidenceAt,
      lastEvidenceAt,
      confidenceScore,
      reasonSummary,
    });
  }

  return result;
}
