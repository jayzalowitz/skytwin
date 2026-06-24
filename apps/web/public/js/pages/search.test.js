// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./search.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

describe('instant search page', () => {
  it('escapes the untrusted snippet, origin, and query before rendering', () => {
    expect(source).toContain('escapeHtml(typeof r?.snippet');
    expect(source).toContain('escapeHtml(prettySource(r?.source))');
    expect(source).toContain('escapeHtml(query)');
  });

  it('guards the source-label lookup against prototype keys', () => {
    expect(source).toContain('Object.prototype.hasOwnProperty.call(SOURCE_LABELS, source)');
    expect(source).not.toContain('source.charAt(0).toUpperCase()');
  });

  it('drops stale responses so a slow earlier query cannot overwrite a newer one', () => {
    expect(source).toContain('if (seq !== _searchSeq) return');
  });

  it('introduces no inline event handlers', () => {
    expect(source).not.toMatch(/\son(click|keydown|keyup|change|input|submit)=/i);
  });

  it('route-guards the debounced timer so it cannot fire after navigating away', () => {
    expect(source).toContain("window.location.hash.split('?')[0] !== '#/search'");
  });

  it('renderSearch is async so navigate().catch() does not throw', () => {
    // The SPA does `route.render(...).catch(...)`; a sync renderer makes
    // `undefined.catch` throw and aborts the rest of navigate().
    expect(source).toContain('export async function renderSearch');
  });

  it('is registered as a route in the SPA', () => {
    expect(appSource).toContain("import { renderSearch } from './pages/search.js'");
    expect(appSource).toContain("'/search': { title: 'Search', render: renderSearch }");
  });
});
