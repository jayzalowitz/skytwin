/**
 * Wiring for the draft-email candidate generator (#283).
 *
 * The generator is exported by `@skytwin/decision-engine` (#251 Phase 4)
 * and composed into `DecisionMaker.evaluate` via #295. This module is
 * the deploy gate — two flags must both be set for the generator to
 * actually build:
 *
 *   1. **Process-wide env var** `SKYTWIN_DRAFTS_ENABLED=true`. Acts as a
 *      global incident kill-switch — flipping it OFF disables the
 *      feature for everyone in one command without touching the DB.
 *   2. **Per-user `twin_profiles.drafts_enabled`** (#302). Defaults to
 *      FALSE so existing users are not auto-opted-in. Lets us stage
 *      rollout user-by-user once eval-bench thresholds (#301) clear.
 *
 * Effective state is `env_on AND per_user_on`. Either-side OFF → the
 * generator is null and the candidate path skips draft generation.
 *
 * Operational note: when both flags are set for a user, every email
 * signal that has `requiresResponse: true` triggers an LLM call. Cost
 * gating (#299) is still owed — without it, spend is bounded only by
 * the configured provider's per-token price and the inbound rate. Do
 * not flip the per-user flag on for any user until #299 ships.
 */

import {
  DraftEmailCandidateGenerator,
  type AuthoredExamplesPort,
  type CandidateGenerator,
} from '@skytwin/decision-engine';
import type { LlmClient } from '@skytwin/llm-client';
import { twinRepository } from '@skytwin/db';
import { getMemoryPortForUser } from './memory-setup.js';

/**
 * Whether the global kill-switch is set. Controlled by
 * `SKYTWIN_DRAFTS_ENABLED`. Defaults to `false` — the generator's code
 * paths are dead until an operator explicitly opts in.
 *
 * This is one of two gates; the other is `twin_profiles.drafts_enabled`
 * per-user (#302). Both must be true for `buildDraftEmailGenerator` to
 * return a non-null generator.
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

/**
 * Minimum number of hits to fetch even when `k` is tiny. If the caller
 * asks for k=1, fetching 3 hits and filtering to 1 user-authored result
 * is much more likely to find a match than fetching 1 hit and losing it
 * to a single inbox-tier collision. This is the floor `Math.max` should
 * have been guarding (Copilot caught the redundant-max).
 */
const MIN_FETCH_FLOOR = 6;

function buildAuthoredExamplesPort(userId: string): AuthoredExamplesPort {
  return {
    async searchAuthoredExamples(
      query: string,
      k: number,
    ): Promise<Array<{ content: string; subject?: string }>> {
      const resolved = await getMemoryPortForUser(userId);
      const overFetch = Math.max(k * OVER_FETCH_FACTOR, MIN_FETCH_FLOOR);
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
 * `null` when any of the four gates is unsatisfied:
 *
 *   1. Global env flag (`SKYTWIN_DRAFTS_ENABLED`) is off (incident kill).
 *   2. Per-user flag (`twin_profiles.drafts_enabled`) is off (staged
 *      rollout, default for new users).
 *   3. The user has no `LlmClient` configured (the generator's
 *      `llmClient.generate()` call has nothing to route to).
 *   4. The configured `LlmClient` has no providers (same root cause as
 *      #3; matches the route's primary-strategy `hasProviders` check).
 *
 * Callers compose the result alongside the rule-based / LLM candidate
 * strategy via `CompositeCandidateGenerator`. `null` short-circuits the
 * wiring entirely — no construction cost, no memory-port roundtrip —
 * so the default-off path adds nothing measurable to ingestion latency.
 *
 * The env-flag check is synchronous; the per-user check requires a DB
 * roundtrip. We do the cheap check first so the all-off case stays
 * roundtrip-free.
 */
export async function buildDraftEmailGenerator(
  userId: string,
  llmClient: LlmClient | null,
): Promise<CandidateGenerator | null> {
  if (!draftsEnabled()) return null;
  if (!llmClient || !llmClient.hasProviders) return null;
  // Per-user flag check (#302). FAIL-CLOSED: a user with no
  // twin_profiles row yet returns false here, so the feature only
  // engages after the profile exists AND the user has explicitly
  // opted in via dashboard/settings.
  const perUserEnabled = await twinRepository.isDraftsEnabled(userId);
  if (!perUserEnabled) return null;
  const examples = buildAuthoredExamplesPort(userId);
  return new DraftEmailCandidateGenerator(llmClient, examples);
}
