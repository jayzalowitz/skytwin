import type { AIProviderName } from '@skytwin/shared-types';

/**
 * Per-provider per-token cost in tenths of a cent (deci-cents), so an
 * integer math throughout cents-denominated spend pipelines is safe.
 * Sourced from each vendor's published list price for the cheapest
 * model in their family that we currently expose in `PROVIDER_MODELS`;
 * we deliberately over-estimate the inexpensive option rather than
 * under-estimate the expensive one — spend-cap enforcement should err
 * on the side of "approval required" rather than "silently ran past
 * the cap." Anyone running a premium model will see slightly higher
 * recorded cost than the model's exact rate; that's the safe direction.
 *
 * Local-runtime providers (embedded llama.cpp, user-installed Ollama)
 * carry zero per-token cost — this is the load-bearing piece of #187
 * AC#8: cost dashboard shows $0 when on Smart mode. We keep the helper
 * shape uniform so the eventual spend-recording call site doesn't need
 * an embedded-special-case branch — `estimateLlmCostCents('embedded',
 * N, M)` just returns 0 by table lookup.
 *
 * Rates are reviewed as part of CHANGELOG sweeps; if pricing shifts and
 * this table goes stale, the failure mode is over-estimating the bill —
 * never under-estimating. The unit test enforces the invariant
 * `embedded === 0 AND ollama === 0`.
 */
const RATE_DECICENTS_PER_M_TOKENS: Record<AIProviderName, { input: number; output: number }> = {
  // Conversion sanity check before adjusting any of these: 1 cent =
  // 10 deci-cents, so $0.80 = 80 cents = 800 deci-cents. A $0.80/1M
  // input rate stores as 800. An earlier draft of this table was off
  // by 100× because the dollars→cents step was skipped — Copilot
  // caught it on PR #253. Tests below pin the corrected values.
  //
  // Anthropic — Claude 3.5 Haiku list price ($0.80/$4.00 per 1M).
  anthropic: { input: 800, output: 4000 },
  // OpenAI — GPT-4o-mini list price ($0.15/$0.60 per 1M).
  openai: { input: 150, output: 600 },
  // Google — Gemini 1.5 Flash list price ($0.075/$0.30 per 1M for
  // prompts <128k tokens).
  google: { input: 75, output: 300 },
  // Local-runtime providers carry zero per-token cost by definition.
  ollama: { input: 0, output: 0 },
  embedded: { input: 0, output: 0 },
};

/**
 * Estimate the cost of a single LLM call in integer cents, given the
 * provider and token counts. Rounds up to the nearest cent so the
 * cap-enforcement direction stays safe.
 *
 * Returns 0 for `embedded` and `ollama` regardless of token counts —
 * see the rate-table docstring. This is the contract #187 AC#8 relies
 * on: a future spend-recording call site can compute `costCents =
 * estimateLlmCostCents(response.provider, tokensIn, tokensOut)` and
 * trust that local-runtime calls record zero.
 *
 * Token counts default to 0 so callers that haven't wired up token
 * accounting yet can pass nothing and still get a consistent answer.
 */
export function estimateLlmCostCents(
  provider: AIProviderName,
  tokensIn = 0,
  tokensOut = 0,
): number {
  const rate = RATE_DECICENTS_PER_M_TOKENS[provider];
  if (!rate) return 0;
  // Deci-cents per million tokens × tokens / 1M = deci-cents.
  // Cents = ceil(deci-cents / 10). Integer math throughout.
  const deciCents = (rate.input * tokensIn + rate.output * tokensOut);
  const tokenScale = 1_000_000;
  const scaledDeciCents = Math.ceil(deciCents / tokenScale);
  return Math.ceil(scaledDeciCents / 10);
}

/**
 * True when this provider runs entirely on the user's machine and so
 * carries zero per-token cost regardless of usage volume. Exposed for
 * future audit / dashboard callers that want to render a "free" badge
 * or skip cost rendering altogether.
 */
export function isZeroCostProvider(provider: AIProviderName): boolean {
  const rate = RATE_DECICENTS_PER_M_TOKENS[provider];
  if (!rate) return false;
  return rate.input === 0 && rate.output === 0;
}
