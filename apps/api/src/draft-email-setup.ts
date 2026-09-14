/**
 * Wiring for the draft-email candidate generator (#283).
 *
 * The generator is exported by `@skytwin/decision-engine` (#251 Phase 4)
 * and composed into `DecisionMaker.evaluate` via #295. This module is
 * the deploy gate — FIVE gates must all be satisfied for the generator
 * to actually build, defense-in-depth against accidental rollouts:
 *
 *   1. **Process-wide env var** `SKYTWIN_DRAFTS_ENABLED=true`. Acts as a
 *      global incident kill-switch — flipping it OFF disables the
 *      feature for everyone in one command without touching the DB.
 *   2. **`LlmClient` is non-null AND `hasProviders`.** The generator's
 *      `llmClient.generate()` call needs somewhere to route. Synchronous
 *      checks; short-circuit before any DB roundtrip.
 *   3. **Per-user `twin_profiles.drafts_enabled`** (#302). Defaults to
 *      FALSE so existing users are not auto-opted-in. Lets us stage
 *      rollout user-by-user.
 *   4. **Per-user `twin_profiles.drafts_eval_passed_at`** (#301 + #314).
 *      NULL until the user's eval-bench run clears all thresholds
 *      (voice / topical / length / corpus-size). Quality gate on top
 *      of the opt-in: "the generator produces drafts you would actually
 *      send" must be proven on a held-out corpus before the feature
 *      can fire for the user, even if they've manually opted in.
 *   5. **Cost-gate construction succeeds** (#299). Per-day call cap +
 *      per-day spend cap + provider-aware cost estimate.
 *
 * Order matters for perf: the env flag and LlmClient checks are
 * synchronous and short-circuit before any DB query. The two per-user
 * DB reads then run before construction work begins, so a user not
 * yet eval-passed costs at most one extra single-column SELECT per
 * signal ingest. All DB reads fail-closed: a transient error treats
 * the gate as off, so `/api/events/ingest` never rejects.
 */

import {
  DraftEmailCandidateGenerator,
  type AuthoredExamplesPort,
  type CandidateGenerator,
  type CostGatePort,
} from '@skytwin/decision-engine';
import {
  isPricingUsableForUnattended,
  type LlmClient,
} from '@skytwin/llm-client';
import type { ProviderPricingCapability } from '@skytwin/shared-types';
import { twinRepository } from '@skytwin/db';
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
 * counts — inbox tiers are noise. Passed straight to `searchSemantic`
 * as a SQL-pushed filter (#300) — the CRDB adapter narrows in the
 * `WHERE metadata->>'authoringTier' = ANY($N)` clause of both the text
 * and vector legs of the RRF fold, so we no longer over-fetch.
 */
const USER_AUTHORED_TIERS: readonly string[] = ['user_sent_originated', 'user_sent_reply'];

function buildAuthoredExamplesPort(userId: string): AuthoredExamplesPort {
  return {
    async searchAuthoredExamples(
      query: string,
      k: number,
    ): Promise<Array<{ content: string; subject?: string }>> {
      const resolved = await getMemoryPortForUser(userId);
      const hits = await resolved.port.searchSemantic(query, k, {
        // `SearchSemanticOptions.authoringTier` accepts `readonly string[]`,
        // so we pass the module-scope const tuple directly — no spread.
        authoringTier: USER_AUTHORED_TIERS,
      });
      return hits.map((hit) => {
        const subject =
          hit.metadata && typeof hit.metadata['subject'] === 'string'
            ? (hit.metadata['subject'] as string)
            : undefined;
        return subject ? { content: hit.content, subject } : { content: hit.content };
      });
    },
  };
}

const DRAFT_INPUT_TOKEN_BUDGET = 2_000;
const DRAFT_OUTPUT_TOKEN_BUDGET = 1_000;
const NANO_USD_PER_CENT = 10_000_000;

function upperBoundCostCents(pricing: ProviderPricingCapability, nowMs: number): number | null {
  if (pricing.kind === 'zero') return 0;
  if (pricing.kind === 'unknown') return null;
  if (!isPricingUsableForUnattended(pricing, nowMs)) return null;
  const input = pricing.inputNanoUsdPerMillionTokens;
  const output = pricing.outputNanoUsdPerMillionTokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) {
    return null;
  }
  const nanoUsd = (input * DRAFT_INPUT_TOKEN_BUDGET + output * DRAFT_OUTPUT_TOKEN_BUDGET)
    / 1_000_000;
  return Math.ceil(nanoUsd / NANO_USD_PER_CENT);
}

/**
 * Resolve (a) whether the first provider in the user's chain is a
 * local / zero-cost provider, and (b) the conservative cost estimate
 * to pass to the cost gate. Pricing comes from the LlmClient's exact frozen,
 * mode-admitted chain so it cannot race a second provider-settings read.
 */
function resolveDraftCostShape(llmClient: LlmClient, userId: string): {
  firstProvider: string;
  estimatedCostCents: number;
} | null {
  try {
    const providers = llmClient.getProviderPricingSnapshot();
    if (providers.length === 0) {
      return null;
    }
    let upperBound = 0;
    const nowMs = Date.now();
    for (const provider of providers) {
      const estimate = upperBoundCostCents(provider.pricing, nowMs);
      // Any provider in the fallback chain may serve the request. A
      // single unknown/stale/unbounded price therefore blocks unattended
      // generation instead of relying on which provider happens to answer.
      if (estimate === null) return null;
      upperBound = Math.max(upperBound, estimate);
    }
    return { firstProvider: providers[0]!.provider, estimatedCostCents: upperBound };
  } catch (err) {
    log.warn('Failed to establish AI-provider price; disabling unattended draft generation', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Build a draft-email candidate generator for the given user, or return
 * `null` when any of the FIVE gates is unsatisfied. See the file
 * docstring for the full list. Synopsis:
 *
 *   1. Env flag — incident kill-switch.
 *   2. LlmClient + hasProviders — synchronous; somewhere to route to.
 *   3. Per-user `drafts_enabled` (#302) — staged rollout opt-in.
 *   4. Per-user `drafts_eval_passed_at` (#301 + #314) — quality gate.
 *   5. Cost gate (#299) — construction-time only; per-call gates run
 *      inside `generate()`.
 *
 * Callers compose the result alongside the rule-based / LLM candidate
 * strategy via `CompositeCandidateGenerator`. `null` short-circuits the
 * wiring entirely — no construction cost, no memory-port roundtrip —
 * so the default-off path adds nothing measurable to ingestion latency.
 *
 * The env-flag and LlmClient checks are synchronous; the per-user
 * checks each require a DB roundtrip. We do the cheap checks first so
 * the all-off case stays roundtrip-free. The two DB reads (3 then 4)
 * are sequential, not parallel — once gate 3 short-circuits we don't
 * need gate 4, which keeps the staged-rollout cohort (the vast
 * majority of users) at exactly one extra read.
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

  // Per-user eval-bench gate (#301 + #314). The user must have at
  // least one passing eval-bench run before the generator is allowed
  // to construct. `drafts_eval_passed_at` is stamped by
  // `draftEmailEvalRunsRepository.recordRun` when a run clears all
  // metric thresholds (voice / topical / length) AND the
  // corpus-size floor. Same fail-closed contract as the per-user
  // flag — a DB hiccup here can't take down `/api/events/ingest`.
  //
  // This is the QUALITY gate on top of the OPT-IN gate. A user can
  // manually flip `drafts_enabled` but still be locked out if their
  // eval bench hasn't passed — preventing the "sounds plausible"
  // failure mode where a generator produces drafts that don't match
  // the user's voice / topic / length distribution well enough to
  // be useful.
  let evalPassed = false;
  try {
    evalPassed = await twinRepository.isDraftsEvalPassed(userId);
  } catch (err) {
    log.warn('Draft-email eval-bench gate read failed; treating as off (fail-closed)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!evalPassed) return null;

  const examples = buildAuthoredExamplesPort(userId);
  // Cost-gate wiring (#299). The optional override exists for tests;
  // production callers leave it undefined and get a `DbCostGate`.
  const gate = costGate ?? new DbCostGate();
  const costShape = resolveDraftCostShape(llmClient, userId);
  if (!costShape) return null;
  const { firstProvider, estimatedCostCents } = costShape;
  return new DraftEmailCandidateGenerator(llmClient, examples, {
    costGate: gate,
    estimatedCostCents,
    provider: firstProvider,
  });
}
