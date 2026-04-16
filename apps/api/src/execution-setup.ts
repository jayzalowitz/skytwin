import { loadConfig } from '@skytwin/config';
import {
  RealIronClawAdapter,
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
  OPENCLAW_SKILLS,
  discoverAdapters,
} from '@skytwin/execution-router';
import type { OpenClawCredentialRequirement } from '@skytwin/execution-router';
import { credentialRequirementRepository, ironClawToolRepository, serviceCredentialRepository } from '@skytwin/db';
import { sseManager } from './sse.js';

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

  // IronClaw — highest trust, requires a running IronClaw server
  if (config.ironclawApiUrl && config.ironclawWebhookSecret) {
    const ironclawAdapter: IronClawAdapter = new RealIronClawAdapter({
      apiUrl: config.ironclawApiUrl,
      webhookSecret: config.ironclawWebhookSecret,
      gatewayToken: config.ironclawGatewayToken,
      ownerId: config.ironclawOwnerId,
      defaultChannel: config.ironclawDefaultChannel,
      preferChatCompletions: config.ironclawPreferChat,
    });
    const ironclawSkills = isIronClawEnhancedAdapter(ironclawAdapter)
      ? await refreshIronClawToolCache(ironclawAdapter)
      : new Set<string>();
    registry.register('ironclaw', ironclawAdapter, IRONCLAW_TRUST_PROFILE, ironclawSkills);
    if (isIronClawEnhancedAdapter(ironclawAdapter)) {
      await syncUnsyncedCredentialsToIronClaw(ironclawAdapter);
    }
    console.info('[execution] Registered IronClaw adapter:', config.ironclawApiUrl);
  } else {
    console.info('[execution] IronClaw not configured (no URL or secret) — skipping');
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
  console.info('[execution] Registered Direct adapter (local handlers: email, calendar, finance, task, smart-home, social, document, health)');

  // OpenClaw — community execution engine, only if configured
  if (config.openclawApiUrl) {
    const openclawAdapter = new OpenClawAdapter({
      apiUrl: config.openclawApiUrl,
      apiKey: config.openclawApiKey || undefined,
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
        console.info(`[execution] OpenClaw needs credentials for "${req.integrationLabel}" — registered requirement`);
      },
    });
    registry.register('openclaw', openclawAdapter, OPENCLAW_TRUST_PROFILE, OPENCLAW_SKILLS);
    console.info('[execution] Registered OpenClaw adapter:', config.openclawApiUrl);
  } else {
    console.info('[execution] OpenClaw not configured (no URL) — skipping');
  }

  // Discover plugin adapters from filesystem (if configured)
  if (config.adapterPluginDir) {
    const discovered = await discoverAdapters(config.adapterPluginDir, registry);
    console.info(`[execution] Discovered ${discovered.length} plugin adapter(s) from ${config.adapterPluginDir}`);
  }

  return new ExecutionRouter(registry);
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
  let configured = new Set<string>();
  try {
    configured = new Set((await adapter.listCredentials()).map((credential) => credential.name));
  } catch (error) {
    console.warn('[execution] Could not list IronClaw credentials before sync:', error instanceof Error ? error.message : String(error));
  }

  const unsynced = await serviceCredentialRepository.getUnsyncedCredentials().catch(() => []);
  // Register concurrently in bounded batches of 5
  const BATCH_SIZE = 5;
  const synced: Array<{ service: string; key: string }> = [];
  for (let i = 0; i < unsynced.length; i += BATCH_SIZE) {
    const batch = unsynced.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (credential) => {
        const name = ironClawCredentialName(credential.service, credential.credential_key);
        if (!configured.has(name)) {
          await adapter.registerCredential(name, credential.credential_value);
        }
        return { service: credential.service, key: credential.credential_key };
      }),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        synced.push(result.value);
      } else {
        console.warn('[execution] Failed to sync a credential to IronClaw:', result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }
  }
  // Batch markSynced for all successful registrations
  for (const { service, key } of synced) {
    await serviceCredentialRepository.markSynced(service, key).catch((err) => {
      console.warn('[execution] markSynced failed:', err instanceof Error ? err.message : String(err));
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
    console.warn(`[execution] Failed to sync credential for ${service} to IronClaw:`, error instanceof Error ? error.message : String(error));
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
    console.warn(`[execution] Failed to revoke credential for ${service} from IronClaw:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function refreshIronClawToolCache(
  adapter?: IronClawEnhancedAdapter,
): Promise<Set<string>> {
  const enhanced = adapter ?? await getIronClawEnhancedAdapter();
  if (!enhanced) return await ironClawToolRepository.getSkillSet().catch(() => new Set<string>());

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
  } catch (error) {
    console.warn('[execution] IronClaw tool discovery failed, using cache if available:', error instanceof Error ? error.message : String(error));
  }

  return await ironClawToolRepository.getSkillSet().catch(() => new Set<string>());
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
