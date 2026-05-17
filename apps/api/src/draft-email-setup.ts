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
  type CostGatePort,
} from '@skytwin/decision-engine';
import type { LlmClient } from '@skytwin/llm-client';
import { aiProviderRepository, twinRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import { getMemoryPortForUser } from './memory-setup.js';
import { DbCostGate } from './cost-gate.js';

const log = createLogger('api:draft-email-setup');

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
 * Cost-rank a provider for the draft-email feature (#299). Lower is
 * cheaper / preferred. Embedded and Ollama are local (no per-token
 * cost) so they rank first; the cloud providers stay in their normal
 * priority order behind them.
 *
 * This estimate drives the value passed to the cost gate's spend
 * check — the gate combines it with the user's running daily spend
 * to decide whether to allow this call. Conservative: if we can't
 * determine the first provider, we assume the most expensive case.
 */
const PROVIDER_COST_RANK: Record<string, number> = {
  embedded: 0,
  ollama: 0,
  google: 1,
  anthropic: 2,
  openai: 2,
};

/**
 * Conservative per-call cost estimate (cents) for a cloud-provider
 * draft generation. Based on roughly 2k input tokens + 1k output
 * tokens at Anthropic Sonnet rates ($3/MTok in, $15/MTok out) ≈
 * $0.021 ≈ 2 cents, rounded UP to 5 to leave headroom for prompt
 * growth (more authored examples, longer inbound bodies). Embedded
 * and Ollama get estimated as 0 cents.
 *
 * This is a starting point — refine after #301 (eval bench) measures
 * actual cost-per-draft against the eval corpus.
 */
const CLOUD_PROVIDER_ESTIMATED_COST_CENTS = 5;

/**
 * Resolve (a) whether the first provider in the user's chain is a
 * local / zero-cost provider, and (b) the conservative cost estimate
 * to pass to the cost gate. Wraps `aiProviderRepository.getEnabledForUser`
 * with a fail-safe-toward-restrictive default — if the query fails,
 * we assume the worst case (cloud provider, non-zero cost).
 */
async function resolveDraftCostShape(userId: string): Promise<{
  firstProvider: string;
  estimatedCostCents: number;
}> {
  try {
    const rows = await aiProviderRepository.getEnabledForUser(userId);
    if (rows.length === 0) {
      return { firstProvider: 'unknown', estimatedCostCents: CLOUD_PROVIDER_ESTIMATED_COST_CENTS };
    }
    // Pick the cost-cheapest provider that the user has enabled. This
    // is a draft-email-specific bias — the user's main `priority`
    // column controls primary-strategy ordering elsewhere. Cost-prefer
    // here even when the user's primary priority puts cloud first;
    // the user opted into draft-email's per-user cap and accepts the
    // implication that we should pick the cheapest viable path.
    const sorted = [...rows].sort((a, b) => {
      const ra = PROVIDER_COST_RANK[a.provider] ?? 3;
      const rb = PROVIDER_COST_RANK[b.provider] ?? 3;
      return ra - rb;
    });
    const first = sorted[0]!.provider;
    const isFree = first === 'embedded' || first === 'ollama';
    return {
      firstProvider: first,
      estimatedCostCents: isFree ? 0 : CLOUD_PROVIDER_ESTIMATED_COST_CENTS,
    };
  } catch (err) {
    log.warn('Failed to read AI providers for draft cost estimate; assuming cloud-cost', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { firstProvider: 'unknown', estimatedCostCents: CLOUD_PROVIDER_ESTIMATED_COST_CENTS };
  }
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
 *
 * Cost gating (#299) wires here. When all four gates pass, the
 * generator is constructed with a `DbCostGate` plus a conservative
 * per-call cost estimate derived from the user's cheapest enabled
 * provider. Per-call AND per-day spend limits both apply.
 */
export async function buildDraftEmailGenerator(
  userId: string,
  llmClient: LlmClient | null,
  costGate?: CostGatePort,
): Promise<CandidateGenerator | null> {
  if (!draftsEnabled()) return null;
  if (!llmClient || !llmClient.hasProviders) return null;
  // Per-user flag check (#302). FAIL-CLOSED on every failure mode:
  //
  //   - User has no `twin_profiles` row yet → returns false (handled by
  //     the repo: empty SELECT → falsy default).
  //   - DB unreachable, query timeout, or column missing during a
  //     migration rollout → we MUST NOT propagate the error. The
  //     events.ts route depends on this function to never reject, so
  //     a transient DB hiccup here can't be allowed to fail
  //     `/api/events/ingest` — that would take down signal ingestion
  //     for every LLM-configured user just because an optional opt-in
  //     read failed. Catch, log once, and treat as "feature off" —
  //     the same outcome the disabled state lands on.
  //
  // Caching the per-user boolean (with invalidation from
  // `setDraftsEnabled`) would avoid one DB roundtrip per signal-ingest
  // for the eligible cohort. Left as a follow-up — the read is a
  // single-column SELECT on a unique-indexed column, so latency is
  // bounded even without a cache.
  let perUserEnabled = false;
  try {
    perUserEnabled = await twinRepository.isDraftsEnabled(userId);
  } catch (err) {
    log.warn('Draft-email per-user flag read failed; treating as off (fail-closed)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!perUserEnabled) return null;

  const examples = buildAuthoredExamplesPort(userId);
  // Cost-gate wiring (#299). The optional override exists for tests;
  // production callers leave it undefined and get a `DbCostGate`.
  const gate = costGate ?? new DbCostGate();
  const { firstProvider, estimatedCostCents } = await resolveDraftCostShape(userId);
  return new DraftEmailCandidateGenerator(llmClient, examples, {
    costGate: gate,
    estimatedCostCents,
    provider: firstProvider,
  });
}
