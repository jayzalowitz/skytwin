import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must mock before module import so the GbrainMemoryPort constructor calls the mock.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../cli-detector.js', () => ({
  isGbrainInstalled: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { isGbrainInstalled } from '../cli-detector.js';
import { GbrainMemoryPort, NotImplementedError } from '../gbrain-port.js';
import type { SemanticHit } from '@skytwin/memory-port';

const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;
const mockIsInstalled = isGbrainInstalled as ReturnType<typeof vi.fn>;

describe('GbrainMemoryPort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('capabilities()', () => {
    it('declares semantic_search and code_aware_search, not federated_sources', () => {
      mockIsInstalled.mockReturnValue(true);
      const port = new GbrainMemoryPort();
      const caps = port.capabilities();
      expect(caps.has('semantic_search')).toBe(true);
      expect(caps.has('code_aware_search')).toBe(true);
      expect(caps.has('federated_sources')).toBe(false);
    });

    it('returns empty set when gbrain is not installed', () => {
      mockIsInstalled.mockReturnValue(false);
      const port = new GbrainMemoryPort();
      expect(port.capabilities().size).toBe(0);
    });
  });

  describe('shell-injection safety', () => {
    it('passes the query as an argv element, not a shell-interpolated string', async () => {
      mockIsInstalled.mockReturnValue(true);
      mockExecFileSync.mockReturnValue('[]');
      const port = new GbrainMemoryPort();
      const malicious = 'foo$(touch /tmp/pwned)`whoami`; rm -rf /';
      await port.searchSemantic(malicious, 5);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockExecFileSync.mock.calls[0]!;
      expect(cmd).toBe('gbrain');
      expect(Array.isArray(args)).toBe(true);
      // The query is one discrete argv element — no shell, so metacharacters
      // are inert.
      expect(args).toContain(`--query=${malicious}`);
    });
  });

  describe('searchSemantic', () => {
    it('returns [] when gbrain is not installed', async () => {
      mockIsInstalled.mockReturnValue(false);
      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('some query', 5);
      expect(result).toEqual([]);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('normalizes upstream gbrain v0.50.5.0 SearchResult output', async () => {
      mockIsInstalled.mockReturnValue(true);
      const hits = [
        {
          slug: 'projects/skytwin',
          page_id: 41,
          chunk_id: 99,
          chunk_index: 2,
          score: 0.95,
          chunk_text: 'result text',
          source_id: 'main',
          title: 'SkyTwin',
          type: 'project',
          stale: false,
        },
      ];
      mockExecFileSync.mockReturnValue(JSON.stringify(hits));
      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('query', 10);
      expect(result).toEqual([
        {
          id: 'projects/skytwin',
          score: 0.95,
          content: 'result text',
          source: 'main',
          metadata: {
            source_id: 'main',
            title: 'SkyTwin',
            type: 'project',
            page_id: 41,
            chunk_id: 99,
            chunk_index: 2,
            stale: false,
          },
        },
      ]);
    });

    it('falls back to the slug when a current gbrain hit has no source id', async () => {
      mockIsInstalled.mockReturnValue(true);
      mockExecFileSync.mockReturnValue(
        JSON.stringify([
          {
            slug: 'projects/skytwin',
            score: 0.95,
            chunk_text: 'result text',
          },
        ]),
      );

      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('query', 10);

      expect(result[0]).toMatchObject({
        id: 'projects/skytwin',
        source: 'projects/skytwin',
      });
    });

    it('drops malformed optional metadata from current gbrain output', async () => {
      mockIsInstalled.mockReturnValue(true);
      mockExecFileSync.mockReturnValue(
        JSON.stringify([
          {
            slug: 'projects/skytwin',
            score: 0.95,
            chunk_text: 'result text',
            source_id: 'main',
            metadata: 'not-an-object',
            page_id: Number.POSITIVE_INFINITY,
            chunk_id: 'wrong-type',
            stale: 'false',
          },
        ]),
      );

      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('query', 10);

      expect(result[0]?.metadata).toEqual({ source_id: 'main' });
    });

    it('retains compatibility with the legacy gbrain hit shape', async () => {
      mockIsInstalled.mockReturnValue(true);
      const hits: SemanticHit[] = [
        { id: 'h1', score: 0.95, content: 'result text', source: 'file.ts' },
        {
          id: 'h2',
          score: 0.8,
          content: 'other text',
          source: 'readme.md',
          metadata: { line: 42 },
        },
      ];
      mockExecFileSync.mockReturnValue(JSON.stringify(hits));
      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('query', 10);
      expect(result).toEqual(hits);
    });

    it('returns [] on non-zero exit (execSync throws)', async () => {
      mockIsInstalled.mockReturnValue(true);
      mockExecFileSync.mockImplementation(() => { throw new Error('exit code 1'); });
      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('query', 5);
      expect(result).toEqual([]);
    });

    it('returns [] on timeout', async () => {
      mockIsInstalled.mockReturnValue(true);
      const err = Object.assign(new Error('spawnSync gbrain ETIMEDOUT'), { code: 'ETIMEDOUT' });
      mockExecFileSync.mockImplementation(() => { throw err; });
      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('query', 5);
      expect(result).toEqual([]);
    });

    it('returns [] when gbrain returns non-array JSON', async () => {
      mockIsInstalled.mockReturnValue(true);
      mockExecFileSync.mockReturnValue(JSON.stringify({ error: 'unexpected' }));
      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('query', 5);
      expect(result).toEqual([]);
    });

    it('filters out malformed items from gbrain output', async () => {
      mockIsInstalled.mockReturnValue(true);
      const mixed = [
        { id: 'h1', score: 0.9, content: 'good', source: 'a.ts' },
        { id: 'h2', score: 'bad-score', content: 'bad', source: 'b.ts' }, // score is not a number
        { id: 'h3', score: Number.NaN, content: 'bad', source: 'c.ts' },
        null,
        42,
      ];
      mockExecFileSync.mockReturnValue(JSON.stringify(mixed));
      const port = new GbrainMemoryPort();
      const result = await port.searchSemantic('query', 5);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('h1');
    });
  });

  describe('unimplemented methods throw NotImplementedError', () => {
    it('recordSignal throws', async () => {
      mockIsInstalled.mockReturnValue(true);
      const port = new GbrainMemoryPort();
      await expect(port.recordSignal({
        id: 'x', source: 's', type: 't', timestamp: new Date(), data: {},
      })).rejects.toBeInstanceOf(NotImplementedError);
    });

    it('walkGraph throws', async () => {
      mockIsInstalled.mockReturnValue(true);
      const port = new GbrainMemoryPort();
      await expect(port.walkGraph({ startNodeId: 'n1', maxDepth: 2 }))
        .rejects.toBeInstanceOf(NotImplementedError);
    });

    it('getEpisodes throws', async () => {
      mockIsInstalled.mockReturnValue(true);
      const port = new GbrainMemoryPort();
      await expect(port.getEpisodes({ from: new Date(), to: new Date() }))
        .rejects.toBeInstanceOf(NotImplementedError);
    });

    it('summarize throws', async () => {
      mockIsInstalled.mockReturnValue(true);
      const port = new GbrainMemoryPort();
      await expect(port.summarize({ scope: 'recent-day' }))
        .rejects.toBeInstanceOf(NotImplementedError);
    });

    it('compress throws', async () => {
      mockIsInstalled.mockReturnValue(true);
      const port = new GbrainMemoryPort();
      await expect(port.compress(100)).rejects.toBeInstanceOf(NotImplementedError);
    });
  });
});
