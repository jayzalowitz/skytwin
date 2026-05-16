/**
 * Dark-deploy wiring for the draft-email candidate generator (#283).
 *
 * The generator is exported by `@skytwin/decision-engine` (#251 Phase 4)
 * but was NOT wired into `DecisionMaker.evaluate` at landing time — the
 * deploy decision is a separate concern from the engine. This module is
 * the deploy decision, gated by an env flag so the wiring lands now but
 * stays off until the rest of #283 (cost gating, real
 * `AuthoredExamplesPort` with SQL pushdown, eval bench, per-user feature
 * flag, approval-UI surface) ships.
 *
 * Operational note: when this is flipped on, every email signal that
 * `requiresResponse: true` triggers an LLM call. With no cost gating yet,
 * cost is bounded only by the configured provider's per-token price and
 * the inbound email rate — verify a per-user spend cap is in place before
 * enabling for any user.
 */

import {
  DraftEmailCandidateGenerator,
  type AuthoredExamplesPort,
  type CandidateGenerator,
} from '@skytwin/decision-engine';
import type { LlmClient } from '@skytwin/llm-client';
import { getMemoryPortForUser } from './memory-setup.js';

/**
 * Whether the dark wiring is active.
 *
 * Controlled by `SKYTWIN_DRAFTS_ENABLED`. Defaults to `false` — the
 * generator's code paths are dead until an operator explicitly opts in.
 * Per-user gating (sub-issue 4 of #283) is a follow-up; today it's a
 * single process-wide knob.
 */
export function draftsEnabled(): boolean {
  return process.env['SKYTWIN_DRAFTS_ENABLED'] === 'true';
}

/**
 * Authoring-tier values that mark "the user wrote this." A draft is
 * grounded in the user's own voice, so only their sent / replied corpus
 * counts — inbox tiers are noise.
 */
const USER_AUTHORED_TIERS = new Set(['user_sent_originated', 'user_sent_reply']);

/**
 * Memory-port-backed implementation of the generator's
 * `AuthoredExamplesPort`. Filters semantic hits client-side to the
 * user-authored authoring tiers stamped on `brain_pages.metadata`.
 *
 * Limitation (sub-issue 2 of #283): the filter is client-side. The port
 * fetches `k * OVER_FETCH_FACTOR` hits and then narrows, which works fine
 * for typical k (≤ 10) but doesn't scale to high-k or noisy corpora.
 * Pushdown into the SQL hybrid-rank query is the follow-up.
 */
const OVER_FETCH_FACTOR = 3;

function buildAuthoredExamplesPort(userId: string): AuthoredExamplesPort {
  return {
    async searchAuthoredExamples(
      query: string,
      k: number,
    ): Promise<Array<{ content: string; subject?: string }>> {
      const resolved = await getMemoryPortForUser(userId);
      const overFetch = Math.max(k * OVER_FETCH_FACTOR, k);
      const hits = await resolved.port.searchSemantic(query, overFetch);
      const authored = hits
        .filter((hit) => {
          const tier =
            hit.metadata && typeof hit.metadata['authoringTier'] === 'string'
              ? (hit.metadata['authoringTier'] as string)
              : null;
          return tier !== null && USER_AUTHORED_TIERS.has(tier);
        })
        .slice(0, k);
      return authored.map((hit) => {
        const subject =
          hit.metadata && typeof hit.metadata['subject'] === 'string'
            ? (hit.metadata['subject'] as string)
            : undefined;
        return subject ? { content: hit.content, subject } : { content: hit.content };
      });
    },
  };
}

/**
 * Build a draft-email candidate generator for the given user, or return
 * `null` when the dark flag is off or the user has no configured LLM
 * client. Callers compose the result alongside the rule-based / LLM
 * candidate strategy via `CompositeCandidateGenerator`.
 *
 * `null` short-circuits the wiring entirely — no construction cost, no
 * memory-port roundtrip — so the default-off path adds nothing measurable
 * to ingestion latency.
 */
export function buildDraftEmailGenerator(
  userId: string,
  llmClient: LlmClient | null,
): CandidateGenerator | null {
  if (!draftsEnabled()) return null;
  if (!llmClient) return null;
  const examples = buildAuthoredExamplesPort(userId);
  return new DraftEmailCandidateGenerator(llmClient, examples);
}
