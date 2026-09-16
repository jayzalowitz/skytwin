import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const index = read('docs/index.html');
const start = read('docs/start.html');
const agents = read('docs/agents.html');
const llms = read('docs/llms.txt');
const docsHome = read('docs/docs.html');

describe('public developer-preview documentation', () => {
  it('keeps the human and machine paths published together', () => {
    for (const path of [
      'docs/index.html', 'docs/start.html', 'docs/docs.html', 'docs/architecture.html',
      'docs/safety.html', 'docs/inference.html', 'docs/agents.html', 'docs/operations.html',
      'docs/release.html', 'docs/contributing.html', 'docs/reference.html', 'docs/llms.txt',
      'docs/guides.css',
    ]) {
      expect(existsSync(resolve(root, path))).toBe(true);
    }
    expect(index).toContain('href="start.html"');
    expect(index).toContain('href="agents.html"');
    expect(index).toContain('href="reference.html"');
    expect(index).toContain('href="llms.txt"');
    expect(agents).toContain('local MCP server');
    expect(llms).toContain('Agent safety requirements');
    expect(docsHome).toContain('architecture.html');
    expect(docsHome).toContain('release.html');
  });

  it('keeps source evaluation and release boundaries explicit', () => {
    expect(index).toContain('Published installers predate the guarded account-free sample now in source.');
    expect(index).toContain('v0.7.0-beta');
    expect(start).toContain('not a supported installer path');
    expect(start).toContain('Google and Microsoft account connections are unavailable');
    expect(agents).toContain('Do not execute around policy.');
    expect(agents).toContain('Missing action provenance is');
  });

  it('does not present remote provider material as an active confidential route', () => {
    expect(index).toContain('Remote attested inference');
    expect(index).toContain('does not send a prompt');
    expect(agents).toContain('Remote attested inference remains unavailable');
    expect(llms).toContain('does not itself make a SkyTwin inference call confidential');
  });

  it('publishes a reference center that distinguishes current from unavailable inference routes', () => {
    const reference = read('docs/reference.html');
    expect(reference).toContain('Remote attested inference');
    expect(reference).toContain('Deliberately unavailable');
    expect(reference).toContain('docs/beta-claim-ledger.json');
    expect(reference).toContain('docs/technical-spec.md');
  });

  it('keeps the full guide set source-grounded and clear about supported boundaries', () => {
    expect(read('docs/architecture.html')).toContain('typed candidate action');
    expect(read('docs/safety.html')).toContain('Missing action provenance is');
    expect(read('docs/inference.html')).toContain('remote attested inference is deliberately unavailable');
    expect(read('docs/operations.html')).toContain('skytwin_db_pool_waiting');
    expect(read('docs/release.html')).toContain('v0.7.0-beta');
    expect(read('docs/contributing.html')).toContain('Never auto-execute without a policy check.');
  });
});
