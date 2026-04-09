import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import type { AdapterTrustProfile } from '@skytwin/shared-types';
import { validateManifest } from './adapter-manifest.js';
import type { AdapterManifest } from './adapter-manifest.js';
import type { AdapterRegistry } from './adapter-registry.js';

/**
 * Factory function signature that adapter plugins must default-export.
 */
type AdapterFactory = (config: Record<string, unknown>) => IronClawAdapter;

interface DiscoveredAdapter {
  manifest: AdapterManifest;
  adapter: IronClawAdapter;
}

/**
 * Scan a directory for adapter plugin subdirectories and register them.
 *
 * Each subdirectory must contain a manifest.json describing the adapter
 * and an entry point module that default-exports a factory function.
 *
 * Discovered adapters are registered with a minimum riskModifier of 2
 * (untrusted by default) and always rank below built-in adapters.
 */
export async function discoverAdapters(
  pluginDir: string,
  registry: AdapterRegistry,
): Promise<DiscoveredAdapter[]> {
  if (!pluginDir || !existsSync(pluginDir)) {
    return [];
  }

  const discovered: DiscoveredAdapter[] = [];
  let entries: string[];

  try {
    entries = readdirSync(pluginDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    console.warn(`[adapter-discovery] Failed to read plugin directory: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  for (const dirName of entries) {
    const dirPath = join(pluginDir, dirName);
    const manifestPath = join(dirPath, 'manifest.json');

    if (!existsSync(manifestPath)) {
      console.info(`[adapter-discovery] Skipping ${dirName}: no manifest.json`);
      continue;
    }

    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
      const result = validateManifest(raw);

      if (!result.valid) {
        console.warn(`[adapter-discovery] Invalid manifest in ${dirName}: ${result.error}`);
        continue;
      }

      const { manifest } = result;

      // Block plugins that try to use reserved built-in adapter names
      const RESERVED_NAMES = new Set(['ironclaw', 'direct', 'openclaw']);
      if (RESERVED_NAMES.has(manifest.name)) {
        console.warn(`[adapter-discovery] Plugin "${dirName}" tried to use reserved name "${manifest.name}" — skipped`);
        continue;
      }

      const entryPath = resolve(dirPath, manifest.entryPoint);

      // Prevent path traversal — resolve symlinks on BOTH sides before comparison.
      // Use trailing separator to prevent prefix confusion (/plugins/foo vs /plugins/foobar).
      const realDir = realpathSync(dirPath);
      if (!existsSync(entryPath)) {
        console.warn(`[adapter-discovery] Entry point not found: ${entryPath}`);
        continue;
      }
      const realEntry = realpathSync(entryPath);
      const rel = relative(realDir, realEntry);
      if (rel.startsWith('..') || rel.startsWith(sep) || resolve(realDir, rel) !== realEntry) {
        console.warn(`[adapter-discovery] Path traversal blocked in ${dirName}: ${manifest.entryPoint} (resolved to ${realEntry})`);
        continue;
      }

      const module = await import(pathToFileURL(entryPath).href) as { default?: AdapterFactory };
      const factory = module.default;

      if (typeof factory !== 'function') {
        console.warn(`[adapter-discovery] ${dirName}: entry point must default-export a factory function`);
        continue;
      }

      const adapter = factory({});

      const trustProfile: AdapterTrustProfile = {
        name: manifest.name,
        ...manifest.trustProfile,
      };

      const skills = new Set(manifest.skills);
      registry.register(manifest.name, adapter, trustProfile, skills);

      discovered.push({ manifest, adapter });
      console.info(`[adapter-discovery] Registered "${manifest.name}" v${manifest.version} (${manifest.skills.length} skills, riskModifier=${manifest.trustProfile.riskModifier})`);
    } catch (err) {
      console.warn(`[adapter-discovery] Failed to load ${dirName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return discovered;
}
