/**
 * Parsing of persisted per-user autonomy settings.
 *
 * `users.autonomy_settings` is a JSONB column, so everything that reads it
 * has to narrow `unknown` into {@link AutonomySettings}. Before this module
 * there were two divergent hand-rolled readers — one in
 * `apps/api/src/cost-gate.ts` and one in
 * `apps/worker/src/jobs/memory-action-loop.ts` — and the API one silently
 * dropped `paused` / `pausedAt` / `pausedReason` and the quiet-hours window
 * while building its object literal. Any caller using it therefore handed
 * the policy evaluator a settings object where the user's pause kill switch
 * (#379) and quiet hours were structurally invisible, no matter what the
 * user had saved.
 *
 * One parser, one set of conservative defaults, every field carried.
 */
import type { AutonomySettings, PerAppOverride } from './user.js';

/**
 * Fallback used when a user has no `autonomy_settings` row content, or the
 * stored value is not an object.
 *
 * Deliberately conservative: zero spend caps mean every cost-bearing action
 * is refused rather than silently auto-spending, and irreversible actions
 * require approval. Zero-cost actions still pass the spend check.
 */
export const CONSERVATIVE_AUTONOMY_DEFAULTS: AutonomySettings = Object.freeze({
  maxSpendPerActionCents: 0,
  maxDailySpendCents: 0,
  allowedDomains: [],
  blockedDomains: [],
  requireApprovalForIrreversible: true,
});

/**
 * A domain that cannot match any real domain, used to keep a malformed
 * allowlist fail-CLOSED. See {@link parseAllowlist}.
 */
export const UNMATCHABLE_DOMAIN = '\u0000invalid-domain';

/**
 * Narrow a raw `allowedDomains` value, failing CLOSED.
 *
 * The allowlist is polarity-sensitive: `PolicyEvaluator.checkDomainAllowlist`
 * treats a NON-empty list as "the domain must appear in it" and an EMPTY list
 * as "every domain is allowed". So naively filtering non-strings out is a
 * privilege escalation — `allowedDomains: [42]` used to deny everything (no
 * string domain can equal `42`), and filtering it to `[]` would silently turn
 * that into "allow every domain".
 *
 * When the raw list had entries but none survive narrowing, we keep one
 * unmatchable entry so the list stays non-empty and continues to deny. A
 * partially-malformed list (`['ok.com', 42]`) narrows to `['ok.com']`, which
 * matches the old behaviour exactly.
 *
 * `blockedDomains` needs no equivalent: there, empty means "block nothing",
 * which is already the conservative default, so dropping junk entries cannot
 * widen anything.
 */
function parseAllowlist(raw: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const strings = (raw as unknown[]).filter(
    (d): d is string => typeof d === 'string',
  );
  if (strings.length === 0 && raw.length > 0) return [UNMATCHABLE_DOMAIN];
  return strings;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Narrow a raw JSONB value into {@link AutonomySettings}.
 *
 * Every field on the interface is carried through — in particular the
 * `paused*` kill-switch trio and the quiet-hours window, which the policy
 * evaluator gates real escalations on. Unknown / malformed fields fall back
 * to `fallback` (conservative by default) rather than being dropped.
 *
 * @param raw The value read from `users.autonomy_settings`.
 * @param fallback Defaults for absent or malformed fields.
 */
export function parseAutonomySettings(
  raw: unknown,
  fallback: AutonomySettings = CONSERVATIVE_AUTONOMY_DEFAULTS,
): AutonomySettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // Copy the arrays too: a shallow spread would hand every caller the same
    // `allowedDomains` / `blockedDomains` instances, so one caller mutating
    // its result would silently rewrite another user's domain lists.
    return {
      ...fallback,
      allowedDomains: [...fallback.allowedDomains],
      blockedDomains: [...fallback.blockedDomains],
    };
  }
  const r = raw as Record<string, unknown>;

  const settings: AutonomySettings = {
    maxSpendPerActionCents:
      typeof r['maxSpendPerActionCents'] === 'number'
        ? r['maxSpendPerActionCents']
        : fallback.maxSpendPerActionCents,
    maxDailySpendCents:
      typeof r['maxDailySpendCents'] === 'number'
        ? r['maxDailySpendCents']
        : fallback.maxDailySpendCents,
    allowedDomains: parseAllowlist(r['allowedDomains'], fallback.allowedDomains),
    blockedDomains: Array.isArray(r['blockedDomains'])
      ? (r['blockedDomains'] as unknown[]).filter(
          (d): d is string => typeof d === 'string',
        )
      : [...fallback.blockedDomains],
    requireApprovalForIrreversible:
      typeof r['requireApprovalForIrreversible'] === 'boolean'
        ? r['requireApprovalForIrreversible']
        : fallback.requireApprovalForIrreversible,
  };

  // Quiet hours (optional window). Both ends must be present for the
  // evaluator to apply the window, but we carry whatever is stored so the
  // settings UI round-trips faithfully.
  const quietHoursStart = optionalString(r['quietHoursStart']) ?? fallback.quietHoursStart;
  const quietHoursEnd = optionalString(r['quietHoursEnd']) ?? fallback.quietHoursEnd;
  if (quietHoursStart !== undefined) settings.quietHoursStart = quietHoursStart;
  if (quietHoursEnd !== undefined) settings.quietHoursEnd = quietHoursEnd;

  // Kill switch (#379). The whole point of the pause toggle is that it
  // reaches `PolicyEvaluator.evaluate`; dropping it here makes the switch
  // decorative.
  const paused =
    typeof r['paused'] === 'boolean' ? r['paused'] : fallback.paused;
  const pausedAt = optionalString(r['pausedAt']) ?? fallback.pausedAt;
  const pausedReason = optionalString(r['pausedReason']) ?? fallback.pausedReason;
  if (paused !== undefined) settings.paused = paused;
  if (pausedAt !== undefined) settings.pausedAt = pausedAt;
  if (pausedReason !== undefined) settings.pausedReason = pausedReason;

  const overrides = r['perAppOverrides'];
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    settings.perAppOverrides = overrides as Record<string, PerAppOverride>;
  } else if (fallback.perAppOverrides) {
    settings.perAppOverrides = fallback.perAppOverrides;
  }

  return settings;
}
