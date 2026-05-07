import { createLogger } from '@skytwin/core';
import { briefingRepository, appSuggestionRepository, mcpServerRepository, query } from '@skytwin/db';

const log = createLogger('worker:briefing-generator');

/**
 * Generates daily and weekly twin briefings for all active users (issue #177).
 *
 * For v1, generates deterministic Markdown briefings from templates — no LLM.
 * TODO(#185): Replace templated paragraphs with `runPrompt('briefing-prose', context)`.
 *
 * Cadence:
 *   - daily: 7am user-local time
 *   - weekly: Sunday morning
 *
 * TODO: Wire into apps/worker/src/index.ts once cron infrastructure lands (#189):
 *
 *   // Daily briefing — guard with 24h timestamp
 *   if (shouldRunDaily()) {
 *     await runBriefingGeneratorJob({ cadence: 'daily' }).catch(
 *       (err) => log.error('Briefing generator failed', { error: err.message }),
 *     );
 *   }
 *   // Weekly briefing — guard with isSunday && weekly timestamp
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
}

/** Active users who have installed at least one MCP server. */
async function getActiveUserIds(): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id
     FROM mcp_servers
     WHERE status IN ('active', 'installed', 'authorized')
     LIMIT 500`,
  );
  return result.rows.map((r) => r.user_id);
}

/**
 * Generate a briefing for a single user. Returns the prose Markdown string.
 * Redacts PII from log output — user IDs are included in structured fields
 * only, never interpolated into message strings.
 */
async function generateBriefingProse(
  userId: string,
  cadence: 'daily' | 'weekly',
): Promise<{ prose: string; sourceEventCount: number }> {
  // Gather source data
  const [suggestions, allServers] = await Promise.all([
    appSuggestionRepository.getPendingForUser(userId),
    mcpServerRepository.listForUser(userId),
  ]);

  const active = allServers.filter(
    (s) => s.status === 'active' || s.status === 'installed' || s.status === 'authorized',
  );
  const dormant = allServers.filter((s) => s.status === 'dormant' || s.status === 'paused');

  // Recent acquisitions — installed in the last 7 days (daily) or 30 days (weekly)
  const lookbackMs = cadence === 'daily' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - lookbackMs);
  const recentlyInstalled = active.filter((s) => s.installed_at && s.installed_at > since);

  // Recently promoted tiers — check provenance nodes
  const promotionResult = await query<{ payload: unknown; occurred_at: Date }>(
    `SELECT payload, occurred_at
     FROM capability_provenance_nodes
     WHERE user_id = $1 AND node_type = 'tier_promotion' AND occurred_at > $2
     ORDER BY occurred_at DESC`,
    [userId, since],
  );

  const sourceEventCount =
    suggestions.length +
    recentlyInstalled.length +
    dormant.length +
    promotionResult.rows.length;

  // v1 templated prose (no LLM)
  // TODO(#185): Replace with runPrompt('briefing-prose', { userId, data }) — one-line wire-up.
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

  // Active capabilities
  if (active.length > 0) {
    lines.push(`### Active capabilities (${active.length})`);
    lines.push('');
    for (const s of active.slice(0, 10)) {
      lines.push(`- **${s.display_name}** — trust tier: ${s.trust_tier}`);
    }
    if (active.length > 10) {
      lines.push(`- …and ${active.length - 10} more`);
    }
    lines.push('');
  }

  // Recent acquisitions
  if (recentlyInstalled.length > 0) {
    lines.push(`### Recently connected`);
    lines.push('');
    for (const s of recentlyInstalled) {
      lines.push(`- **${s.display_name}** — connected on ${s.installed_at?.toLocaleDateString() ?? 'recently'}`);
    }
    lines.push('');
  }

  // Tier promotions
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

  // Dormant/paused
  if (dormant.length > 0) {
    lines.push(`### Dormant or paused`);
    lines.push('');
    for (const s of dormant.slice(0, 5)) {
      lines.push(`- **${s.display_name}** (${s.status})`);
    }
    if (dormant.length > 5) {
      lines.push(`- …and ${dormant.length - 5} more`);
    }
    lines.push('');
  }

  // New suggestions
  if (suggestions.length > 0) {
    lines.push(`### Suggested connections`);
    lines.push('');
    for (const s of suggestions.slice(0, 5)) {
      lines.push(`- **${s.display_name}** — ${s.reason_summary ?? 'new suggestion'}`);
    }
    lines.push('');
  }

  if (sourceEventCount === 0) {
    lines.push(`_Nothing new to report. Your twin is watching and learning._`);
  }

  return { prose: lines.join('\n'), sourceEventCount };
}

export async function runBriefingGeneratorJob(
  deps: BriefingGeneratorJobDeps = {},
): Promise<void> {
  const cadence = deps.cadence ?? 'daily';
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
      const { prose, sourceEventCount } = await generateBriefingProse(userId, cadence);
      await briefingRepository.create({
        userId,
        cadence,
        proseMarkdown: prose,
        sourceEventCount,
        // LLM provider is null for v1 templated briefings
        llmProvider: undefined,
        llmCostCents: undefined,
      });
      generated++;
    } catch (err) {
      failed++;
      // Log the error without including userId in the message string (PII guard).
      log.warn('Failed to generate briefing for user', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`Briefing generator complete: ${generated} generated, ${failed} failed`);
}
