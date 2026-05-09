/**
 * docker-spawn.test.ts — unit + integration tests for docker-spawn.ts
 *
 * Unit tests verify argv construction without requiring Docker.
 * The integration test is gated behind a real isDockerAvailable() check and
 * verifies that --network=none actually prevents network access inside a container.
 */

import { describe, it, expect } from 'vitest';
import { buildDockerArgs } from '../docker-spawn.js';

// ─── buildDockerArgs unit tests ───────────────────────────────────────────────

describe('buildDockerArgs', () => {
  const baseOpts = {
    image: 'node:22-alpine',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    globalModulesDir: '/usr/local/lib/node_modules',
    memoryMb: 512,
  };

  it('begins with "run" subcommand', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv[0]).toBe('run');
  });

  it('includes --network=none', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv).toContain('--network=none');
  });

  it('includes --rm', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv).toContain('--rm');
  });

  it('includes --init', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv).toContain('--init');
  });

  it('includes --memory flag with default 512m value', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv).toContain('--memory=512m');
  });

  it('includes --memory flag with custom value', () => {
    const argv = buildDockerArgs({ ...baseOpts, memoryMb: 256 });
    expect(argv).toContain('--memory=256m');
  });

  it('includes --cpus flag', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv.some((a) => a.startsWith('--cpus='))).toBe(true);
  });

  it('includes --user flag with uid:gid numeric format', () => {
    const argv = buildDockerArgs(baseOpts);
    const userFlag = argv.find((a) => a.startsWith('--user='));
    expect(userFlag).toBeDefined();
    expect(userFlag).toMatch(/^--user=\d+:\d+$/);
  });

  it('includes --read-only flag', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv).toContain('--read-only');
  });

  it('includes --cap-drop=ALL', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv).toContain('--cap-drop=ALL');
  });

  it('includes --security-opt=no-new-privileges', () => {
    const argv = buildDockerArgs(baseOpts);
    expect(argv).toContain('--security-opt=no-new-privileges');
  });

  it('mounts global node_modules read-only when mountGlobalNodeModules is not false', () => {
    const argv = buildDockerArgs(baseOpts);
    const mountFlag = argv.find((a) => a.startsWith('--volume=') && a.includes('node_modules'));
    expect(mountFlag).toBeDefined();
    expect(mountFlag).toContain(':ro');
  });

  it('does not mount global node_modules when mountGlobalNodeModules is false', () => {
    const argv = buildDockerArgs({ ...baseOpts, mountGlobalNodeModules: false });
    const mountFlag = argv.find((a) => a.startsWith('--volume=') && a.includes('node_modules'));
    expect(mountFlag).toBeUndefined();
  });

  it('does not mount global node_modules when globalModulesDir is empty string', () => {
    const argv = buildDockerArgs({ ...baseOpts, globalModulesDir: '' });
    const mountFlag = argv.find((a) => a.startsWith('--volume=') && a.includes('node_modules'));
    expect(mountFlag).toBeUndefined();
  });

  it('passes env vars as adjacent -e KEY=VALUE flag pairs', () => {
    const argv = buildDockerArgs({
      ...baseOpts,
      env: { NOTION_TOKEN: 'secret', DEBUG: '1' },
    });
    const envPairs = argv.reduce<string[]>((acc, val, i, arr) => {
      if (val === '-e' && arr[i + 1]) acc.push(arr[i + 1]!);
      return acc;
    }, []);
    expect(envPairs).toContain('NOTION_TOKEN=secret');
    expect(envPairs).toContain('DEBUG=1');
  });

  it('places image, command, and server args in trailing position', () => {
    const argv = buildDockerArgs(baseOpts);
    const imageIdx = argv.indexOf('node:22-alpine');
    const commandIdx = argv.indexOf('npx');
    const serverArgs = argv.slice(commandIdx + 1);

    expect(imageIdx).toBeGreaterThan(0);
    expect(commandIdx).toBe(imageIdx + 1);
    expect(serverArgs).toEqual(['-y', '@notionhq/notion-mcp-server']);
  });

  it('uses custom image when provided', () => {
    const argv = buildDockerArgs({ ...baseOpts, image: 'custom:latest' });
    expect(argv).toContain('custom:latest');
    expect(argv).not.toContain('node:22-alpine');
  });
});

// ─── isDockerAvailable unit test ──────────────────────────────────────────────

describe('isDockerAvailable', () => {
  it('returns a boolean', async () => {
    const { isDockerAvailable } = await import('../docker-spawn.js');
    const result = await isDockerAvailable();
    expect(typeof result).toBe('boolean');
  });
});

// ─── Docker integration test ──────────────────────────────────────────────────
//
// Gated behind a live isDockerAvailable() check. Verifies --network=none
// actually prevents outbound TCP connections from the container.
// Skip explicitly via CI_SKIP_DOCKER=true for environments where Docker is not
// available (e.g. Docker-in-Docker with restricted capabilities).

describe('Docker integration', () => {
  it(
    'spawning node:22-alpine with --network=none blocks outbound fetch',
    async () => {
      const { isDockerAvailable: checkDocker, spawnInDockerNoNetworkAsync } = await import(
        '../docker-spawn.js'
      );
      const available = await checkDocker();
      if (!available) {
        console.log('[docker integration] Docker not available — skipping');
        return;
      }

      // Script exits 0 if network is blocked (expected), 1 if it succeeded (unexpected).
      const result = await spawnInDockerNoNetworkAsync({
        command: 'node',
        args: [
          '-e',
          [
            "const http = require('http');",
            "const req = http.get('http://example.com', () => { process.exit(1); });",
            "req.on('error', () => { process.exit(0); });",
            "req.setTimeout(3000, () => { req.destroy(); process.exit(0); });",
          ].join(' '),
        ],
        mountGlobalNodeModules: false,
        memoryMb: 128,
      });

      const { code } = await result.waitExit();
      // Exit 0 = network was blocked = isolation is working.
      expect(code).toBe(0);
    },
    45_000,
  );
});
