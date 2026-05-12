import { createLogger } from '@skytwin/core';
import { briefingRepository, appSuggestionRepository, lifebookRepository, mcpServerRepository, query } from '@skytwin/db';
import { runPrompt } from '@skytwin/policy-prompts';
import type { LlmClient } from '@skytwin/llm-client';

const log = createLogger('worker:briefing-generator');

/**
 * Generates daily and weekly twin briefings for all active users.
 *
 * H: briefing-prose — when an llmClient is provided, the prose is generated
 * via the briefing-prose prompt instead of the deterministic Markdown template.
 * Falls back to the template on any prompt error or when no LLM is configured.
 *
 * Cadence:
 *   - daily: 7am user-local time
 *   - weekly: Sunday morning
 *
 * TODO: Wire into apps/worker/src/index.ts once cron infrastructure lands:
 *
 *   if (shouldRunDaily()) {
 *     await runBriefingGeneratorJob({ cadence: 'daily' }).catch(
 *       (err) => log.error('Briefing generator failed', { error: err.message }),
 *     );
 *   }
 *   if (isSundayMorning() && shouldRunWeekly()) {
 *     await runBriefingGeneratorJob({ cadence: 'weekly' }).catch(
 *       (err) => log.error('Weekly briefing generator failed', { error: err.message }),
 *     );
 *   }
 */

export interface BriefingGeneratorJobDeps {
  cadence?: 'daily' | 'weekly';
  /** Overrides the "active users" query — for testing. */
  userIds?: string[];
  /** Optional LlmClient for the adaptive briefing-prose path */
  llmClient?: LlmClient;
}

/**
 * Active users who have installed at least one MCP server.
 *
 * Keyset pagination on `user_id` — OFFSET pagination would scan/skip
 * earlier rows on every page, so the job's runtime grows quadratically
 * with the user count. Keyset stays linear: each page filters
 * `user_id > $last`, which the (user_id, status) index can serve as a
 * range scan.
 */
const BRIEFING_USER_PAGE_SIZE = 500;

async function getActiveUserIds(): Promise<string[]> {
  const allIds: string[] = [];
  let lastSeen: string | null = null;
  for (;;) {
    const sql: string = lastSeen === null
      ? `SELECT DISTINCT user_id
         FROM mcp_servers
         WHERE status IN ('active', 'installed', 'authorized')
         ORDER BY user_id
         LIMIT $1`
      : `SELECT DISTINCT user_id
         FROM mcp_servers
         WHERE status IN ('active', 'installed', 'authorized')
           AND user_id > $2
         ORDER BY user_id
         LIMIT $1`;
    const params: (string | number)[] = lastSeen === null
      ? [BRIEFING_USER_PAGE_SIZE]
      : [BRIEFING_USER_PAGE_SIZE, lastSeen];
    const result: { rows: Array<{ user_id: string }> } = await query<{ user_id: string }>(sql, params);
    if (result.rows.length === 0) break;
    for (const row of result.rows) allIds.push(row.user_id);
    if (result.rows.length < BRIEFING_USER_PAGE_SIZE) break;
    lastSeen = result.rows[result.rows.length - 1]!.user_id;
  }
  return allIds;
}

/**
 * Gather the source data for a user's briefing.
 * Shared between the adaptive and deterministic paths.
 */
async function gatherBriefingData(userId: string, cadence: 'daily' | 'weekly') {
  const [suggestions, allServers] = await Promise.all([
    appSuggestionRepository.getPendingForUser(userId),
    mcpServerRepository.listForUser(userId),
  ]);

  const active = allServers.filter(
    (s) => s.status === 'active' || s.status === 'installed' || s.status === 'authorized',
  );
  const dormant = allServers.filter((s) => s.status === 'dormant' || s.status === 'paused');

  const lookbackMs = cadence === 'daily' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - lookbackMs);
  const recentlyInstalled = active.filter((s) => s.installed_at && s.installed_at > since);

  const promotionResult = await query<{ payload: unknown; occurred_at: Date; server_id: string | null }>(
    `SELECT payload, occurred_at, server_id
     FROM capability_provenance_nodes
     WHERE user_id = $1 AND node_type = 'tier_promotion' AND occurred_at > $2
     ORDER BY occurred_at DESC`,
    [userId, since],
  );

  // Pre-compute server_id → registry_id so filterDataByLifebook can
  // map tier-promotion rows (which carry server_id but not registry_id
  // in the payload) to their owning lifebook. Copilot round-2 on #258
  // flagged that the previous filter checked payload.registryId, which
  // tier_promotion never sets — so promotions were always dropped from
  // per-Lifebook briefings.
  const serverIdToRegistry = new Map<string, string>();
  for (const s of allServers) {
    if (s.registry_id) serverIdToRegistry.set(s.id, s.registry_id);
  }

  return { suggestions, active, dormant, recentlyInstalled, promotionResult, serverIdToRegistry, since };
}

/**
 * Deterministic Markdown template (v1 fallback).
 */
function buildTemplatedProse(
  cadence: 'daily' | 'weekly',
  data: Awaited<ReturnType<typeof gatherBriefingData>>,
): string {
  const { suggestions, active, dormant, recentlyInstalled, promotionResult } = data;
  const lines: string[] = [];

  if (cadence === 'daily') {
    lines.push(`## Your daily twin briefing`);
    lines.push('');
    lines.push(`Here is a summary of what your twin has been up to in the past 24 hours.`);
  } else {
    lines.push(`## Your weekly twin briefing`);
    lines.push('');
    lines.push(`Here is a summary of your twin's activity over the past week.`);
  }
  lines.push('');

  if (active.length > 0) {
    lines.push(`### Active capabilities (${active.length})`);
    lines.push('');
    for (const s of active.slice(0, 10)) {
      lines.push(`- **${s.display_name}** — trust tier: ${s.trust_tier}`);
    }
    if (active.length > 10) lines.push(`- …and ${active.length - 10} more`);
    lines.push('');
  }

  if (recentlyInstalled.length > 0) {
    lines.push(`### Recently connected`);
    lines.push('');
    for (const s of recentlyInstalled) {
      lines.push(`- **${s.display_name}** — connected on ${s.installed_at?.toLocaleDateString() ?? 'recently'}`);
    }
    lines.push('');
  }

  if (promotionResult.rows.length > 0) {
    lines.push(`### Trust tier changes`);
    lines.push('');
    for (const row of promotionResult.rows) {
      const p = row.payload as Record<string, unknown> | null;
      const from = String(p?.['from'] ?? '');
      const to = String(p?.['to'] ?? '');
      const when = new Date(row.occurred_at).toLocaleDateString();
      lines.push(`- Promoted from **${from}** to **${to}** on ${when}`);
    }
    lines.push('');
  }

  if (dormant.length > 0) {
    lines.push(`### Dormant or paused`);
    lines.push('');
    for (const s of dormant.slice(0, 5)) {
      lines.push(`- **${s.display_name}** (${s.status})`);
    }
    if (dormant.length > 5) lines.push(`- …and ${dormant.length - 5} more`);
    lines.push('');
  }

  if (suggestions.length > 0) {
    lines.push(`### Suggested connections`);
    lines.push('');
    for (const s of suggestions.slice(0, 5)) {
      lines.push(`- **${s.display_name}** — ${s.reason_summary ?? 'new suggestion'}`);
    }
    lines.push('');
  }

  const sourceEventCount =
    suggestions.length +
    recentlyInstalled.length +
    dormant.length +
    promotionResult.rows.length;

  if (sourceEventCount === 0) {
    lines.push(`_Nothing new to report. Your twin is watching and learning._`);
  }

  return lines.join('\n');
}

/**
 * #193 follow-up: filter a gathered-briefing-data bundle down to only
 * the items relevant to one Lifebook's domain. Membership is decided
 * by `mcpServer.registry_id ∈ lifebook.suggested_capabilities` — the
 * same registry-id set the domain extractor proposed for the wing.
 * Suggestions, active/dormant/recentlyInstalled, and tier-promotions
 * (whose `payload.registryId` matches) all flow through the same set.
 *
 * Returns a structurally identical bundle so the downstream prose
 * generator doesn't need to know whether it's looking at the global
 * feed or a scoped one.
 */
function filterDataByLifebook(
  data: Awaited<ReturnType<typeof gatherBriefingData>>,
  registryIds: ReadonlySet<string>,
): typeof data {
  if (registryIds.size === 0) {
    // Empty allow-list = "the domain extractor proposed nothing yet."
    // Return an EMPTY bundle so sourceEventCount is 0 and the caller
    // skips the write — previously this returned the unfiltered global
    // bundle, which Copilot round-2 on #258 flagged as a footgun: a
    // global briefing could end up labeled with the lifebook's domain.
    return {
      suggestions: [],
      active: [],
      dormant: [],
      recentlyInstalled: [],
      promotionResult: { ...data.promotionResult, rows: [] },
      serverIdToRegistry: data.serverIdToRegistry,
      since: data.since,
    };
  }
  const inSet = (registryId: string | null | undefined): boolean =>
    typeof registryId === 'string' && registryIds.has(registryId);
  // tier_promotion provenance rows don't carry registryId in their
  // payload (they're { from, to, reason }); instead they reference an
  // mcp_servers row via server_id. Map server_id → registry_id and
  // check membership against the lifebook's allowlist that way.
  const filteredPromotions = data.promotionResult.rows.filter((r) => {
    if (!r.server_id) return false;
    const registryId = data.serverIdToRegistry.get(r.server_id);
    return inSet(registryId);
  });
  return {
    suggestions: data.suggestions.filter((s) => inSet(s.registry_id)),
    active: data.active.filter((s) => inSet(s.registry_id)),
    dormant: data.dormant.filter((s) => inSet(s.registry_id)),
    recentlyInstalled: data.recentlyInstalled.filter((s) => inSet(s.registry_id)),
    promotionResult: { ...data.promotionResult, rows: filteredPromotions },
    serverIdToRegistry: data.serverIdToRegistry,
    since: data.since,
  };
}

/**
 * Generate a briefing for a single user.
 * Tries the adaptive briefing-prose prompt first; falls back to the
 * deterministic Markdown template.
 *
 * When `scope` is provided, the gathered data is pre-filtered to that
 * Lifebook's registry-id set and the prompt receives the domain name
 * so the prose stays scoped. Otherwise this generates a global
 * briefing (the historical semantic — untouched).
 *
 * Callers that emit multiple briefings for the same user (global +
 * per-Lifebook) should pre-gather the data ONCE via
 * `gatherBriefingData()` and pass it in as `preGathered` — this
 * avoids the N+1 query pattern Copilot round-2 on #258 flagged
 * (suggestion-repo + server-repo + promotion-query call per
 * lifebook). When `preGathered` is omitted the function does its own
 * gather for the single-briefing case.
 */
async function generateBriefingProse(
  userId: string,
  cadence: 'daily' | 'weekly',
  llmClient?: LlmClient,
  scope?: { domainName: string; registryIds: ReadonlySet<string> },
  preGathered?: Awaited<ReturnType<typeof gatherBriefingData>>,
): Promise<{ prose: string; sourceEventCount: number; llmProvider?: string }> {
  const rawData = preGathered ?? await gatherBriefingData(userId, cadence);
  const data = scope ? filterDataByLifebook(rawData, scope.registryIds) : rawData;

  const sourceEventCount =
    data.suggestions.length +
    data.recentlyInstalled.length +
    data.dormant.length +
    data.promotionResult.rows.length;

  // ── Adaptive path (H: briefing-prose) ─────────────────────────────────
  if (llmClient) {
    try {
      // Map our internal cadence/structured data to the snake_case keys the
      // template expects ({{date}}, {{events}}, {{language}}, {{pending_tasks}},
      // {{risk_profile}}). Previously this passed an object whose keys
      // shared no name with the template — every placeholder rendered
      // literally, the LLM returned garbage, schema validation failed,
      // and the deterministic fallback ran every time.
      const events = {
        activeCapabilities: data.active.slice(0, 20).map((s) => ({
          name: s.display_name,
          trustTier: s.trust_tier,
        })),
        recentlyInstalled: data.recentlyInstalled.map((s) => ({
          name: s.display_name,
          installedAt: s.installed_at?.toISOString() ?? '',
        })),
        tierPromotions: data.promotionResult.rows.map((r) => {
          const p = r.payload as Record<string, unknown> | null;
          return {
            from: String(p?.['from'] ?? ''),
            to: String(p?.['to'] ?? ''),
            at: new Date(r.occurred_at).toISOString(),
          };
        }),
        dormant: data.dormant.slice(0, 10).map((s) => ({
          name: s.display_name,
          status: s.status,
        })),
        cadence,
        sourceEventCount,
      };
      const pendingTasks = data.suggestions.slice(0, 5).map((s) => ({
        name: s.display_name,
        reason: s.reason_summary ?? '',
      }));

      // Output type matches the prompt's documented schema: { briefing: string }.
      // `domain` is set only for per-Lifebook briefings — the template's
      // `{{#if domain}}` block scopes the prose accordingly.
      const result = await runPrompt<{ briefing: string; highlight_count?: number }>({
        promptName: 'briefing-prose',
        inputs: {
          date: new Date().toISOString().slice(0, 10),
          events,
          language: 'en',
          pending_tasks: pendingTasks,
          risk_profile: '',
          domain: scope?.domainName ?? '',
        },
        user: { userId },
        llmClient,
      });

      if (!result.fellBackToDeterministic && typeof result.output?.briefing === 'string' && result.output.briefing.trim()) {
        return {
          prose: result.output.briefing,
          sourceEventCount,
          llmProvider: result.modelUsed,
        };
      }
    } catch (err) {
      log.warn('briefing-prose prompt failed, using templated fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Deterministic fallback: Markdown template ──────────────────────────
  const prose = buildTemplatedProse(cadence, data);
  return { prose, sourceEventCount };
}

export async function runBriefingGeneratorJob(
  deps: BriefingGeneratorJobDeps = {},
): Promise<void> {
  const cadence = deps.cadence ?? 'daily';
  const { llmClient } = deps;
  log.info(`Running briefing generator (cadence=${cadence})`);

  let userIds: string[];
  if (deps.userIds && deps.userIds.length > 0) {
    userIds = deps.userIds;
  } else {
    userIds = await getActiveUserIds();
  }

  if (userIds.length === 0) {
    log.info('Briefing generator: no active users — skipping');
    return;
  }

  log.info(`Briefing generator: generating for ${userIds.length} user(s)`);
  let generated = 0;
  let perDomainGenerated = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      // Gather once per user; share the bundle across global +
      // per-Lifebook briefings. Copilot round-2 on #258 flagged the
      // prior N+1 pattern (every per-Lifebook call hit
      // suggestion-repo, server-repo, and the promotion query
      // independently).
      const sharedData = await gatherBriefingData(userId, cadence);

      const { prose, sourceEventCount, llmProvider } = await generateBriefingProse(
        userId,
        cadence,
        llmClient,
        undefined,
        sharedData,
      );
      await briefingRepository.create({
        userId,
        cadence,
        proseMarkdown: prose,
        sourceEventCount,
        llmProvider,
        llmCostCents: undefined,
      });
      generated++;

      // #193 follow-up: emit per-Lifebook briefings for each visible
      // domain that has at least one event in the window. Skip empty
      // domains so we don't fill the table with "nothing happened in
      // Health" rows. Failures on one domain don't fail the whole
      // user — each lifebook gets its own try/catch.
      perDomainGenerated += await emitPerDomainBriefings(
        userId,
        cadence,
        llmClient,
        sharedData,
      );
    } catch (err) {
      failed++;
      log.warn('Failed to generate briefing for user', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(
    `Briefing generator complete: ${generated} global, ${perDomainGenerated} per-Lifebook, ${failed} failed`,
  );
}

/**
 * #193 follow-up: produce per-Lifebook briefings for every visible
 * lifebook with at least one source event in the window. Returns the
 * count of briefings actually written so the orchestrator can log it.
 *
 * Failures on individual lifebooks are logged and skipped — one
 * domain's prompt blowing up should never take out another domain's
 * briefing. The global briefing has already been written by the
 * caller when this runs, so the worst case is "fewer per-Lifebook
 * rows than expected," not "the user lost their daily summary."
 */
async function emitPerDomainBriefings(
  userId: string,
  cadence: 'daily' | 'weekly',
  llmClient: LlmClient | undefined,
  sharedData: Awaited<ReturnType<typeof gatherBriefingData>>,
): Promise<number> {
  let lifebooks: Awaited<ReturnType<typeof lifebookRepository.listVisible>>;
  try {
    lifebooks = await lifebookRepository.listVisible(userId);
  } catch (err) {
    log.warn('Could not load lifebooks for per-domain briefings; skipping', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  if (lifebooks.length === 0) return 0;

  let written = 0;
  for (const lb of lifebooks) {
    try {
      const registryIds = new Set(
        Array.isArray(lb.suggested_capabilities) ? lb.suggested_capabilities : [],
      );
      // Empty allow-list = the extractor hasn't proposed any
      // capabilities for this domain yet. Skip rather than fall back
      // to the global feed under a domain label.
      if (registryIds.size === 0) continue;

      const { prose, sourceEventCount, llmProvider } = await generateBriefingProse(
        userId,
        cadence,
        llmClient,
        { domainName: lb.domain_name, registryIds },
        sharedData,
      );

      // Skip empty domains — "nothing happened in Health this week"
      // is noise, not a useful briefing. The user will see the
      // global briefing or no briefing.
      if (sourceEventCount === 0) continue;

      await briefingRepository.create({
        userId,
        cadence,
        proseMarkdown: prose,
        sourceEventCount,
        llmProvider,
        llmCostCents: undefined,
        domainName: lb.domain_name,
      });
      written++;
    } catch (err) {
      log.warn('Per-domain briefing failed for one lifebook; continuing', {
        userId,
        domain: lb.domain_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return written;
}
