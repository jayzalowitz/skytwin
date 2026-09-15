import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../adapter-registry.js';
import { discoverAdapters } from '../adapter-discovery.js';

interface Fixture {
  root: string;
  importMarker: string;
  constructionMarker: string;
}

function writePlugin(
  name: string,
  skills: string[],
  authModel: 'oauth' | 'api_key' | 'none' = 'oauth',
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'skytwin-adapter-discovery-'));
  const pluginDir = join(root, 'plugin');
  const importMarker = join(root, 'imported');
  const constructionMarker = join(root, 'constructed');
  mkdirSync(pluginDir);
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({
    name,
    version: '1.0.0',
    entryPoint: 'index.mjs',
    trustProfile: {
      reversibilityGuarantee: 'none',
      authModel,
      auditTrail: true,
      riskModifier: 2,
    },
    skills,
  }));
  writeFileSync(join(pluginDir, 'index.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(importMarker)}, 'imported');
    export default function createAdapter() {
      writeFileSync(${JSON.stringify(constructionMarker)}, 'constructed');
      return {
        buildPlan() {},
        execute() {},
        rollback() {},
        healthCheck() {},
      };
    }
  `);
  return { root, importMarker, constructionMarker };
}

describe('adapter discovery account boundary', () => {
  it.each([
    ['gmail-mcp', ['create_issue'], 'none'],
    ['neutral-plugin', ['outlook.messages.list'], 'none'],
    ['outlook-plugin', ['sync_crm'], 'oauth'],
  ] as const)('filters unavailable manifest %s before module evaluation', async (name, skills, authModel) => {
    const fixture = writePlugin(name, [...skills], authModel);
    const registry = new AdapterRegistry();
    const register = vi.spyOn(registry, 'register');
    try {
      await expect(discoverAdapters(fixture.root, registry, {
        allowAccountBackedIntegrations: false,
      })).resolves.toEqual([]);

      expect(existsSync(fixture.importMarker)).toBe(false);
      expect(existsSync(fixture.constructionMarker)).toBe(false);
      expect(register).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('preserves exact experimental discovery of an account-backed plugin', async () => {
    const fixture = writePlugin('gmail-mcp', ['send_email']);
    const registry = new AdapterRegistry();
    const register = vi.spyOn(registry, 'register');
    try {
      const discovered = await discoverAdapters(fixture.root, registry, {
        allowAccountBackedIntegrations: true,
      });

      expect(discovered).toHaveLength(1);
      expect(existsSync(fixture.importMarker)).toBe(true);
      expect(existsSync(fixture.constructionMarker)).toBe(true);
      expect(register).toHaveBeenCalledWith(
        'gmail-mcp',
        expect.anything(),
        expect.objectContaining({ name: 'gmail-mcp' }),
        new Set(['send_email']),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
