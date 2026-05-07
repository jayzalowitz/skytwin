import { createLogger } from '@skytwin/core';
import { mcpServerRepository, appSuggestionRepository } from '@skytwin/db';

const log = createLogger('worker:dormancy-check');

const DORMANCY_THRESHOLD_DAYS = 30;

export interface DormancyCheckJobDeps {
  thresholdDays?: number;
}

/**
 * Marks active MCP servers dormant when they haven't been used for 30 days,
 * and upserts a "Disconnect X?" suggestion for each newly-dormant server.
 *
 * Schedule: daily cadence (not per poll-cycle). In the worker's main() loop,
 * hook this into the `pollCount % 10 === 0` block in apps/worker/src/index.ts
 * but guard it with a day-level timestamp so it only fires once per 24 hours.
 *
 * TODO: wire into apps/worker/src/index.ts once cron infrastructure lands
 * (#189). Add a `lastDormancyCheckAt` module-level variable and guard:
 *
 *   if (pollCount % 10 === 0 && Date.now() - lastDormancyCheckAt > 86_400_000) {
 *     lastDormancyCheckAt = Date.now();
 *     await runDormancyCheckJob().catch(...);
 *   }
 */
export async function runDormancyCheckJob(deps: DormancyCheckJobDeps = {}): Promise<void> {
  const thresholdDays = deps.thresholdDays ?? DORMANCY_THRESHOLD_DAYS;
  const thresholdDate = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

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
    try {
      const dormant = await mcpServerRepository.markDormant(server.id);
      if (!dormant) continue;
      markedDormant++;

      const lastActive = server.last_active_at
        ? Math.floor((Date.now() - new Date(server.last_active_at).getTime()) / (1000 * 60 * 60 * 24))
        : thresholdDays;

      const reasonSummary = `Disconnect ${server.display_name}? It's been inactive ${lastActive} days.`;

      // Upsert a pending suggestion only when none already exists for this
      // user+registry pair. The ON CONFLICT clause in upsertPending handles
      // the no-duplicate guard transparently.
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
          suggestionsCreated++;
        } catch (err) {
          log.warn(`Failed to upsert dormancy suggestion for server ${server.id}`, {
            userId: server.user_id,
            registryId: server.registry_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error(`Failed to mark server ${server.id} dormant`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(
    `Dormancy check complete: ${markedDormant} server(s) marked dormant, ${suggestionsCreated} suggestion(s) created`,
    { markedDormant, suggestionsCreated },
  );
}
