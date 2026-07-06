// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./watches.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

describe('watches page', () => {
  it('is registered as a SPA route and sidebar link', () => {
    expect(appSource).toContain("import { renderWatches } from './pages/watches.js'");
    expect(appSource).toContain("'/watches': { title: 'Watches', render: renderWatches }");
    expect(indexSource).toContain('href="#/watches"');
  });

  it('uses the no-code Watches API surface', () => {
    for (const fn of [
      'parseWatchText',
      'fetchWatches',
      'createWatch',
      'updateWatchStatus',
      'updateWatchSpec',
      'deleteWatch',
      'fetchWatchRuns',
    ]) {
      expect(source).toContain(fn);
    }
  });

  it('hash-guards singleton listeners to avoid cross-page handling', () => {
    expect(source).toContain("window.location.hash || '').split('?')[0] === '#/watches'");
    expect(source).toContain('if (_listenerWired');
  });

  it('renders untrusted watch fields only through escapeHtml', () => {
    expect(source).toContain('escapeHtml(_state.draftText)');
    expect(source).toContain('escapeHtml(watch.name');
    expect(source).toContain('escapeHtml(run.summary');
    expect(source).toContain('escapeHtml(p)');
  });

  it('introduces no inline event handlers', () => {
    expect(source).not.toMatch(/\son(click|keydown|keyup|change|input|submit)=/i);
  });
});
