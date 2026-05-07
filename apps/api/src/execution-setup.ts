import { loadConfig } from '@skytwin/config';
import {
  RealIronClawAdapter,
  MockIronClawAdapter,
  DirectExecutionAdapter,
  ActionHandlerRegistry,
  EmailActionHandler,
  CalendarActionHandler,
  FinanceActionHandler,
  TaskActionHandler,
  SmartHomeActionHandler,
  SocialActionHandler,
  DocumentActionHandler,
  HealthActionHandler,
  DbCredentialProvider,
  isIronClawEnhancedAdapter,
} from '@skytwin/ironclaw-adapter';
import type { IronClawAdapter, IronClawEnhancedAdapter } from '@skytwin/ironclaw-adapter';
import {
  ExecutionRouter,
  AdapterRegistry,
  OpenClawAdapter,
  IRONCLAW_TRUST_PROFILE,
  OPENCLAW_TRUST_PROFILE,
  DIRECT_TRUST_PROFILE,
  MCP_HOST_TRUST_PROFILE,
  OPENCLAW_SKILLS,
  discoverAdapters,
} from '@skytwin/execution-router';
import { McpHost } from '@skytwin/mcp-host';
import { sharedMetricsCollector } from '@skytwin/observability';
import type { OpenClawCredentialRequirement } from '@skytwin/execution-router';
import { credentialRequirementRepository, ironClawToolRepository, serviceCredentialRepository, mcpServerChangelogRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import { sseManager } from './sse.js';

const log = createLogger('api:execution');

/**
 * Build the execution router with all available adapters registered.
 *
 * Adapter availability depends on configuration:
 * - IronClaw: registered if IRONCLAW_API_URL and IRONCLAW_WEBHOOK_SECRET are set
 * - Direct: always registered (local Gmail/Calendar handlers)
 * - OpenClaw: registered if OPENCLAW_API_URL is set
 *
 * The router selects the most trusted available adapter per action and
 * falls back through the chain on failure.
 */
export async function createExecutionRouter(): Promise<ExecutionRouter> {
  const config = loadConfig();
  const registry = new AdapterRegistry();
  const ironclawConfig = await resolveIronClawConfig(config);
  const openclawConfig = await resolveOpenClawConfig(config);

  // IronClaw — highest trust, requires a running IronClaw server.
  // Mock mode (USE_MOCK_IRONCLAW=true) registers an in-process simulator so
  // the execution router still has a primary adapter to route through in dev
  // and tests. Real mode registers the HTTP adapter when URL + secret exist.
  if (config.useMockIronclaw) {
    const ironclawAdapter: IronClawAdapter = new MockIronClawAdapter();
    registry.register('ironclaw', ironclawAdapter, IRONCLAW_TRUST_PROFILE);
    log.info('Registered Mock IronClaw adapter (USE_MOCK_IRONCLAW=true)');
  } else if (ironclawConfig.apiUrl && ironclawConfig.webhookSecret) {
    const ironclawAdapter: IronClawAdapter = new RealIronClawAdapter({
      apiUrl: ironclawConfig.apiUrl,
      webhookSecret: ironclawConfig.webhookSecret,
      gatewayToken: ironclawConfig.gatewayToken,
      ownerId: ironclawConfig.ownerId,
      defaultChannel: ironclawConfig.defaultChannel,
      preferChatCompletions: ironclawConfig.preferChatCompletions,
    });
    const ironclawSkills = isIronClawEnhancedAdapter(ironclawAdapter)
      ? await refreshIronClawToolCache(ironclawAdapter)
      : undefined;
    registry.register('ironclaw', ironclawAdapter, IRONCLAW_TRUST_PROFILE, ironclawSkills);
    if (isIronClawEnhancedAdapter(ironclawAdapter)) {
      await syncUnsyncedCredentialsToIronClaw(ironclawAdapter);
    }
    log.info('Registered IronClaw adapter', { apiUrl: ironclawConfig.apiUrl });
  } else {
    log.info('IronClaw not configured (no URL or secret) — skipping');
  }

  // Direct — local handler dispatch, always available
  const handlerRegistry = new ActionHandlerRegistry();
  const credentialProvider = new DbCredentialProvider();
  handlerRegistry.register(new EmailActionHandler(credentialProvider));
  handlerRegistry.register(new CalendarActionHandler(credentialProvider));
  handlerRegistry.register(new FinanceActionHandler());
  handlerRegistry.register(new TaskActionHandler());
  handlerRegistry.register(new SmartHomeActionHandler());
  handlerRegistry.register(new SocialActionHandler());
  handlerRegistry.register(new DocumentActionHandler());
  handlerRegistry.register(new HealthActionHandler());
  const directAdapter = new DirectExecutionAdapter(handlerRegistry);
  registry.register('direct', directAdapter, DIRECT_TRUST_PROFILE);
  log.info('Registered Direct adapter (local handlers: email, calendar, finance, task, smart-home, social, document, health)');

  // OpenClaw — community execution engine, only if configured
  if (openclawConfig.apiUrl) {
    const openclawAdapter = new OpenClawAdapter({
      apiUrl: openclawConfig.apiUrl,
      apiKey: openclawConfig.apiKey || undefined,
      onCredentialNeeded: async (req: OpenClawCredentialRequirement) => {
        // Persist the requirement so the Setup page discovers it
        for (const field of req.fields) {
          await credentialRequirementRepository.register({
            adapter: 'openclaw',
            integration: req.integration,
            integrationLabel: req.integrationLabel,
            description: req.description,
            fieldKey: field.key,
            fieldLabel: field.label,
            fieldPlaceholder: field.placeholder,
            isSecret: field.secret,
            isOptional: field.optional,
            skills: req.skills,
          });
        }
        // Notify all connected users
        sseManager.emitAll('credential:needed', {
          adapter: 'openclaw',
          integration: req.integration,
          label: req.integrationLabel,
          description: req.description,
          skills: req.skills,
        });
        log.info(`OpenClaw needs credentials for "${req.integrationLabel}" — registered requirement`);
      },
    });
    registry.register('openclaw', openclawAdapter, OPENCLAW_TRUST_PROFILE, OPENCLAW_SKILLS);
    log.info('Registered OpenClaw adapter', { apiUrl: openclawConfig.apiUrl });
  } else {
    log.info('OpenClaw not configured (no URL) — skipping');
  }

  // MCP host — Capability Acquisition Loop (#173). Always registered; servers
  // are added via the user-facing install flow (#176). On first boot the host
  // has zero servers and reports healthy with empty skill set.
  // onToolCall feeds the shared metrics collector for #183 observability.
  // onChangelogFetch persists changelog snapshots to DB (#184 AC#2).
  // checkPendingOptIn enforces the hard rail: destructive skills require
  //   explicit user acceptance before the MCP host will invoke them.
  const mcpHost = new McpHost({
    onToolCall: (event) => {
      sharedMetricsCollector.record({
        serverId: event.serverId,
        skillName: event.toolName,
        latencyMs: event.latencyMs,
        success: event.success,
        spendCents: event.spendCents,
        ts: event.ts,
      });
    },
    onChangelogFetch: (event) => {
      // Best-effort — errors must never block execution
      mcpServerChangelogRepository.upsert(event.serverId, {
        currentVersion: event.currentVersion,
        rawText: event.rawText ?? undefined,
        lastSeenSkills: [],
        lastKnownDestructiveSkills: [],
      }).catch((err) => {
        log.warn('onChangelogFetch: failed to persist changelog', {
          serverId: event.serverId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    checkPendingOptIn: (serverId, skillName) =>
      mcpServerChangelogRepository.hasPendingOptIn(serverId, skillName),
  });
  registry.register('mcp-host', mcpHost, MCP_HOST_TRUST_PROFILE);
  log.info('Registered MCP host adapter (Capability Acquisition Loop)');

  // Discover plugin adapters from filesystem (if configured)
  if (config.adapterPluginDir) {
    const discovered = await discoverAdapters(config.adapterPluginDir, registry);
    log.info(`Discovered ${discovered.length} plugin adapter(s) from ${config.adapterPluginDir}`);
  }

  return new ExecutionRouter(registry);
}

async function getStoredCredentials(service: string): Promise<Record<string, string>> {
  try {
    return await serviceCredentialRepository.getAsMap(service);
  } catch {
    return {};
  }
}

async function resolveIronClawConfig(config: ReturnType<typeof loadConfig>): Promise<{
  apiUrl: string;
  webhookSecret: string;
  gatewayToken: string;
  ownerId: string;
  defaultChannel: string;
  preferChatCompletions: boolean;
}> {
  const stored = await getStoredCredentials('ironclaw');
  return {
    apiUrl: stored['api_url'] || config.ironclawApiUrl,
    webhookSecret: stored['webhook_secret'] || config.ironclawWebhookSecret,
    gatewayToken: stored['gateway_token'] || config.ironclawGatewayToken,
    ownerId: stored['owner_id'] || config.ironclawOwnerId,
    defaultChannel: stored['default_channel'] || config.ironclawDefaultChannel,
    preferChatCompletions: config.ironclawPreferChat,
  };
}

async function resolveOpenClawConfig(config: ReturnType<typeof loadConfig>): Promise<{
  apiUrl: string;
  apiKey: string;
}> {
  const stored = await getStoredCredentials('openclaw');
  return {
    apiUrl: stored['api_url'] || config.openclawApiUrl,
    apiKey: stored['api_key'] || config.openclawApiKey,
  };
}

export async function getIronClawEnhancedAdapter(): Promise<IronClawEnhancedAdapter | null> {
  const router = await getExecutionRouter();
  const entry = router.getRegistry().get('ironclaw');
  if (!entry || !isIronClawEnhancedAdapter(entry.adapter)) return null;
  return entry.adapter;
}

export function ironClawCredentialName(service: string, credentialKey: string): string {
  return `${service}.${credentialKey}`;
}

export async function syncUnsyncedCredentialsToIronClaw(
  adapter: IronClawEnhancedAdapter,
): Promise<void> {
  const unsynced = await serviceCredentialRepository.getUnsyncedCredentials().catch(() => []);
  // Register concurrently in bounded batches of 5
  const BATCH_SIZE = 5;
  const synced: Array<{ service: string; key: string }> = [];
  for (let i = 0; i < unsynced.length; i += BATCH_SIZE) {
    const batch = unsynced.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (credential) => {
        const name = ironClawCredentialName(credential.service, credential.credential_key);
        await adapter.registerCredential(name, credential.credential_value);
        return { service: credential.service, key: credential.credential_key };
      }),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        synced.push(result.value);
      } else {
        log.warn('Failed to sync a credential to IronClaw', { error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
    }
  }
  // Batch markSynced for all successful registrations
  for (const { service, key } of synced) {
    await serviceCredentialRepository.markSynced(service, key).catch((err) => {
      log.warn('markSynced failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

export async function syncCredentialToIronClaw(
  service: string,
  credentialKey: string,
  credentialValue: string,
): Promise<boolean> {
  const adapter = await getIronClawEnhancedAdapter();
  if (!adapter) return false;

  const name = ironClawCredentialName(service, credentialKey);
  try {
    await adapter.registerCredential(name, credentialValue);
    await serviceCredentialRepository.markSynced(service, credentialKey);
    return true;
  } catch (error) {
    log.warn(`Failed to sync credential for ${service} to IronClaw`, { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function revokeCredentialFromIronClaw(
  service: string,
  credentialKey: string,
): Promise<boolean> {
  const adapter = await getIronClawEnhancedAdapter();
  if (!adapter) return false;

  try {
    await adapter.revokeCredential(ironClawCredentialName(service, credentialKey));
    return true;
  } catch (error) {
    log.warn(`Failed to revoke credential for ${service} from IronClaw`, { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function refreshIronClawToolCache(
  adapter?: IronClawEnhancedAdapter,
): Promise<Set<string> | undefined> {
  const enhanced = adapter ?? await getIronClawEnhancedAdapter();
  if (!enhanced) return await readCachedIronClawSkills();

  try {
    const tools = await enhanced.discoverTools();
    if (tools.length > 0) {
      await ironClawToolRepository.upsertMany(tools.map((tool) => ({
        toolName: tool.name,
        description: tool.description,
        actionTypes: tool.actionTypes,
        requiresCredentials: tool.requiresCredentials,
      })));
      return new Set(tools.flatMap((tool) => tool.actionTypes));
    }
    return await readCachedIronClawSkills() ?? new Set<string>();
  } catch (error) {
    log.warn('IronClaw tool discovery failed, using cache if available', { error: error instanceof Error ? error.message : String(error) });
  }

  return await readCachedIronClawSkills();
}

async function readCachedIronClawSkills(): Promise<Set<string> | undefined> {
  const cached = await ironClawToolRepository.getSkillSet().catch(() => new Set<string>());
  return cached.size > 0 ? cached : undefined;
}

/**
 * Singleton execution router instance.
 * Stores the promise (not the result) to prevent TOCTOU race conditions
 * when multiple requests trigger initialization concurrently.
 */
let _routerPromise: Promise<ExecutionRouter> | null = null;

export async function getExecutionRouter(): Promise<ExecutionRouter> {
  if (!_routerPromise) {
    _routerPromise = createExecutionRouter().catch((err) => {
      _routerPromise = null; // Allow retry on next call
      throw err;
    });
  }
  return _routerPromise;
}

export function resetExecutionRouterForConfigChange(): void {
  _routerPromise = null;
}
