import { createLogger } from '@skytwin/core';
import { McpHost, isDestructiveSkill } from '@skytwin/mcp-host';
import { mcpServerChangelogRepository, mcpServerRepository } from '@skytwin/db';
import type { McpServerRow } from '@skytwin/db';
import type { McpServerConfig } from '@skytwin/mcp-host';

const log = createLogger('worker:changelog-poll');

/** 12-hour rate limit: skip if fetched within this window. */
const CHANGELOG_REFRESH_MIN_MS = 12 * 60 * 60 * 1000;

export interface ChangelogPollDeps {
  /**
   * Inject for testing. If omitted, the job creates an ephemeral McpHost
   * instance for each server. Because the worker does not hold live
   * McpHost instances across jobs, this job instantiates a short-lived host,
   * connects, polls, then disconnects.
   */
  mcpHostFactory?: (config: McpServerConfig) => McpHost;
  /** Inject the repository for testing. */
  changelogRepo?: typeof mcpServerChangelogRepository;
  /** Inject the server repository for testing. */
  serverRepo?: typeof mcpServerRepository;
}

/**
 * Changelog poll job (#184 AC#2).
 *
 * For each installed MCP server:
 *   1. Rate-limit: skip if fetched within the last 12 hours.
 *   2. Fetch the changelog (changelog:// resource).
 *   3. List current skills.
 *   4. Diff against last_known_destructive_skills — create pending_skill_opt_ins
 *      rows for each NEW destructive skill (idempotent via ON CONFLICT DO NOTHING).
 *   5. Upsert the changelog snapshot.
 *
 * Intended to be called by the worker main loop with a 7-day timestamp gate.
 * Individual server errors are caught and logged; they do not abort the job.
 */
export async function runChangelogPollJob(deps: ChangelogPollDeps = {}): Promise<void> {
  const repo = deps.changelogRepo ?? mcpServerChangelogRepository;
  const serverRepo = deps.serverRepo ?? mcpServerRepository;

  log.info('Changelog poll job starting');

  let servers: McpServerRow[];
  try {
    servers = await serverRepo.listActive();
  } catch (err) {
    log.warn('Changelog poll: could not list active servers', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  log.info(`Changelog poll: processing ${servers.length} active server(s)`);

  for (const server of servers) {
    try {
      await pollServerChangelog(server, repo, deps.mcpHostFactory);
    } catch (err) {
      log.warn(`Changelog poll: error processing server ${server.id}`, {
        serverId: server.id,
        displayName: server.display_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Changelog poll job complete');
}

async function pollServerChangelog(
  server: McpServerRow,
  repo: typeof mcpServerChangelogRepository,
  mcpHostFactory?: (config: McpServerConfig) => McpHost,
): Promise<void> {
  // Rate-limit: skip if we fetched within the last 12 hours
  const existing = await repo.getForServer(server.id);
  if (existing) {
    const ageMs = Date.now() - new Date(existing.fetched_at).getTime();
    if (ageMs < CHANGELOG_REFRESH_MIN_MS) {
      log.info(`Changelog poll: skipping ${server.display_name} (fetched ${Math.round(ageMs / 3600_000)}h ago)`);
      return;
    }
  }

  // Build a short-lived McpHost for this server
  const config: McpServerConfig = {
    id: server.id,
    transport: server.transport,
    command: server.command ?? undefined,
    args: Array.isArray(server.args) ? (server.args as string[]) : undefined,
    env: server.env != null && typeof server.env === 'object' && !Array.isArray(server.env)
      ? (server.env as Record<string, string>)
      : undefined,
    url: server.url ?? undefined,
  };

  const host = mcpHostFactory ? mcpHostFactory(config) : new McpHost();

  // In the poll job we can't actually connect to every server (they may not
  // be running). We use a best-effort approach: try to install, fetch, clean up.
  let installed = false;
  try {
    const installResult = await host.installServer(config);
    if (!installResult.success) {
      log.info(`Changelog poll: could not connect to ${server.display_name}: ${installResult.error}`);
      return;
    }
    installed = true;

    // Fetch changelog
    const changelog = await host.fetchChangelog(server.id);

    // List current skills
    const skillsResult = await host.listSkills(server.id);
    const currentSkills: string[] = skillsResult.success
      ? skillsResult.skills.map((s) => s.name)
      : [];

    // Identify new destructive skills vs what we last knew
    const lastKnownDestructive: string[] = existing?.last_known_destructive_skills ?? [];
    const lastKnownSet = new Set(lastKnownDestructive);
    const currentDestructive = currentSkills.filter((name) => isDestructiveSkill(name));

    const newDestructiveSkills = currentDestructive.filter((name) => !lastKnownSet.has(name));

    // Create opt-in prompts for newly discovered destructive skills
    for (const skillName of newDestructiveSkills) {
      log.info(`Changelog poll: new destructive skill detected on ${server.display_name}: ${skillName}`);
      await repo.addPendingOptIn(server.id, skillName, changelog?.currentVersion);
    }

    // Upsert changelog row
    await repo.upsert(server.id, {
      currentVersion: changelog?.currentVersion,
      rawText: changelog?.rawText,
      lastSeenSkills: currentSkills,
      lastKnownDestructiveSkills: currentDestructive,
    });

    log.info(`Changelog poll: updated ${server.display_name}`, {
      version: changelog?.currentVersion ?? 'unknown',
      skills: currentSkills.length,
      newDestructive: newDestructiveSkills.length,
    });
  } finally {
    if (installed) {
      await host.uninstallServer(server.id).catch(() => {
        // best-effort cleanup
      });
    }
  }
}
