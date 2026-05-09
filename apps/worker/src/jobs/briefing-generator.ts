import { createLogger } from '@skytwin/core';
import { briefingRepository, appSuggestionRepository, mcpServerRepository, query } from '@skytwin/db';
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

  const promotionResult = await query<{ payload: unknown; occurred_at: Date }>(
    `SELECT payload, occurred_at
     FROM capability_provenance_nodes
     WHERE user_id = $1 AND node_type = 'tier_promotion' AND occurred_at > $2
     ORDER BY occurred_at DESC`,
    [userId, since],
  );

  return { suggestions, active, dormant, recentlyInstalled, promotionResult, since };
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
 * Generate a briefing for a single user.
 * Tries the adaptive briefing-prose prompt first; falls back to the
 * deterministic Markdown template.
 */
async function generateBriefingProse(
  userId: string,
  cadence: 'daily' | 'weekly',
  llmClient?: LlmClient,
): Promise<{ prose: string; sourceEventCount: number; llmProvider?: string }> {
  const data = await gatherBriefingData(userId, cadence);

  const sourceEventCount =
    data.suggestions.length +
    data.recentlyInstalled.length +
    data.dormant.length +
    data.promotionResult.rows.length;

  // ── Adaptive path (H: briefing-prose) ─────────────────────────────────
  if (llmClient) {
    try {
      const briefingData = {
        cadence,
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
        suggestions: data.suggestions.slice(0, 5).map((s) => ({
          name: s.display_name,
          reason: s.reason_summary ?? '',
        })),
        sourceEventCount,
      };

      const result = await runPrompt<{ prose: string }>({
        promptName: 'briefing-prose',
        inputs: briefingData,
        user: { userId },
        llmClient,
      });

      if (!result.fellBackToDeterministic && typeof result.output?.prose === 'string' && result.output.prose.trim()) {
        return {
          prose: result.output.prose,
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
  let failed = 0;

  for (const userId of userIds) {
    try {
      const { prose, sourceEventCount, llmProvider } = await generateBriefingProse(
        userId,
        cadence,
        llmClient,
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
    } catch (err) {
      failed++;
      log.warn('Failed to generate briefing for user', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`Briefing generator complete: ${generated} generated, ${failed} failed`);
}
