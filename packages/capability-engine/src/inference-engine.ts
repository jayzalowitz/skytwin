import type { RegistryEntry } from '@skytwin/registry-client';
import type { LlmClient } from '@skytwin/llm-client';
import { runPrompt } from '@skytwin/policy-prompts';
import type {
  InferenceEngineOptions,
  SignalLike,
  SignalMention,
  AppSuggestionInput,
} from './types.js';
import { aggregateMentions } from './evidence-aggregator.js';

const DEFAULT_THRESHOLD = { evidenceCount: 3, kindsDistinct: 2 };
const ADAPTIVE_CONFIDENCE_FLOOR = 0.4;

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

/** Shape returned by the service-detection prompt */
interface ServiceDetectionOutput {
  name: string;
  evidence: SignalMention[];
}

/** Shape returned by the capability-ranking prompt */
interface CapabilityRankingOutput {
  registryId: string;
  score: number;
}

/**
 * Options for CapabilityInferenceEngine.
 * Extends InferenceEngineOptions with an optional LlmClient for the adaptive paths.
 */
export interface CapabilityInferenceEngineOptions extends InferenceEngineOptions {
  llmClient?: LlmClient;
}

/**
 * The capability inference engine.
 *
 * Reads user signals, cross-references against the registry keyword index,
 * and emits AppSuggestionInput rows with evidence trails.
 *
 * When an llmClient is provided:
 *   B. service-detection: the LLM proposes which services appear in signals;
 *      the registry catalog verifies each proposal (LLM proposes, registry
 *      verifies — kills hallucinations).
 *   F. capability-ranking: the LLM assigns a confidence score to each
 *      suggestion instead of the fixed evidence-count threshold.
 * Without an llmClient, falls back to the deterministic v1 keyword-match path.
 */
export class CapabilityInferenceEngine {
  private readonly options: Required<InferenceEngineOptions> & {
    surfacingThreshold: { evidenceCount: number; kindsDistinct: number };
  };
  private readonly llmClient?: LlmClient;

  constructor(opts: CapabilityInferenceEngineOptions) {
    this.options = {
      ...opts,
      surfacingThreshold: opts.surfacingThreshold ?? DEFAULT_THRESHOLD,
    };
    this.llmClient = opts.llmClient;
  }

  async run(userId: string, signals: SignalLike[]): Promise<AppSuggestionInput[]> {
    // ── Adaptive path (B: service-detection) ──────────────────────────────
    if (this.llmClient) {
      try {
        const detected = await runPrompt<ServiceDetectionOutput[]>({
          promptName: 'service-detection',
          inputs: {
            signals: signals.map((s) => ({
              kind: s.kind,
              excerpt: s.excerpt,
              occurredAt: s.occurredAt,
            })),
          },
          user: { userId },
          llmClient: this.llmClient,
        });

        if (!detected.fellBackToDeterministic) {
          // LLM proposes, registry verifies — kills hallucinations
          const verified = await this.verifyAgainstRegistry(detected.output);
          return this.aggregateAndScore(userId, verified, signals);
        }
      } catch {
        // fall through to deterministic
      }
    }

    // ── Deterministic v1 path (keyword-match) ─────────────────────────────
    return this.runDeterministic(userId, signals);
  }

  /**
   * Run the deterministic v1 keyword-match pipeline.
   */
  async runDeterministic(userId: string, signals: SignalLike[]): Promise<AppSuggestionInput[]> {
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

    return this.rankSuggestions(userId, suggestions.sort((a, b) => b.confidenceScore - a.confidenceScore));
  }

  /**
   * Verify LLM-detected service names against the registry catalog.
   * Returns SignalMentions only for names the registry recognises.
   * The matching is case-insensitive and tries both registry ID and displayName.
   */
  private async verifyAgainstRegistry(
    detected: ServiceDetectionOutput[],
  ): Promise<SignalMention[]> {
    const entries = await this.options.registry.getAll();
    const byId = new Map(entries.map((e) => [e.id.toLowerCase(), e]));
    const byName = new Map(entries.map((e) => [e.displayName.toLowerCase(), e]));

    const verified: SignalMention[] = [];
    for (const item of detected) {
      const key = item.name.toLowerCase();
      const entry = byId.get(key) ?? byName.get(key);
      if (!entry) continue; // LLM hallucinated a service not in the registry

      // Re-use the evidence array from the LLM output if present;
      // otherwise synthesise a minimal mention so the aggregator has something.
      // The LLM returns evidence as untyped JSON so we cast through unknown.
      if (Array.isArray(item.evidence) && item.evidence.length > 0) {
        for (const rawE of item.evidence) {
          const e = rawE as unknown as Record<string, unknown>;
          verified.push({
            registryId: entry.id,
            signalId: typeof e['signalId'] === 'string' ? e['signalId'] : 'llm-detected',
            signalKind: (e['signalKind'] as SignalMention['signalKind'] | undefined) ?? 'email',
            excerpt: String(e['excerpt'] ?? '').slice(0, 80),
            occurredAt: new Date(String(e['occurredAt'] ?? Date.now())),
          });
        }
      } else {
        verified.push({
          registryId: entry.id,
          signalId: 'llm-detected',
          signalKind: 'email',
          excerpt: '',
          occurredAt: new Date(),
        });
      }
    }
    return verified;
  }

  /**
   * Aggregate mentions into AppSuggestionInput rows, then rank them.
   * Called after the LLM-detected + registry-verified mention list is built.
   */
  private async aggregateAndScore(
    userId: string,
    mentions: SignalMention[],
    _signals: SignalLike[],
  ): Promise<AppSuggestionInput[]> {
    const entries = await this.options.registry.getAll();
    const displayNames = new Map(entries.map((e) => [e.id, e.displayName]));
    const aggregated = aggregateMentions(userId, mentions, displayNames);
    const suggestions = [...aggregated.values()];
    return this.rankSuggestions(userId, suggestions);
  }

  /**
   * F: capability-ranking — adaptive ranker that assigns a confidence score
   * to each suggestion via the capability-ranking prompt. Falls back to the
   * deterministic evidence-count threshold when no LLM client is available.
   */
  async rankSuggestions(userId: string, suggestions: AppSuggestionInput[]): Promise<AppSuggestionInput[]> {
    if (suggestions.length === 0) return [];

    if (this.llmClient) {
      try {
        const ranked = await runPrompt<CapabilityRankingOutput[]>({
          promptName: 'capability-ranking',
          inputs: { suggestions },
          user: { userId },
          llmClient: this.llmClient,
        });

        if (!ranked.fellBackToDeterministic) {
          const scoreMap = new Map(ranked.output.map((r) => [r.registryId, r.score]));
          return suggestions
            .map((s) => ({
              ...s,
              confidenceScore: scoreMap.get(s.registryId) ?? s.confidenceScore,
            }))
            .filter((s) => s.confidenceScore >= ADAPTIVE_CONFIDENCE_FLOOR)
            .sort((a, b) => b.confidenceScore - a.confidenceScore);
        }
      } catch {
        // fall through to deterministic
      }
    }

    // Deterministic v1: count + kindsDistinct threshold
    const { evidenceCount: minCount, kindsDistinct: minKinds } =
      this.options.surfacingThreshold;
    return suggestions
      .filter((s) => s.evidenceCount >= minCount && s.evidenceKindsDistinct >= minKinds)
      .sort((a, b) => b.confidenceScore - a.confidenceScore);
  }
}
