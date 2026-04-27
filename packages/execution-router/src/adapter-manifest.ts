/**
 * Manifest file shape for a dynamically discovered adapter plugin.
 *
 * Each plugin is a directory containing a manifest.json and an entry point module.
 * The entry point must default-export a factory function: (config) => IronClawAdapter
 */
export interface AdapterManifest {
  name: string;
  version: string;
  entryPoint: string;
  trustProfile: {
    reversibilityGuarantee: 'full' | 'partial' | 'none';
    authModel: 'hmac' | 'oauth' | 'api_key' | 'none';
    auditTrail: boolean;
    riskModifier: number;
  };
  skills: string[];
  healthEndpoint?: string;
  /**
   * Default config passed to the plugin's factory function. Use this when
   * the adapter needs configuration to construct correctly (e.g. an API
   * URL, channel id). Without this, the loader falls back to passing an
   * empty object and the adapter is responsible for its own defaults.
   */
  defaultConfig?: Record<string, unknown>;
}

/**
 * Validate that a parsed JSON object is a valid AdapterManifest.
 */
export function validateManifest(raw: unknown): { valid: true; manifest: AdapterManifest } | { valid: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Manifest must be a JSON object' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || !obj['name']) {
    return { valid: false, error: 'Manifest must have a non-empty "name" string' };
  }
  if (typeof obj['version'] !== 'string') {
    return { valid: false, error: 'Manifest must have a "version" string' };
  }
  if (typeof obj['entryPoint'] !== 'string' || !obj['entryPoint']) {
    return { valid: false, error: 'Manifest must have a non-empty "entryPoint" string' };
  }
  if (!Array.isArray(obj['skills'])) {
    return { valid: false, error: 'Manifest must have a "skills" array' };
  }

  const tp = obj['trustProfile'];
  if (!tp || typeof tp !== 'object') {
    return { valid: false, error: 'Manifest must have a "trustProfile" object' };
  }

  const profile = tp as Record<string, unknown>;
  const validRevGuarantees = new Set(['full', 'partial', 'none']);
  const validAuthModels = new Set(['hmac', 'oauth', 'api_key', 'none']);

  if (!validRevGuarantees.has(profile['reversibilityGuarantee'] as string)) {
    return { valid: false, error: 'trustProfile.reversibilityGuarantee must be full|partial|none' };
  }
  if (!validAuthModels.has(profile['authModel'] as string)) {
    return { valid: false, error: 'trustProfile.authModel must be hmac|oauth|api_key|none' };
  }

  const manifest: AdapterManifest = {
    name: obj['name'] as string,
    version: obj['version'] as string,
    entryPoint: obj['entryPoint'] as string,
    trustProfile: {
      reversibilityGuarantee: profile['reversibilityGuarantee'] as 'full' | 'partial' | 'none',
      authModel: profile['authModel'] as 'hmac' | 'oauth' | 'api_key' | 'none',
      auditTrail: profile['auditTrail'] === true,
      riskModifier: (typeof profile['riskModifier'] === 'number' && Number.isFinite(profile['riskModifier']))
        ? Math.max(Math.round(profile['riskModifier']), 2)
        : 2,
    },
    skills: (obj['skills'] as unknown[]).filter((s) => typeof s === 'string') as string[],
    healthEndpoint: typeof obj['healthEndpoint'] === 'string' ? obj['healthEndpoint'] : undefined,
    defaultConfig: (obj['defaultConfig'] && typeof obj['defaultConfig'] === 'object' && !Array.isArray(obj['defaultConfig']))
      ? obj['defaultConfig'] as Record<string, unknown>
      : undefined,
  };

  return { valid: true, manifest };
}

/**
 * Required methods on an `IronClawAdapter` instance. The discovery loader
 * checks for these so plugins that silently return malformed objects fail
 * fast at load time rather than surfacing as a NoAdapterError under load.
 */
export const REQUIRED_ADAPTER_METHODS: readonly string[] = [
  'buildPlan',
  'execute',
  'rollback',
  'healthCheck',
] as const;

export function isAdapterShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return REQUIRED_ADAPTER_METHODS.every((m) => typeof obj[m] === 'function');
}
