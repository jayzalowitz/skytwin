import { createLogger } from '@skytwin/core';
import { loadConfig, type GoogleConnectionMode } from '@skytwin/config';
import { McpHost, isDestructiveSkill } from '@skytwin/mcp-host';
import { mcpServerChangelogRepository, mcpServerRepository } from '@skytwin/db';
import type { McpServerRow } from '@skytwin/db';
import type { McpServerConfig } from '@skytwin/mcp-host';
import { isAccountBackedIntegration } from '@skytwin/shared-types';
import { RegistryClient } from '@skytwin/registry-client';
import { requireJobAdmission, runAdmitted } from './job-admission.js';

const log = createLogger('worker:changelog-poll');
const accountBoundaryRegistry = new RegistryClient({ smitheryEnabled: false });

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
  /** Exact preview mode from the worker generation; inject for tests. */
  googleConnectionMode?: GoogleConnectionMode;
  signal?: AbortSignal;
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
  requireJobAdmission(deps.signal);
  const repo = deps.changelogRepo ?? mcpServerChangelogRepository;
  const serverRepo = deps.serverRepo ?? mcpServerRepository;
  const googleConnectionMode = deps.googleConnectionMode ?? loadConfig().googleConnectionMode;

  log.info('Changelog poll job starting');

  let servers: McpServerRow[];
  try {
    servers = await runAdmitted(deps.signal, () => serverRepo.listActive());
  } catch (err) {
    log.warn('Changelog poll: could not list active servers', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  log.info(`Changelog poll: processing ${servers.length} active server(s)`);

  for (const server of servers) {
    requireJobAdmission(deps.signal);
    if (googleConnectionMode !== 'experimental' &&
        await isBlockedAccountServer(server, serverRepo, deps.signal)) {
      log.info(`Changelog poll: skipping account-backed server ${server.id} while connection is disabled`);
      continue;
    }
    try {
      await pollServerChangelog(server, repo, deps.mcpHostFactory, deps.signal);
    } catch (err) {
      log.warn(`Changelog poll: error processing server ${server.id}`, {
        serverId: server.id,
        displayName: server.display_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    requireJobAdmission(deps.signal);
  }

  requireJobAdmission(deps.signal);
  log.info('Changelog poll job complete');
}

async function isBlockedAccountServer(
  server: McpServerRow,
  serverRepo: typeof mcpServerRepository,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isAccountBackedIntegration({
    key: server.registry_id ?? undefined,
    integration: server.oauth_provider ?? undefined,
  })) return true;

  try {
    const skills = await runAdmitted(signal, () =>
      serverRepo.listSkillNamesForServer(server.id));
    if (skills.length === 0) {
      const trustedEntry = server.registry_id
        ? await accountBoundaryRegistry.getById(server.registry_id)
        : null;
      // An empty cache is not evidence that an unknown capability is
      // account-free. Only a bundled, locally classified registry neighbor
      // may proceed without cached tool names.
      if (!trustedEntry) return true;
      return isAccountBackedIntegration({
        key: trustedEntry.id,
        integration: trustedEntry.oauthProvider ?? undefined,
      });
    }
    return isAccountBackedIntegration({
      key: server.registry_id ?? undefined,
      integration: server.oauth_provider ?? undefined,
      skills,
    });
  } catch (error) {
    // This poll is advisory. If local classification state cannot be read,
    // do not spawn a process or contact a remote server in disabled mode.
    log.warn('Changelog poll: skipping server because account boundary classification failed', {
      serverId: server.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function pollServerChangelog(
  server: McpServerRow,
  repo: typeof mcpServerChangelogRepository,
  mcpHostFactory?: (config: McpServerConfig) => McpHost,
  signal?: AbortSignal,
): Promise<void> {
  // Rate-limit: skip if we fetched within the last 12 hours
  const existing = await runAdmitted(signal, () => repo.getForServer(server.id));
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
  let installAttempted = false;
  try {
    installAttempted = true;
    const installResult = await runAdmitted(signal, () => host.installServer(config));
    if (!installResult.success) {
      log.info(`Changelog poll: could not connect to ${server.display_name}: ${installResult.error}`);
      return;
    }
    // Fetch changelog
    const changelog = await runAdmitted(signal, () => host.fetchChangelog(server.id));

    // List current skills
    const skillsResult = await runAdmitted(signal, () => host.listSkills(server.id));
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
      await runAdmitted(signal, () =>
        repo.addPendingOptIn(server.id, skillName, changelog?.currentVersion));
    }

    // Upsert changelog row
    await runAdmitted(signal, () => repo.upsert(server.id, {
      currentVersion: changelog?.currentVersion,
      rawText: changelog?.rawText,
      lastSeenSkills: currentSkills,
      lastKnownDestructiveSkills: currentDestructive,
    }));

    log.info(`Changelog poll: updated ${server.display_name}`, {
      version: changelog?.currentVersion ?? 'unknown',
      skills: currentSkills.length,
      newDestructive: newDestructiveSkills.length,
    });
  } finally {
    if (installAttempted) {
      await host.uninstallServer(server.id).catch(() => {
        // best-effort cleanup
      });
    }
  }
}
