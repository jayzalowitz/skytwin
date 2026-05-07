import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RegistryClient } from '../registry-client.js';

describe('RegistryClient — embedded curated list', () => {
  it('loads ≥65 entries from curated.json without network access', async () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    const entries = await client.getAll();
    expect(entries.length).toBeGreaterThanOrEqual(65);
  });

  it('has at least 15 entries verified by Anthropic', async () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    const entries = await client.getAll();
    const anthropicVerified = entries.filter((e) => e.verified === 'anthropic');
    expect(anthropicVerified.length).toBeGreaterThanOrEqual(15);
  });

  it('returns the Notion entry for search("notion")', async () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    const results = await client.search('notion');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const notion = results.find((e) => e.displayName.toLowerCase().includes('notion'));
    expect(notion).toBeDefined();
  });

  it('returns at least the filesystem entry for search("files")', async () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    const results = await client.search('files');
    const fs = results.find((e) => e.id === '@modelcontextprotocol/server-filesystem');
    expect(fs).toBeDefined();
  });

  it('getById returns the filesystem entry by exact id', async () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    const entry = await client.getById('@modelcontextprotocol/server-filesystem');
    expect(entry).not.toBeNull();
    expect(entry?.displayName).toBe('Filesystem');
    expect(entry?.verified).toBe('anthropic');
  });

  it('getById returns null for an unknown id', async () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    const entry = await client.getById('does-not-exist-xyz');
    expect(entry).toBeNull();
  });

  it('search returns empty array for empty query items — returns all instead', async () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    const all = await client.getAll();
    const results = await client.search('');
    expect(results.length).toBe(all.length);
  });
});

describe('RegistryClient — oauth_quirks', () => {
  const EXPECTED_IDS = [
    '@notionhq/notion-mcp-server',
    'linear-mcp',
    '@modelcontextprotocol/server-slack',
    '@modelcontextprotocol/server-github',
    '@modelcontextprotocol/server-google-drive',
  ];

  for (const id of EXPECTED_IDS) {
    it(`getOAuthQuirks("${id}") returns a quirk entry`, () => {
      const client = new RegistryClient({ smitheryEnabled: false });
      const quirk = client.getOAuthQuirks(id);
      expect(quirk).not.toBeNull();
      expect(quirk?.authMode).toBe('oauth2');
    });
  }

  it('getOAuthQuirks returns null for an id with no quirk entry', () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    expect(client.getOAuthQuirks('@modelcontextprotocol/server-filesystem')).toBeNull();
  });
});

describe('RegistryClient — Smithery circuit breaker', () => {
  it('returns circuit_open on the 4th call after 3 5xx failures without making a fetch', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      return new Response('Internal Server Error', { status: 500 });
    });

    const client = new RegistryClient({
      smitheryEnabled: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const r1 = await client.syncFromSmithery();
    expect(r1.reason).toBe('smithery_unavailable');

    const r2 = await client.syncFromSmithery();
    expect(r2.reason).toBe('smithery_unavailable');

    const r3 = await client.syncFromSmithery();
    expect(r3.reason).toBe('smithery_unavailable');

    expect(callCount).toBe(3);

    const r4 = await client.syncFromSmithery();
    expect(r4.ok).toBe(false);
    expect(r4.reason).toBe('circuit_open');

    expect(callCount).toBe(3);
  });
});

describe('RegistryClient — Smithery successful sync', () => {
  it('merges new entries from Smithery and does not overwrite existing curated entries', async () => {
    const smitheryPayload = {
      packages: [
        {
          qualifiedName: 'new-smithery-server',
          displayName: 'New Smithery Server',
          description: 'A brand new server from Smithery.',
          homepage: 'https://example.com',
        },
        {
          qualifiedName: '@modelcontextprotocol/server-filesystem',
          displayName: 'SHOULD NOT OVERRIDE',
          description: 'This must not overwrite the curated entry.',
        },
      ],
    };

    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify(smitheryPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new RegistryClient({
      smitheryEnabled: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const result = await client.syncFromSmithery();

    expect(result.ok).toBe(true);
    expect(result.added).toBe(1);

    const newEntry = await client.getById('new-smithery-server');
    expect(newEntry).not.toBeNull();
    expect(newEntry?.verified).toBe('unverified');

    const fsEntry = await client.getById('@modelcontextprotocol/server-filesystem');
    expect(fsEntry?.displayName).toBe('Filesystem');
    expect(fsEntry?.verified).toBe('anthropic');
  });

  it('returns smithery_disabled when smitheryEnabled is false', async () => {
    const client = new RegistryClient({ smitheryEnabled: false });
    const result = await client.syncFromSmithery();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('smithery_disabled');
  });
});

describe('RegistryClient — search edge cases', () => {
  let client: RegistryClient;

  beforeEach(() => {
    client = new RegistryClient({ smitheryEnabled: false });
  });

  it('search is case-insensitive', async () => {
    const lower = await client.search('github');
    const upper = await client.search('GITHUB');
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBeGreaterThan(0);
  });

  it('search matches on keywords (e.g. "sql" finds postgres)', async () => {
    const results = await client.search('sql');
    const ids = results.map((e) => e.id);
    expect(ids).toContain('@modelcontextprotocol/server-postgres');
  });

  it('search matches on description text', async () => {
    const results = await client.search('headless Chrome');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
