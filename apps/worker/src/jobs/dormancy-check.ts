import { createLogger } from '@skytwin/core';
import { mcpServerRepository, appSuggestionRepository, query } from '@skytwin/db';
import { runPrompt } from '@skytwin/policy-prompts';
import type { LlmClient } from '@skytwin/llm-client';

const log = createLogger('worker:dormancy-check');

const DORMANCY_THRESHOLD_DAYS = 30;

export interface DormancyCheckJobDeps {
  thresholdDays?: number;
  /** Optional LlmClient for the adaptive dormancy-judgment path */
  llmClient?: LlmClient;
}

/** LLM output shape for the dormancy-judgment prompt */
interface DormancyJudgmentOutput {
  should_offer_uninstall: boolean;
  reasoning: string;
}

/** Activity summary row from the DB */
interface ActivityRow {
  node_type: string;
  occurred_at: Date;
}

/**
 * Returns the last N activity events for a server from provenance nodes.
 * Used to give the LLM richer context than just "days since last use."
 */
async function getRecentActivity(
  serverId: string,
  limit = 10,
): Promise<Array<{ nodeType: string; occurredAt: string }>> {
  try {
    const result = await query<ActivityRow>(
      `SELECT node_type, occurred_at
       FROM capability_provenance_nodes
       WHERE server_id = $1
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [serverId, limit],
    );
    return result.rows.map((r) => ({
      nodeType: r.node_type,
      occurredAt: new Date(r.occurred_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

/**
 * Retrieve the risk profile text for a user (if the table exists).
 * Gracefully returns an empty string when the table is not yet populated.
 */
async function getRiskProfileText(userId: string): Promise<string> {
  try {
    const result = await query<{ profile_text: string }>(
      'SELECT profile_text FROM risk_profiles WHERE user_id = $1 LIMIT 1',
      [userId],
    );
    return result.rows[0]?.profile_text ?? '';
  } catch {
    return '';
  }
}

/**
 * Mark a server dormant and upsert a "Disconnect X?" suggestion.
 */
async function markDormantAndSuggest(
  server: {
    id: string;
    user_id: string;
    display_name: string;
    registry_id: string | null;
    last_active_at: Date | null;
    created_at: Date;
    trust_tier: string;
  },
  reasoning: string,
  thresholdDays: number,
): Promise<{ markedDormant: boolean; suggestionCreated: boolean }> {
  let markedDormant = false;
  let suggestionCreated = false;

  const dormant = await mcpServerRepository.markDormant(server.id);
  if (!dormant) return { markedDormant, suggestionCreated };
  markedDormant = true;

  const lastActive = server.last_active_at
    ? Math.floor((Date.now() - new Date(server.last_active_at).getTime()) / (1000 * 60 * 60 * 24))
    : thresholdDays;

  // Always include the server display name in the suggestion so the user can
  // identify which server this refers to. The LLM reasoning is appended when
  // the adaptive path produced it; the deterministic path produces the default.
  const defaultReason = `Disconnect ${server.display_name}? It's been inactive ${lastActive} days.`;
  const reasonSummary = reasoning
    ? `${server.display_name}: ${reasoning}`
    : defaultReason;

  if (server.registry_id) {
    try {
      await appSuggestionRepository.upsertPending({
        userId: server.user_id,
        registryId: server.registry_id,
        displayName: server.display_name,
        evidenceCount: 0,
        evidenceSources: [],
        evidenceKindsDistinct: 0,
        firstEvidenceAt: server.last_active_at ?? server.created_at,
        lastEvidenceAt: server.last_active_at ?? server.created_at,
        confidenceScore: 0,
        reasonSummary,
      });
      suggestionCreated = true;
    } catch (err) {
      log.warn(`Failed to upsert dormancy suggestion for server ${server.id}`, {
        userId: server.user_id,
        registryId: server.registry_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { markedDormant, suggestionCreated };
}

/**
 * Marks active MCP servers dormant when they haven't been used recently,
 * and upserts a "Disconnect X?" suggestion for each newly-dormant server.
 *
 * Adaptive path (E: dormancy-judgment): when an llmClient is provided,
 * uses the dormancy-judgment prompt to decide whether to offer uninstall.
 * The LLM receives the server name, days-inactive count, recent activity
 * history, and the user's risk profile text so it can make a contextual
 * judgment (e.g., "GitHub is only dormant because it's the weekend" or
 * "this CI tool has been unused for 45 days and the user said they quit
 * their old job").
 *
 * Deterministic fallback: fixed 30-day window (original v1 logic).
 *
 * Schedule: daily cadence. In the worker's main() loop, guard with a
 * day-level timestamp so it only fires once per 24 hours.
 */
export async function runDormancyCheckJob(deps: DormancyCheckJobDeps = {}): Promise<void> {
  const thresholdDays = deps.thresholdDays ?? DORMANCY_THRESHOLD_DAYS;
  const thresholdDate = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);
  const { llmClient } = deps;

  log.info(`Running dormancy check (threshold: ${thresholdDays} days ago = ${thresholdDate.toISOString()})`);

  let inactiveServers;
  try {
    inactiveServers = await mcpServerRepository.getInactiveSince(thresholdDate);
  } catch (err) {
    log.error('Failed to query inactive servers for dormancy check', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (inactiveServers.length === 0) {
    log.info('Dormancy check: no servers eligible for dormancy');
    return;
  }

  log.info(`Dormancy check: ${inactiveServers.length} server(s) eligible`);

  let markedDormant = 0;
  let suggestionsCreated = 0;

  for (const server of inactiveServers) {
    const lastActiveDays = server.last_active_at
      ? Math.floor((Date.now() - new Date(server.last_active_at).getTime()) / (1000 * 60 * 60 * 24))
      : thresholdDays;

    try {
      // ── Adaptive path (E: dormancy-judgment) ────────────────────────────
      if (llmClient) {
        try {
          const [activityHistory, riskProfile] = await Promise.all([
            getRecentActivity(server.id),
            getRiskProfileText(server.user_id),
          ]);

          // Map to snake_case keys per the dormancy-judgment template:
          // {{server_name}}, {{server_id}}, {{activity_history}},
          // {{user_activity}}, {{risk_profile}}.
          const judgment = await runPrompt<DormancyJudgmentOutput>({
            promptName: 'dormancy-judgment',
            inputs: {
              server_name: server.display_name,
              server_id: server.id,
              activity_history: activityHistory,
              user_activity: '',
              risk_profile: riskProfile,
            },
            user: { userId: server.user_id },
            llmClient,
          });

          if (!judgment.fellBackToDeterministic) {
            if (judgment.output.should_offer_uninstall) {
              const { markedDormant: d, suggestionCreated: s } = await markDormantAndSuggest(
                server,
                judgment.output.reasoning,
                thresholdDays,
              );
              if (d) markedDormant++;
              if (s) suggestionsCreated++;
            } else {
              log.info(`Dormancy check: LLM kept server active`, {
                serverId: server.id,
                reasoning: judgment.output.reasoning,
              });
            }
            continue; // LLM handled this server
          }
        } catch (err) {
          log.warn(`Dormancy LLM judgment failed for server ${server.id}, using deterministic fallback`, {
            error: err instanceof Error ? err.message : String(err),
          });
          // fall through to deterministic
        }
      }

      // ── Deterministic fallback: fixed 30-day threshold ──────────────────
      if (lastActiveDays > thresholdDays) {
        // Pass empty string so markDormantAndSuggest uses the defaultReason
        // which includes the display name and "inactive" in lowercase.
        const { markedDormant: d, suggestionCreated: s } = await markDormantAndSuggest(
          server,
          '',
          thresholdDays,
        );
        if (d) markedDormant++;
        if (s) suggestionsCreated++;
      }
    } catch (err) {
      log.error(`Failed to process server ${server.id} in dormancy check`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(
    `Dormancy check complete: ${markedDormant} server(s) marked dormant, ${suggestionsCreated} suggestion(s) created`,
    { markedDormant, suggestionsCreated },
  );
}
