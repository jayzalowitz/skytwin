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
} from '@skytwin/ironclaw-adapter';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
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
import { credentialRequirementRepository } from '@skytwin/db';
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
      ownerId: config.ironclawOwnerId,
    });
    registry.register('ironclaw', ironclawAdapter, IRONCLAW_TRUST_PROFILE);
    console.info('[execution] Registered IronClaw adapter:', config.ironclawApiUrl);
  } else {
    console.info('[execution] IronClaw not configured (no URL or secret) — skipping');
  }

  // Direct — local handler dispatch, always available
  const handlerRegistry = new ActionHandlerRegistry();
  handlerRegistry.register(new EmailActionHandler());
  handlerRegistry.register(new CalendarActionHandler());
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

/**
 * Singleton execution router instance.
 * Stores the promise (not the result) to prevent TOCTOU race conditions
 * when multiple requests trigger initialization concurrently.
 */
let _routerPromise: Promise<ExecutionRouter> | null = null;

export async function getExecutionRouter(): Promise<ExecutionRouter> {
  if (!_routerPromise) {
    _routerPromise = createExecutionRouter();
  }
  return _routerPromise;
}
