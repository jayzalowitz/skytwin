import { Router } from 'express';
import { loadConfig } from '@skytwin/config';
import { serviceCredentialRepository, credentialRequirementRepository } from '@skytwin/db';
import {
  getExecutionRouter,
  getIronClawEnhancedAdapter,
  ironClawCredentialName,
  revokeCredentialFromIronClaw,
  resetExecutionRouterForConfigChange,
  syncCredentialToIronClaw,
} from '../execution-setup.js';
import { sseManager } from '../sse.js';

/**
 * Known service definitions with their credential fields.
 * Google is the only one requiring manual user setup.
 * IronClaw/OpenClaw auto-detect but can be overridden.
 */
const SERVICE_SCHEMAS: Record<
  string,
  {
    label: string;
    description: string;
    autoDetects: boolean;
    fields: Array<{ key: string; label: string; placeholder: string; secret?: boolean; optional?: boolean }>;
  }
> = {
  google: {
    label: 'Google (Gmail + Calendar)',
    description:
      'Connect your Google account so your twin can read your email and calendar.',
    autoDetects: false,
    fields: [
      {
        key: 'client_id',
        label: 'Client ID',
        placeholder: 'e.g. 123456789-abc.apps.googleusercontent.com',
      },
      {
        key: 'client_secret',
        label: 'Client Secret',
        placeholder: 'e.g. GOCSPX-...',
        secret: true,
      },
      {
        key: 'redirect_uri',
        label: 'Redirect URI (usually leave as default)',
        placeholder: 'http://localhost:3100/api/oauth/google/callback',
        optional: true,
      },
    ],
  },
  ironclaw: {
    label: 'IronClaw',
    description:
      'IronClaw is the execution server. It auto-detects on localhost:4000.',
    autoDetects: true,
    fields: [
      { key: 'api_url', label: 'API URL', placeholder: 'http://localhost:4000' },
      { key: 'webhook_secret', label: 'Webhook Secret', placeholder: 'shared secret', secret: true },
      { key: 'owner_id', label: 'Owner ID', placeholder: 'skytwin-default' },
    ],
  },
  openclaw: {
    label: 'OpenClaw (Local AI)',
    description:
      'OpenClaw uses a local LLM for reasoning. Auto-detects if running.',
    autoDetects: true,
    fields: [
      { key: 'api_url', label: 'API URL', placeholder: 'http://localhost:3456' },
      { key: 'api_key', label: 'API Key', placeholder: 'API key', secret: true, optional: true },
    ],
  },
};

const EXECUTION_ENGINE_SERVICES = new Set(['ironclaw', 'openclaw']);
const EXECUTION_ENGINE_URL_KEYS = new Set(['api_url']);

/**
 * Create the credentials management router.
 */
export function createCredentialsRouter(): Router {
  const router = Router();

  /**
   * GET /api/credentials/schema
   *
   * Returns static + dynamic service schemas so the UI can render all
   * integration sections. Dynamic requirements come from adapters that
   * have registered credential needs for their skills.
   */
  router.get('/schema', async (_req, res, next) => {
    try {
      const grouped = await credentialRequirementRepository.getAllGrouped();

      // Convert dynamic requirements into the same shape as static schemas
      const dynamic: Record<string, {
        label: string;
        description: string;
        autoDetects: boolean;
        adapter: string;
        skills: string[];
        fields: Array<{ key: string; label: string; placeholder: string; secret?: boolean; optional?: boolean }>;
      }> = {};

      for (const [key, group] of grouped) {
        dynamic[key] = {
          label: group.label,
          description: group.description ?? '',
          autoDetects: false,
          adapter: group.adapter,
          skills: Array.from(new Set(group.fields.flatMap((f) => f.skills))),
          fields: group.fields.map((f) => ({
            key: f.field_key,
            label: f.field_label,
            placeholder: f.field_placeholder ?? '',
            secret: f.is_secret,
            optional: f.is_optional,
          })),
        };
      }

      res.json({ services: SERVICE_SCHEMAS, integrations: dynamic });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/credentials/status
   *
   * Live health status of execution adapters, Google config,
   * and unmet credential requirements.
   */
  router.get('/status', async (_req, res, next) => {
    try {
      const config = loadConfig();
      const executionRouter = await getExecutionRouter();
      const registry = executionRouter.getRegistry();
      const entries = registry.getAll();

      // Check each adapter's health in parallel
      const healthResults: Record<string, { registered: boolean; healthy: boolean; url: string }> = {};

      const healthChecks = Array.from(entries.entries()).map(async ([name, entry]) => {
        let healthy = false;
        try {
          const result = await entry.adapter.healthCheck();
          healthy = result.healthy;
        } catch {
          healthy = false;
        }
        const urls: Record<string, string> = {
          ironclaw: config.ironclawApiUrl,
          openclaw: config.openclawApiUrl,
          direct: 'local',
        };
        healthResults[name] = { registered: true, healthy, url: urls[name] ?? '' };
      });

      await Promise.allSettled(healthChecks);

      // Check Google OAuth config (env vars or DB)
      let googleConfigured = !!(config.googleClientId && config.googleClientSecret);
      if (!googleConfigured) {
        try {
          const dbCreds = await serviceCredentialRepository.getAsMap('google');
          googleConfigured = !!(dbCreds['client_id'] && dbCreds['client_secret']);
        } catch { /* table may not exist yet */ }
      }

      // Check for unmet credential requirements
      const unmetIntegrations = await getUnmetRequirements();

      res.json({
        adapters: {
          ironclaw: healthResults['ironclaw'] ?? { registered: false, healthy: false, url: config.ironclawApiUrl },
          direct: healthResults['direct'] ?? { registered: true, healthy: true, url: 'local' },
          openclaw: healthResults['openclaw'] ?? { registered: false, healthy: false, url: config.openclawApiUrl },
        },
        google: { configured: googleConfigured },
        unmetIntegrations,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/credentials/requirements
   *
   * List all adapter-registered credential requirements, grouped by integration.
   */
  router.get('/requirements', async (_req, res, next) => {
    try {
      const grouped = await credentialRequirementRepository.getAllGrouped();
      const result: Array<{
        key: string;
        adapter: string;
        integration: string;
        label: string;
        description: string | null;
        fields: Array<{ key: string; label: string; placeholder: string | null; secret: boolean; optional: boolean }>;
        skills: string[];
      }> = [];

      for (const [key, group] of grouped) {
        result.push({
          key,
          adapter: group.adapter,
          integration: key.split(':')[1] ?? key,
          label: group.label,
          description: group.description,
          fields: group.fields.map((f) => ({
            key: f.field_key,
            label: f.field_label,
            placeholder: f.field_placeholder,
            secret: f.is_secret,
            optional: f.is_optional,
          })),
          skills: Array.from(new Set(group.fields.flatMap((f) => f.skills))),
        });
      }

      res.json({ requirements: result });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/credentials/requirements
   *
   * Register credential requirements for an adapter's integration.
   * Called by adapters (e.g. OpenClaw) when they add a skill that needs credentials.
   *
   * Body: {
   *   adapter: "openclaw",
   *   integration: "twitter",
   *   integrationLabel: "Twitter / X",
   *   description: "Post tweets and read your timeline",
   *   fields: [
   *     { key: "api_key", label: "API Key", placeholder: "...", secret: true, optional: false }
   *   ],
   *   skills: ["social_media_post", "draft_social_post"]
   * }
   */
  router.post('/requirements', async (req, res, next) => {
    try {
      const body = req.body as {
        adapter?: string;
        integration?: string;
        integrationLabel?: string;
        description?: string;
        fields?: Array<{
          key: string;
          label: string;
          placeholder?: string;
          secret?: boolean;
          optional?: boolean;
        }>;
        skills?: string[];
        userId?: string;
      };

      if (!body.adapter || !body.integration || !body.integrationLabel || !body.fields?.length) {
        res.status(400).json({ error: 'Missing required fields: adapter, integration, integrationLabel, fields' });
        return;
      }

      const registered = [];
      for (const field of body.fields) {
        if (!field.key || !field.label) continue;

        const row = await credentialRequirementRepository.register({
          adapter: body.adapter,
          integration: body.integration,
          integrationLabel: body.integrationLabel,
          description: body.description,
          fieldKey: field.key,
          fieldLabel: field.label,
          fieldPlaceholder: field.placeholder,
          isSecret: field.secret,
          isOptional: field.optional,
          skills: body.skills ?? [],
        });
        registered.push(row.field_key);
      }

      // Emit SSE notification to all connected users that a new integration is needed
      if (body.userId) {
        sseManager.emit(body.userId, 'credential:needed', {
          adapter: body.adapter,
          integration: body.integration,
          label: body.integrationLabel,
          description: body.description,
          skills: body.skills,
        });
      } else {
        // Broadcast to all users
        sseManager.emitAll('credential:needed', {
          adapter: body.adapter,
          integration: body.integration,
          label: body.integrationLabel,
          description: body.description,
          skills: body.skills,
        });
      }

      res.json({ status: 'ok', registered });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/credentials/unmet
   *
   * Returns integrations that have requirements registered but no
   * credentials saved yet. Used by the dashboard to show a banner.
   */
  router.get('/unmet', async (_req, res, next) => {
    try {
      const unmet = await getUnmetRequirements();
      res.json({ unmet });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/credentials/ironclaw-status
   *
   * Compare SkyTwin's stored service credentials with IronClaw's credential
   * store so the setup page can show sync status.
   */
  router.get('/ironclaw-status', async (_req, res, next) => {
    try {
      const [rows, adapter] = await Promise.all([
        serviceCredentialRepository.getAll(),
        getIronClawEnhancedAdapter(),
      ]);

      let ironclawCredentials = new Set<string>();
      let reachable = false;
      if (adapter) {
        try {
          const list = await adapter.listCredentials();
          ironclawCredentials = new Set(list.map((credential) => credential.name));
          reachable = true;
        } catch {
          reachable = false;
        }
      }

      res.json({
        reachable,
        credentials: rows.map((row) => {
          const name = ironClawCredentialName(row.service, row.credential_key);
          return {
            service: row.service,
            credentialKey: row.credential_key,
            ironclawName: name,
            synced: Boolean(row.ironclaw_synced_at) && ironclawCredentials.has(name),
            syncedAt: row.ironclaw_synced_at,
            presentInIronClaw: ironclawCredentials.has(name),
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/credentials
   *
   * List all stored credentials (values masked for secret fields).
   */
  router.get('/', async (_req, res, next) => {
    try {
      const [rows, dynamicSecrets] = await Promise.all([
        serviceCredentialRepository.getAll(),
        getDynamicSecretKeys(),
      ]);
      const masked = rows.map((row) => maskRow(row, dynamicSecrets));
      res.json({ credentials: masked });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/credentials/:service/sync
   *
   * Manually re-sync one service's stored credentials to IronClaw.
   */
  router.post('/:service/sync', async (req, res, next) => {
    try {
      const { service } = req.params;
      const adapter = await getIronClawEnhancedAdapter();
      if (!adapter) {
        res.status(503).json({ error: 'IronClaw is unavailable for credential sync.' });
        return;
      }

      const rows = await serviceCredentialRepository.getByService(service);
      let synced = 0;
      for (const row of rows) {
        const name = ironClawCredentialName(row.service, row.credential_key);
        try {
          await adapter.registerCredential(name, row.credential_value);
          await serviceCredentialRepository.markSynced(row.service, row.credential_key);
          synced++;
        } catch {
          // Individual credential sync failure is non-fatal
        }
      }
      res.json({ service, synced, total: rows.length });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/credentials/:service
   *
   * Get credentials for a specific service (values masked for secret fields).
   */
  router.get('/:service', async (req, res, next) => {
    try {
      const { service } = req.params;
      if (['status', 'schema', 'requirements', 'unmet', 'ironclaw-status'].includes(service)) { next(); return; }
      const [rows, dynamicSecrets] = await Promise.all([
        serviceCredentialRepository.getByService(service),
        getDynamicSecretKeys(),
      ]);
      const masked = rows.map((row) => maskRow(row, dynamicSecrets));
      res.json({ credentials: masked });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/credentials/:service
   *
   * Save credentials for a service. Accepts both static schemas and
   * dynamic integration keys (adapter:integration format).
   */
  router.put('/:service', async (req, res, next) => {
    try {
      const { service } = req.params;
      const credentials = req.body?.credentials as Record<string, string> | undefined;

      if (!credentials || typeof credentials !== 'object') {
        res.status(400).json({ error: 'Missing credentials object in request body' });
        return;
      }

      // Check static schema first, then dynamic requirements
      const schema = SERVICE_SCHEMAS[service];
      let validKeys: Set<string>;

      if (schema) {
        validKeys = new Set(schema.fields.map((f) => f.key));
      } else {
        // Check dynamic requirements
        const parts = service.includes(':') ? service.split(':') : ['', service];
        const adapter = parts[0] ?? '';
        const integration = parts[1] ?? service;
        const reqs = adapter
          ? await credentialRequirementRepository.getByAdapter(adapter)
          : await credentialRequirementRepository.getByIntegration(integration);
        const matchingReqs = reqs.filter((r) =>
          adapter ? r.integration === integration : true,
        );
        if (matchingReqs.length === 0) {
          res.status(400).json({ error: `Unknown service: ${service}` });
          return;
        }
        validKeys = new Set(matchingReqs.map((r) => r.field_key));
      }

      const saved = [];
      for (const [key, value] of Object.entries(credentials)) {
        if (!validKeys.has(key)) continue;
        if (typeof value !== 'string' || value.trim() === '') continue;
        const trimmedValue = value.trim();
        const validationError = validateCredentialValue(service, key, trimmedValue);
        if (validationError) {
          res.status(400).json({ error: validationError });
          return;
        }

        const row = await serviceCredentialRepository.upsert({
          service,
          credentialKey: key,
          credentialValue: trimmedValue,
          label: key,
        });
        const ironclawSynced = EXECUTION_ENGINE_SERVICES.has(service)
          ? false
          : await syncCredentialToIronClaw(service, key, trimmedValue);
        saved.push({
          service: row.service,
          credentialKey: row.credential_key,
          hasValue: true,
          ironclawSynced,
        });
      }

      if (EXECUTION_ENGINE_SERVICES.has(service) && saved.length > 0) {
        resetExecutionRouterForConfigChange();
      }

      res.json({ saved, status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/credentials/:service/:key
   *
   * Remove a specific credential.
   */
  router.delete('/:service/:key', async (req, res, next) => {
    try {
      const { service, key } = req.params;
      const deleted = await serviceCredentialRepository.delete(service, key);
      if (deleted) {
        if (EXECUTION_ENGINE_SERVICES.has(service)) {
          resetExecutionRouterForConfigChange();
        } else {
          await revokeCredentialFromIronClaw(service, key);
        }
      }
      res.json({ deleted, service, key });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function validateCredentialValue(service: string, key: string, value: string): string | null {
  if (!EXECUTION_ENGINE_SERVICES.has(service) || !EXECUTION_ENGINE_URL_KEYS.has(key)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `Invalid ${service} API URL. Enter a valid http:// or https:// URL.`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Invalid ${service} API URL. Only http:// and https:// are supported.`;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return `Invalid ${service} API URL. Metadata service endpoints are not allowed.`;
  }

  if (parsed.username || parsed.password) {
    return `Invalid ${service} API URL. Put credentials in the credential fields, not in the URL.`;
  }

  return null;
}

/**
 * Check which integrations have requirements but missing credentials.
 */
async function getUnmetRequirements(): Promise<
  Array<{ key: string; adapter: string; integration: string; label: string; description: string | null; missingFields: string[]; skills: string[] }>
> {
  try {
    const grouped = await credentialRequirementRepository.getAllGrouped();
    const unmet: Array<{
      key: string;
      adapter: string;
      integration: string;
      label: string;
      description: string | null;
      missingFields: string[];
      skills: string[];
    }> = [];

    for (const [key, group] of grouped) {
      const serviceKey = key; // adapter:integration
      const creds = await serviceCredentialRepository.getAsMap(serviceKey);
      const requiredFields = group.fields.filter((f) => !f.is_optional);
      const missing = requiredFields.filter((f) => !creds[f.field_key]);

      if (missing.length > 0) {
        unmet.push({
          key,
          adapter: group.adapter,
          integration: key.split(':')[1] ?? key,
          label: group.label,
          description: group.description,
          missingFields: missing.map((f) => f.field_label),
          skills: Array.from(new Set(group.fields.flatMap((f) => f.skills))),
        });
      }
    }

    return unmet;
  } catch {
    return [];
  }
}

function maskValue(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/**
 * Build a set of "service:field_key" pairs that are marked is_secret
 * in the dynamic credential_requirements table.
 */
async function getDynamicSecretKeys(): Promise<Set<string>> {
  try {
    const allReqs = await credentialRequirementRepository.getAll();
    const secrets = new Set<string>();
    for (const req of allReqs) {
      if (req.is_secret) {
        secrets.add(`${req.adapter}:${req.integration}:${req.field_key}`);
      }
    }
    return secrets;
  } catch {
    return new Set();
  }
}

function maskRow(
  row: { id: string; service: string; credential_key: string; credential_value: string; label: string | null; updated_at: Date },
  dynamicSecrets?: Set<string>,
) {
  const schema = SERVICE_SCHEMAS[row.service];
  const fieldDef = schema?.fields.find((f) => f.key === row.credential_key);

  // Check static schema first, then dynamic requirements, then heuristic fallback
  const dynamicKey = `${row.service}:${row.credential_key}`;
  const isSecret = fieldDef?.secret
    ?? (dynamicSecrets?.has(dynamicKey)
      || row.credential_key.includes('secret')
      || row.credential_key.includes('key')
      || row.credential_key.includes('token')
      || row.credential_key.includes('password'));

  return {
    id: row.id,
    service: row.service,
    credentialKey: row.credential_key,
    credentialValue: isSecret ? maskValue(row.credential_value) : row.credential_value,
    hasValue: row.credential_value.length > 0,
    label: row.label,
    updatedAt: row.updated_at,
  };
}
