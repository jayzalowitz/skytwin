/**
 * Draft-email eval bench (#301).
 *
 * Quality gate that must clear before any user can have
 * `drafts_enabled = true`. Spends time / LLM calls measuring whether
 * the generator's drafts actually match the user's voice, length
 * distribution, and topical accuracy on a held-out corpus of past
 * (inbound, user-reply) pairs.
 *
 * Architecture in one paragraph: the bench is a pure scorer over a
 * supplied corpus of `EvalPair` rows. The caller loads the corpus
 * (typically a sample of inbound emails the user historically
 * replied to, paired with the actual sent reply) and supplies a
 * `generateDraft` callback for each pair. The bench then computes
 * three per-pair metrics (voice / topical / length), aggregates
 * them, and returns a pass/fail decision against documented
 * thresholds. No LLM-as-judge in v1 — topical accuracy uses a
 * jaccard-on-content-words surrogate (free and deterministic;
 * LLM-judge variant is a documented follow-up).
 *
 * Why not embedding cosine for voice. The issue suggests embedding
 * cosine as a first cut, but the decision-engine package doesn't
 * want to depend on `@skytwin/memory-port` for raw embeddings (it
 * doesn't expose an embed-only API today). Bigram-jaccard captures
 * the same "is this in my voice" signal at lower fidelity but with
 * zero infra cost. Migrating to embedding cosine when the memory
 * layer exposes an embed primitive is a clean swap.
 */

import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * One (inbound, user-reply) pair the bench scores against. The
 * `generatedDraft` is what the system WOULD have drafted for this
 * inbound — produced by the caller, not the bench. Decoupling
 * draft generation from scoring keeps the bench testable without
 * an LLM in the loop.
 */
export interface EvalPair {
  inboundSubject: string;
  inboundBody: string;
  inboundFrom: string;
  /** Ground truth — what the user actually sent. */
  actualReply: string;
  /** What the candidate generator produced. */
  generatedDraft: string;
}

/**
 * User-specific corpus statistics the bench uses for length
 * scoring. Computed by the caller from the user's broader sent
 * corpus (not just the eval pairs — the distribution should
 * reflect the user's typical replies, not the held-out ones).
 */
export interface UserReplyLengthStats {
  /** Mean reply length in characters. */
  meanChars: number;
  /** Sample standard deviation of reply length in characters. */
  stdDevChars: number;
}

export interface EvalThresholds {
  /**
   * Minimum voice jaccard a per-pair draft must reach. The issue
   * spec called for cosine ≥ 0.7 against embeddings; we use a
   * bigram-jaccard surrogate, which scores lower for the same
   * "in voice" judgment, so the threshold is correspondingly
   * lower. Tune after the first real run.
   */
  voiceJaccardMin: number;
  /**
   * Minimum topical jaccard a per-pair draft must reach. Looser
   * than voice because content-word overlap is noisier than
   * bigram overlap.
   */
  topicalJaccardMin: number;
  /**
   * Maximum |z-score| for length to pass — within N sigma of the
   * user's reply length distribution.
   */
  lengthSigmaMax: number;
  /**
   * Overall: what fraction of pairs must clear ALL three
   * thresholds for the run as a whole to pass.
   */
  overallPassRateMin: number;
}

export const DEFAULT_EVAL_THRESHOLDS: EvalThresholds = {
  voiceJaccardMin: 0.25,
  topicalJaccardMin: 0.3,
  lengthSigmaMax: 2,
  overallPassRateMin: 0.8,
};

export interface PairScore {
  voiceJaccard: number;
  topicalJaccard: number;
  lengthZScore: number;
  voicePassed: boolean;
  topicalPassed: boolean;
  lengthPassed: boolean;
  allPassed: boolean;
}

export interface EvalResult {
  corpusSize: number;
  voicePassRate: number;
  topicalPassRate: number;
  lengthPassRate: number;
  overallPassRate: number;
  passed: boolean;
  thresholds: EvalThresholds;
  notes: string;
  /** Per-pair scores for debugging / dashboard rendering. */
  pairs: PairScore[];
}

/**
 * Tokenize into lowercase word tokens. Strips punctuation, splits
 * on whitespace. Used by both bigram-jaccard (voice) and
 * content-word-jaccard (topical).
 */
function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'do', 'does', 'for', 'from', 'has', 'have', 'he', 'her', 'his',
  'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'no', 'not',
  'of', 'on', 'or', 'our', 'she', 'so', 'than', 'that', 'the',
  'their', 'them', 'there', 'these', 'they', 'this', 'to', 'too',
  'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will',
  'with', 'would', 'you', 'your', "i'm", "i've", "you're", "we're",
  "it's", "don't", "didn't", "can't", "won't",
]);

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    if (t.length < 3) continue;
    if (STOP_WORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function bigrams(text: string): Set<string> {
  const tokens = tokenize(text);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    out.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Score a single (draft, actual-reply) pair. Pure: same input,
 * same output. Exported for granular testing; most callers should
 * invoke `runEvalBench` which aggregates over a corpus.
 */
export function scorePair(
  pair: EvalPair,
  stats: UserReplyLengthStats,
  thresholds: EvalThresholds = DEFAULT_EVAL_THRESHOLDS,
): PairScore {
  // Voice: bigram-jaccard between draft and the user's actual
  // reply. (Higher fidelity would compare to the user's broader
  // sent corpus — kept simple here so the bench is testable
  // standalone.)
  const draftBigrams = bigrams(pair.generatedDraft);
  const replyBigrams = bigrams(pair.actualReply);
  const voiceJaccard = jaccard(draftBigrams, replyBigrams);

  // Topical: content-word jaccard. Strips stop words and short
  // tokens so "the" / "a" / "is" don't dominate the score.
  const draftContent = contentWords(pair.generatedDraft);
  const replyContent = contentWords(pair.actualReply);
  const topicalJaccard = jaccard(draftContent, replyContent);

  // Length: |z-score| of draft length against the user's reply
  // distribution. stddev=0 (rare) → exact match required.
  const draftChars = (pair.generatedDraft ?? '').length;
  const lengthZScore =
    stats.stdDevChars > 0
      ? Math.abs(draftChars - stats.meanChars) / stats.stdDevChars
      : draftChars === stats.meanChars
        ? 0
        : Infinity;

  const voicePassed = voiceJaccard >= thresholds.voiceJaccardMin;
  const topicalPassed = topicalJaccard >= thresholds.topicalJaccardMin;
  const lengthPassed = lengthZScore <= thresholds.lengthSigmaMax;

  return {
    voiceJaccard,
    topicalJaccard,
    lengthZScore,
    voicePassed,
    topicalPassed,
    lengthPassed,
    allPassed: voicePassed && topicalPassed && lengthPassed,
  };
}

/**
 * Run the bench over a corpus and return the aggregated result.
 * Pure: takes pre-generated drafts (in `EvalPair`s) and pre-computed
 * user stats; produces a deterministic result.
 *
 * The caller is responsible for:
 *   - Building `EvalPair` rows from gmail history
 *   - Computing `UserReplyLengthStats` from the user's broader
 *     sent corpus
 *   - Generating each `pair.generatedDraft` via
 *     `DraftEmailCandidateGenerator` (or any other generator
 *     implementation under test)
 *
 * `passed` is the gate decision: true means the run cleared all
 * thresholds and the user is eligible to have `drafts_enabled`
 * flipped on (subject to operator confirmation).
 */
export function runEvalBench(
  pairs: EvalPair[],
  stats: UserReplyLengthStats,
  thresholds: EvalThresholds = DEFAULT_EVAL_THRESHOLDS,
): EvalResult {
  if (pairs.length === 0) {
    return {
      corpusSize: 0,
      voicePassRate: 0,
      topicalPassRate: 0,
      lengthPassRate: 0,
      overallPassRate: 0,
      passed: false,
      thresholds,
      notes: 'Empty corpus — refusing to grade. Need at least one (inbound, reply) pair.',
      pairs: [],
    };
  }

  const scores = pairs.map((p) => scorePair(p, stats, thresholds));
  const total = scores.length;
  const voicePass = scores.filter((s) => s.voicePassed).length;
  const topicalPass = scores.filter((s) => s.topicalPassed).length;
  const lengthPass = scores.filter((s) => s.lengthPassed).length;
  const allPass = scores.filter((s) => s.allPassed).length;

  const voicePassRate = voicePass / total;
  const topicalPassRate = topicalPass / total;
  const lengthPassRate = lengthPass / total;
  const overallPassRate = allPass / total;

  const passed =
    overallPassRate >= thresholds.overallPassRateMin &&
    voicePassRate >= thresholds.overallPassRateMin &&
    topicalPassRate >= thresholds.overallPassRateMin &&
    lengthPassRate >= thresholds.overallPassRateMin;

  const failingMetrics: string[] = [];
  if (voicePassRate < thresholds.overallPassRateMin) failingMetrics.push('voice');
  if (topicalPassRate < thresholds.overallPassRateMin) failingMetrics.push('topical');
  if (lengthPassRate < thresholds.overallPassRateMin) failingMetrics.push('length');
  if (overallPassRate < thresholds.overallPassRateMin) failingMetrics.push('overall');

  const notes = passed
    ? `Passed all thresholds across ${total} pairs.`
    : `Failed: ${failingMetrics.join(', ')} below ${thresholds.overallPassRateMin}. ` +
      `Voice ${(voicePassRate * 100).toFixed(0)}%, topical ${(topicalPassRate * 100).toFixed(0)}%, ` +
      `length ${(lengthPassRate * 100).toFixed(0)}%, overall ${(overallPassRate * 100).toFixed(0)}%.`;

  return {
    corpusSize: total,
    voicePassRate,
    topicalPassRate,
    lengthPassRate,
    overallPassRate,
    passed,
    thresholds,
    notes,
    pairs: scores,
  };
}

/**
 * Confidence the bench reports for downstream auto-decisions
 * (e.g. "should the dashboard offer to flip drafts_enabled on?").
 * Threshold-pass = HIGH; close-to-pass = MODERATE; not close = LOW.
 */
export function evalResultConfidence(result: EvalResult): ConfidenceLevel {
  if (result.passed) return ConfidenceLevel.HIGH;
  // Within 10pp of pass on overall rate → moderate
  if (result.overallPassRate >= result.thresholds.overallPassRateMin - 0.1) {
    return ConfidenceLevel.MODERATE;
  }
  return ConfidenceLevel.LOW;
}
