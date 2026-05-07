import type { RegistryEntry } from '@skytwin/registry-client';
import type {
  InferenceEngineOptions,
  SignalLike,
  SignalMention,
  AppSuggestionInput,
} from './types.js';
import { aggregateMentions } from './evidence-aggregator.js';

const DEFAULT_THRESHOLD = { evidenceCount: 3, kindsDistinct: 2 };

/**
 * Returns true when the keyword appears in the text at a word boundary.
 * Handles multi-word keywords by anchoring start/end on word chars only
 * when adjacent characters exist. Falls back to exact substring if the
 * regex fails to compile (should never happen with curated keywords).
 */
function matchesKeyword(text: string, keyword: string): boolean {
  if (keyword.trim().length === 0) return false;
  try {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i');
    return pattern.test(text);
  } catch {
    return text.toLowerCase().includes(keyword.toLowerCase());
  }
}

/**
 * Extracts the signal mentions for all known registry entries from a
 * single signal's excerpt.
 */
function extractMentions(
  signal: SignalLike,
  entries: RegistryEntry[],
): SignalMention[] {
  const mentions: SignalMention[] = [];

  for (const entry of entries) {
    const allTerms = [
      entry.id,
      entry.displayName,
      ...entry.keywords,
    ];

    const matched = allTerms.some((term) => matchesKeyword(signal.excerpt, term));
    if (!matched) continue;

    mentions.push({
      registryId: entry.id,
      signalId: signal.id,
      signalKind: signal.kind,
      excerpt: signal.excerpt.slice(0, 80),
      occurredAt: signal.occurredAt,
    });
  }

  return mentions;
}

/**
 * The capability inference engine.
 *
 * Reads user signals, cross-references against the registry keyword index,
 * and emits AppSuggestionInput rows with evidence trails.
 * This is the deterministic v1 implementation (keyword-match).
 * The prompt-driven replacement ships in #189.
 */
export class CapabilityInferenceEngine {
  private readonly options: Required<InferenceEngineOptions> & {
    surfacingThreshold: { evidenceCount: number; kindsDistinct: number };
  };

  constructor(opts: InferenceEngineOptions) {
    this.options = {
      ...opts,
      surfacingThreshold: opts.surfacingThreshold ?? DEFAULT_THRESHOLD,
    };
  }

  async run(userId: string, signals: SignalLike[]): Promise<AppSuggestionInput[]> {
    const entries = await this.options.registry.getAll();

    const allMentions: SignalMention[] = [];
    for (const signal of signals) {
      const found = extractMentions(signal, entries);
      allMentions.push(...found);
    }

    const displayNames = new Map(entries.map((e) => [e.id, e.displayName]));
    const aggregated = aggregateMentions(userId, allMentions, displayNames);

    const { evidenceCount: minCount, kindsDistinct: minKinds } =
      this.options.surfacingThreshold;

    const suggestions: AppSuggestionInput[] = [];
    for (const suggestion of aggregated.values()) {
      if (
        suggestion.evidenceCount >= minCount &&
        suggestion.evidenceKindsDistinct >= minKinds
      ) {
        suggestions.push(suggestion);
      }
    }

    return suggestions.sort((a, b) => b.confidenceScore - a.confidenceScore);
  }
}
