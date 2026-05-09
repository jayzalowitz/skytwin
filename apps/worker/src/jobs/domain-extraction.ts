import { createLogger } from '@skytwin/core';
import { lifebookRepository, mempalaceRepository, query } from '@skytwin/db';
import { runPrompt } from '@skytwin/policy-prompts';
import type { LlmClient } from '@skytwin/llm-client';

const log = createLogger('worker:domain-extraction');

/**
 * Output shape from the domain-extraction prompt (#193 Child 1).
 *
 * Mirrors `packages/policy-prompts/prompts/domain-extraction/v1.md`. The
 * prompt is asked for an array directly; the runner parses it as JSON
 * and validates against `domain-extraction.schema.json`.
 */
export interface ExtractedDomain {
  domainName: string;
  importance: 'core' | 'secondary' | 'emerging';
  sample_signals: string[];
  suggested_capabilities: string[];
}

export interface DomainExtractionDeps {
  /** Overrides the "active users" query — for testing. */
  userIds?: string[];
  /** LlmClient for the prompt — runs the deterministic empty-list fallback if absent. */
  llmClient?: LlmClient;
  /** Capability categories list passed to the prompt. */
  capabilityCategories?: string[];
}

/**
 * Default capability categories. Kept here rather than fetched from the
 * registry because (a) the registry sync is async and we don't want to
 * couple this worker to its cadence, and (b) these are conceptual
 * categories the LLM matches against, not literal MCP server names — a
 * 30-item list of `filesystem`/`github`/etc. would over-bias the output
 * toward what's already installed.
 */
const DEFAULT_CAPABILITY_CATEGORIES = [
  'email',
  'calendar',
  'filesystem',
  'browser-history',
  'finance',
  'health',
  'fitness',
  'shopping',
  'travel',
  'communication',
  'social-media',
  'productivity',
  'learning',
  'home-automation',
  'media',
  'documents',
  'code',
  'project-management',
];

interface MemorySummaryParts {
  topEntities: Array<{ kind: string; canonical: string; freq: number }>;
  recentTriples: Array<{ subject: string; predicate: string; object: string }>;
  drawerCount: number;
  wingCount: number;
}

/**
 * Active users: anyone with at least one MCP server installed OR with any
 * memory wings populated. The OR matters — a user who arrived via the
 * idle-miner has wings and entities but no installed servers yet.
 */
async function getActiveUserIds(): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM mcp_servers WHERE status IN ('active', 'installed', 'authorized')
     UNION
     SELECT DISTINCT user_id FROM memory_wings
     LIMIT 500`,
  );
  return result.rows.map((r) => r.user_id);
}

/**
 * Build the `memory_summary` input for the prompt by reading top entities,
 * recent triples, and palace structure stats. Pure aggregation — the prompt
 * is the only place where domains get *named*.
 */
async function buildMemorySummary(userId: string): Promise<MemorySummaryParts> {
  const [entitiesResult, triplesResult, statusResult] = await Promise.all([
    query<{ kind: string; canonical: string; freq: string }>(
      `SELECT kind, canonical, count(*)::STRING AS freq
       FROM knowledge_entities
       WHERE user_id = $1
       GROUP BY kind, canonical
       ORDER BY count(*) DESC
       LIMIT 40`,
      [userId],
    ),
    query<{ subject: string; predicate: string; object: string }>(
      `SELECT subject, predicate, object
       FROM knowledge_triples
       WHERE user_id = $1 AND (valid_to IS NULL OR valid_to > now())
       ORDER BY observed_at DESC
       LIMIT 40`,
      [userId],
    ),
    query<{ wing_count: string; drawer_count: string }>(
      `SELECT
         (SELECT count(*)::STRING FROM memory_wings WHERE user_id = $1) AS wing_count,
         (SELECT count(*)::STRING FROM memory_drawers WHERE user_id = $1) AS drawer_count`,
      [userId],
    ),
  ]);

  return {
    topEntities: entitiesResult.rows.map((r) => ({
      kind: r.kind,
      canonical: r.canonical,
      freq: Number(r.freq),
    })),
    recentTriples: triplesResult.rows,
    wingCount: Number(statusResult.rows[0]?.wing_count ?? '0'),
    drawerCount: Number(statusResult.rows[0]?.drawer_count ?? '0'),
  };
}

/**
 * Render the parts into the string the prompt template interpolates as
 * `{{memory_summary}}`. Compact enough to fit comfortably in a 4k context;
 * structured enough that the LLM can actually use it.
 */
export function formatMemorySummary(parts: MemorySummaryParts): string {
  const lines: string[] = [];
  lines.push(`Memory palace: ${parts.wingCount} wings, ${parts.drawerCount} drawers.`);
  lines.push('');
  if (parts.topEntities.length > 0) {
    lines.push('## Top entities by frequency');
    for (const e of parts.topEntities) {
      lines.push(`- [${e.kind}] ${e.canonical} (×${e.freq})`);
    }
    lines.push('');
  }
  if (parts.recentTriples.length > 0) {
    lines.push('## Recent triples');
    for (const t of parts.recentTriples) {
      lines.push(`- ${t.subject} —[${t.predicate}]→ ${t.object}`);
    }
  }
  return lines.join('\n');
}

/**
 * Output of `runPrompt` is `unknown`. Validate at the boundary so a
 * misbehaving prompt can't crash the worker mid-loop.
 */
function isExtractedDomain(x: unknown): x is ExtractedDomain {
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['domainName'] === 'string' &&
    (o['importance'] === 'core' || o['importance'] === 'secondary' || o['importance'] === 'emerging') &&
    Array.isArray(o['sample_signals']) &&
    Array.isArray(o['suggested_capabilities'])
  );
}

function coerceDomainList(raw: unknown): ExtractedDomain[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isExtractedDomain).slice(0, 10);
}

/**
 * Process one user end-to-end: read memory, run prompt, persist domains
 * + ensure wings. Returns counts so the orchestrator can log progress.
 */
export async function extractDomainsForUser(
  userId: string,
  llmClient: LlmClient | undefined,
  capabilityCategories: string[],
): Promise<{ detected: number; persisted: number }> {
  const summaryParts = await buildMemorySummary(userId);
  if (summaryParts.drawerCount === 0 && summaryParts.topEntities.length === 0) {
    log.info('Skipping domain extraction — no memory yet', { userId });
    return { detected: 0, persisted: 0 };
  }

  const memorySummary = formatMemorySummary(summaryParts);

  if (!llmClient) {
    log.info('No LlmClient — skipping (extraction is LLM-dependent)', { userId });
    return { detected: 0, persisted: 0 };
  }

  const result = await runPrompt({
    promptName: 'domain-extraction',
    inputs: {
      memory_summary: memorySummary,
      capability_categories: capabilityCategories.join(', '),
    },
    user: { userId },
    llmClient,
  });

  const domains = coerceDomainList(result.output);
  if (domains.length === 0) {
    log.info('Domain extraction returned no valid domains', { userId });
    return { detected: 0, persisted: 0 };
  }

  let persisted = 0;
  for (const d of domains) {
    try {
      const wing = await mempalaceRepository.getWingByName(userId, d.domainName)
        ?? await mempalaceRepository.createWing({
          userId,
          name: d.domainName,
          description: `Memories related to ${d.domainName}`,
          domains: [d.domainName],
        });
      await lifebookRepository.upsert({
        userId,
        domainName: d.domainName,
        importance: d.importance,
        sampleSignals: d.sample_signals.slice(0, 5),
        suggestedCapabilities: d.suggested_capabilities.slice(0, 8),
        wingId: wing.id,
      });
      persisted++;
    } catch (err) {
      log.warn('Failed to persist domain', {
        userId,
        domainName: d.domainName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { detected: domains.length, persisted };
}

/**
 * Job entry point. Walks active users sequentially (the prompt is rate-
 * limited per-user via `daily_token_budget_per_user` in its frontmatter,
 * and parallelizing wouldn't help — LLM throughput is the bottleneck).
 */
export async function runDomainExtractionJob(deps: DomainExtractionDeps = {}): Promise<void> {
  const { llmClient, capabilityCategories } = deps;
  log.info('Running domain-extraction job');

  const userIds = deps.userIds && deps.userIds.length > 0
    ? deps.userIds
    : await getActiveUserIds();

  if (userIds.length === 0) {
    log.info('No active users — skipping');
    return;
  }

  log.info('Domain-extraction: processing users', { count: userIds.length });
  const categories = capabilityCategories ?? DEFAULT_CAPABILITY_CATEGORIES;

  let totalDetected = 0;
  let totalPersisted = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      const { detected, persisted } = await extractDomainsForUser(
        userId,
        llmClient,
        categories,
      );
      totalDetected += detected;
      totalPersisted += persisted;
    } catch (err) {
      failed++;
      log.warn('Domain extraction failed for user', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Domain-extraction complete', {
    users: userIds.length,
    detected: totalDetected,
    persisted: totalPersisted,
    failed,
  });
}
