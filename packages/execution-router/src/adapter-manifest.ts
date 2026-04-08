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
  };

  return { valid: true, manifest };
}
