import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import type {
  RegistryEntry,
  OAuthQuirk,
  RegistryClientOptions,
  SmitheryResponse,
  SmitheryPackage,
} from './types.js';

const DEFAULT_SMITHERY_URL = 'https://api.smithery.ai';
const SMITHERY_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const SMITHERY_FAILURE_THRESHOLD = 3;

function resolveDataPath(filename: string): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), '..', 'data', filename);
}

function loadJsonFile(filename: string): unknown {
  const raw = readFileSync(resolveDataPath(filename), 'utf-8');
  return JSON.parse(raw) as unknown;
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['displayName'] === 'string' &&
    (v['transport'] === 'stdio' || v['transport'] === 'http' || v['transport'] === 'sse') &&
    (v['oauthProvider'] === null || typeof v['oauthProvider'] === 'string') &&
    typeof v['category'] === 'string' &&
    typeof v['description'] === 'string' &&
    Array.isArray(v['keywords']) &&
    (v['verified'] === 'anthropic' ||
      v['verified'] === 'community' ||
      v['verified'] === 'unverified')
  );
}

function isOAuthQuirk(value: unknown): value is OAuthQuirk {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['authMode'] === 'oauth2' || v['authMode'] === 'api_key' || v['authMode'] === 'env_only'
  );
}

export class RegistryClient {
  private readonly smitheryUrl: string;
  private readonly smitheryEnabled: boolean;
  private readonly fetchImpl: typeof fetch;

  private readonly curatedEntries: RegistryEntry[];
  private readonly oauthQuirks: Record<string, OAuthQuirk>;
  private augmentedEntries: RegistryEntry[];

  private smitheryFailureTimes: number[] = [];

  constructor(options: RegistryClientOptions = {}) {
    this.smitheryUrl = options.smitheryUrl ?? DEFAULT_SMITHERY_URL;
    this.smitheryEnabled = options.smitheryEnabled ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;

    const rawCurated = loadJsonFile('curated.json');
    const rawEntries = Array.isArray(rawCurated) ? rawCurated : [];
    this.curatedEntries = rawEntries.filter(isRegistryEntry);

    const rawQuirks = loadJsonFile('oauth_quirks.json');
    const quirksRecord: Record<string, unknown> =
      typeof rawQuirks === 'object' && rawQuirks !== null
        ? (rawQuirks as Record<string, unknown>)
        : {};

    this.oauthQuirks = {};
    for (const [id, quirk] of Object.entries(quirksRecord)) {
      if (isOAuthQuirk(quirk)) {
        this.oauthQuirks[id] = quirk;
      }
    }

    this.augmentedEntries = [...this.curatedEntries];
  }

  async getAll(): Promise<RegistryEntry[]> {
    return [...this.augmentedEntries];
  }

  async search(query: string): Promise<RegistryEntry[]> {
    if (query.trim().length === 0) return [...this.augmentedEntries];

    const lower = query.toLowerCase();
    return this.augmentedEntries.filter((entry) => {
      if (entry.displayName.toLowerCase().includes(lower)) return true;
      if (entry.description.toLowerCase().includes(lower)) return true;
      if (entry.id.toLowerCase().includes(lower)) return true;
      if (entry.keywords.some((kw) => kw.toLowerCase().includes(lower))) return true;
      return false;
    });
  }

  async getById(id: string): Promise<RegistryEntry | null> {
    return this.augmentedEntries.find((entry) => entry.id === id) ?? null;
  }

  getOAuthQuirks(id: string): OAuthQuirk | null {
    return this.oauthQuirks[id] ?? null;
  }

  async syncFromSmithery(): Promise<{
    ok: boolean;
    added: number;
    updated: number;
    reason?: string;
  }> {
    if (!this.smitheryEnabled) {
      return { ok: false, added: 0, updated: 0, reason: 'smithery_disabled' };
    }

    const now = Date.now();
    this.smitheryFailureTimes = this.smitheryFailureTimes.filter(
      (t) => now - t < SMITHERY_FAILURE_WINDOW_MS,
    );

    if (this.smitheryFailureTimes.length >= SMITHERY_FAILURE_THRESHOLD) {
      return { ok: false, added: 0, updated: 0, reason: 'circuit_open' };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.smitheryUrl}/registry/servers`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.smitheryFailureTimes.push(Date.now());
      return { ok: false, added: 0, updated: 0, reason: 'smithery_unavailable' };
    }

    if (response.status >= 500) {
      this.smitheryFailureTimes.push(Date.now());
      return { ok: false, added: 0, updated: 0, reason: 'smithery_unavailable' };
    }

    if (!response.ok) {
      return { ok: false, added: 0, updated: 0, reason: `smithery_error_${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, added: 0, updated: 0, reason: 'smithery_parse_error' };
    }

    const smitheryData = body as SmitheryResponse;
    const packages: SmitheryPackage[] = Array.isArray(smitheryData.packages)
      ? smitheryData.packages
      : [];

    const existingIds = new Set(this.curatedEntries.map((e) => e.id));
    let added = 0;

    for (const pkg of packages) {
      const pkgId = typeof pkg.qualifiedName === 'string' ? pkg.qualifiedName : null;
      if (pkgId === null) continue;
      if (existingIds.has(pkgId)) continue;
      if (this.augmentedEntries.some((e) => e.id === pkgId)) continue;

      const entry: RegistryEntry = {
        id: pkgId,
        displayName: typeof pkg.displayName === 'string' ? pkg.displayName : pkgId,
        transport: 'stdio',
        oauthProvider: null,
        category: 'developer',
        description:
          typeof pkg.description === 'string'
            ? pkg.description
            : 'MCP server from Smithery registry.',
        keywords: [pkgId.toLowerCase()],
        homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
        verified: 'unverified',
      };

      this.augmentedEntries.push(entry);
      added++;
    }

    return { ok: true, added, updated: 0 };
  }
}
