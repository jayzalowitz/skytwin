import { describe, it, expect } from 'vitest';
import { validateManifest, isAdapterShape, REQUIRED_ADAPTER_METHODS } from '../adapter-manifest.js';
// ── Test helpers ─────────────────────────────────────────────────────

function makeValidManifestInput(): Record<string, unknown> {
  return {
    name: 'my-adapter',
    version: '1.0.0',
    entryPoint: './dist/index.js',
    trustProfile: {
      reversibilityGuarantee: 'full',
      authModel: 'hmac',
      auditTrail: true,
      riskModifier: 5,
    },
    skills: ['send_email', 'archive_email'],
    healthEndpoint: '/health',
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('validateManifest', () => {
  describe('valid manifests', () => {
    it('accepts a fully valid manifest', () => {
      const input = makeValidManifestInput();
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (!result.valid) return;

      expect(result.manifest.name).toBe('my-adapter');
      expect(result.manifest.version).toBe('1.0.0');
      expect(result.manifest.entryPoint).toBe('./dist/index.js');
      expect(result.manifest.skills).toEqual(['send_email', 'archive_email']);
      expect(result.manifest.healthEndpoint).toBe('/health');
      expect(result.manifest.trustProfile.reversibilityGuarantee).toBe('full');
      expect(result.manifest.trustProfile.authModel).toBe('hmac');
      expect(result.manifest.trustProfile.auditTrail).toBe(true);
    });

    it('accepts all valid reversibilityGuarantee values', () => {
      for (const value of ['full', 'partial', 'none'] as const) {
        const input = makeValidManifestInput();
        (input['trustProfile'] as Record<string, unknown>)['reversibilityGuarantee'] = value;
        const result = validateManifest(input);
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.manifest.trustProfile.reversibilityGuarantee).toBe(value);
        }
      }
    });

    it('accepts all valid authModel values', () => {
      for (const value of ['hmac', 'oauth', 'api_key', 'none'] as const) {
        const input = makeValidManifestInput();
        (input['trustProfile'] as Record<string, unknown>)['authModel'] = value;
        const result = validateManifest(input);
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.manifest.trustProfile.authModel).toBe(value);
        }
      }
    });

    it('accepts a manifest without optional healthEndpoint', () => {
      const input = makeValidManifestInput();
      delete input['healthEndpoint'];
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.healthEndpoint).toBeUndefined();
      }
    });

    it('filters non-string entries from skills array', () => {
      const input = makeValidManifestInput();
      input['skills'] = ['send_email', 42, true, 'archive_email', null];
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.skills).toEqual(['send_email', 'archive_email']);
      }
    });

    it('coerces auditTrail to false when not exactly true', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['auditTrail'] = 'yes';
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.auditTrail).toBe(false);
      }
    });
  });

  describe('missing fields', () => {
    it('rejects null input', () => {
      const result = validateManifest(null);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('JSON object');
      }
    });

    it('rejects non-object input', () => {
      const result = validateManifest('not-an-object');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('JSON object');
      }
    });

    it('rejects undefined input', () => {
      const result = validateManifest(undefined);
      expect(result.valid).toBe(false);
    });

    it('rejects manifest without name', () => {
      const input = makeValidManifestInput();
      delete input['name'];
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('name');
      }
    });

    it('rejects manifest with empty name', () => {
      const input = makeValidManifestInput();
      input['name'] = '';
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('name');
      }
    });

    it('rejects manifest without version', () => {
      const input = makeValidManifestInput();
      delete input['version'];
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('version');
      }
    });

    it('rejects manifest without entryPoint', () => {
      const input = makeValidManifestInput();
      delete input['entryPoint'];
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('entryPoint');
      }
    });

    it('rejects manifest with empty entryPoint', () => {
      const input = makeValidManifestInput();
      input['entryPoint'] = '';
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('entryPoint');
      }
    });

    it('rejects manifest without skills', () => {
      const input = makeValidManifestInput();
      delete input['skills'];
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('skills');
      }
    });

    it('rejects manifest without trustProfile', () => {
      const input = makeValidManifestInput();
      delete input['trustProfile'];
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('trustProfile');
      }
    });

    it('rejects manifest with null trustProfile', () => {
      const input = makeValidManifestInput();
      input['trustProfile'] = null;
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('trustProfile');
      }
    });
  });

  describe('invalid trustProfile values', () => {
    it('rejects invalid reversibilityGuarantee', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['reversibilityGuarantee'] = 'maybe';
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('reversibilityGuarantee');
        expect(result.error).toContain('full|partial|none');
      }
    });

    it('rejects invalid authModel', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['authModel'] = 'bearer';
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('authModel');
        expect(result.error).toContain('hmac|oauth|api_key|none');
      }
    });

    it('rejects missing reversibilityGuarantee', () => {
      const input = makeValidManifestInput();
      delete (input['trustProfile'] as Record<string, unknown>)['reversibilityGuarantee'];
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('reversibilityGuarantee');
      }
    });

    it('rejects missing authModel', () => {
      const input = makeValidManifestInput();
      delete (input['trustProfile'] as Record<string, unknown>)['authModel'];
      const result = validateManifest(input);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('authModel');
      }
    });
  });

  describe('riskModifier clamping', () => {
    it('clamps riskModifier to minimum of 2 when provided value is below 2', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['riskModifier'] = 0;
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.riskModifier).toBe(2);
      }
    });

    it('clamps riskModifier to minimum of 2 for negative values', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['riskModifier'] = -10;
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.riskModifier).toBe(2);
      }
    });

    it('preserves riskModifier when >= 2', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['riskModifier'] = 5;
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.riskModifier).toBe(5);
      }
    });

    it('rounds riskModifier to nearest integer', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['riskModifier'] = 3.7;
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.riskModifier).toBe(4);
      }
    });

    it('defaults riskModifier to 2 when not a number', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['riskModifier'] = 'high';
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.riskModifier).toBe(2);
      }
    });

    it('defaults riskModifier to 2 when missing', () => {
      const input = makeValidManifestInput();
      delete (input['trustProfile'] as Record<string, unknown>)['riskModifier'];
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.riskModifier).toBe(2);
      }
    });

    it('defaults riskModifier to 2 for NaN', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['riskModifier'] = NaN;
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.riskModifier).toBe(2);
      }
    });

    it('defaults riskModifier to 2 for Infinity', () => {
      const input = makeValidManifestInput();
      (input['trustProfile'] as Record<string, unknown>)['riskModifier'] = Infinity;
      const result = validateManifest(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.trustProfile.riskModifier).toBe(2);
      }
    });

    it('parses defaultConfig when present and a plain object', () => {
      const input = makeValidManifestInput();
      input['defaultConfig'] = { apiUrl: 'https://x.example.com', channel: 'main' };
      const result = validateManifest(input);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.defaultConfig).toEqual({ apiUrl: 'https://x.example.com', channel: 'main' });
      }
    });

    it('drops defaultConfig when missing', () => {
      const result = validateManifest(makeValidManifestInput());
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.manifest.defaultConfig).toBeUndefined();
      }
    });

    it('drops defaultConfig when not an object (string, array, number)', () => {
      const inputs = ['hello', [1, 2, 3], 42, true];
      for (const v of inputs) {
        const input = makeValidManifestInput();
        input['defaultConfig'] = v as unknown;
        const result = validateManifest(input);
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.manifest.defaultConfig).toBeUndefined();
        }
      }
    });
  });
});

describe('isAdapterShape', () => {
  function validShape(): Record<string, unknown> {
    return {
      buildPlan: () => ({}),
      execute: () => ({}),
      rollback: () => ({}),
      healthCheck: () => ({ healthy: true, latencyMs: 0 }),
    };
  }

  it('accepts a value that has every required method', () => {
    expect(isAdapterShape(validShape())).toBe(true);
  });

  it('rejects a value missing any single required method', () => {
    for (const m of REQUIRED_ADAPTER_METHODS) {
      const obj = validShape();
      delete obj[m];
      expect(isAdapterShape(obj)).toBe(false);
    }
  });

  it('rejects a value where a required method is not a function', () => {
    const obj = validShape();
    obj['execute'] = 'not a function';
    expect(isAdapterShape(obj)).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isAdapterShape(null)).toBe(false);
    expect(isAdapterShape(undefined)).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isAdapterShape('hello')).toBe(false);
    expect(isAdapterShape(42)).toBe(false);
    expect(isAdapterShape(true)).toBe(false);
  });
});
