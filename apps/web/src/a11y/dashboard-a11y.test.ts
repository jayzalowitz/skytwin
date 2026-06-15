import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAxe, formatViolations, type AxeViolationSummary } from './run-axe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '../../public/index.html');

/**
 * #402 — code-fixable half of the dashboard a11y audit.
 *
 * The dashboard chrome (sidebar nav, kill-switch + connector banners,
 * page header, mobile bottom-nav) lives in `public/index.html` and wraps
 * EVERY hash route. Running axe-core against that real shell enforces
 * "axe-core clean on every route" for the persistent structure — the part
 * an automated check can verify deterministically without a live API
 * server. The dynamic per-route bodies are rendered client-side from the
 * network and are exercised by the running-app (Playwright) + manual
 * screen-reader passes that the rest of #402 tracks.
 */

interface ShellMarkup {
  /** Body innerHTML with <script> blocks stripped. */
  readonly body: string;
  /** Value of the <head><title>, or '' if absent. */
  readonly title: string;
  /** <html lang="…"> value, or '' if absent. */
  readonly lang: string;
}

/**
 * Parse the real served index.html. We mount the <body> into jsdom's
 * existing document (vitest gives us one) and replay the document-level
 * attributes (`<title>`, `<html lang>`) that axe checks but that live in
 * <head> rather than the body — otherwise axe would flag the served page's
 * actual <title>/<html lang="en"> as missing purely because of how the
 * fixture is mounted. <script> blocks are stripped so jsdom doesn't try to
 * execute the SPA bootstrap (which would fetch from a non-existent API).
 */
function loadShell(): ShellMarkup {
  const raw = readFileSync(INDEX_HTML, 'utf8');
  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = (bodyMatch?.[1] ?? raw).replace(/<script[\s\S]*?<\/script>/gi, '');
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const langMatch = raw.match(/<html[^>]*\blang="([^"]*)"/i);
  return {
    body,
    title: titleMatch?.[1]?.trim() ?? '',
    lang: langMatch?.[1]?.trim() ?? '',
  };
}

describe('dashboard a11y — app shell (every route)', () => {
  beforeEach(() => {
    const shell = loadShell();
    // jsdom doesn't replay <head> contents from body innerHTML, so mirror
    // the document-level attributes axe inspects from the real <head>.
    document.documentElement.lang = shell.lang;
    document.title = shell.title;
    document.body.innerHTML = shell.body;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('has no axe-core WCAG 2.1 A/AA violations', async () => {
    const result = await runAxe(document);
    const violations: readonly AxeViolationSummary[] = result.success ? [] : result.violations;
    expect(result.success, `axe-core violations:\n${formatViolations(violations)}`).toBe(true);
  });

  it('keeps the document language declared (WCAG 3.1.1)', () => {
    expect(document.documentElement.lang).toBe('en');
  });

  it('gives every interactive control an accessible name', async () => {
    // `button-name` and `link-name` are the two axe rules that catch
    // icon-only controls with no label — the mobile menu toggle and the
    // SVG bottom-nav links are the at-risk spots in this shell.
    const result = await runAxe(document, {
      runOnly: { type: 'rule', values: ['button-name', 'link-name'] },
    });
    const violations: readonly AxeViolationSummary[] = result.success ? [] : result.violations;
    expect(result.success, `unnamed controls:\n${formatViolations(violations)}`).toBe(true);
  });
});

describe('dashboard a11y — runAxe harness', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns success on accessible markup (happy path)', async () => {
    document.body.innerHTML = '<main><h1>OK</h1><button type="button">Save</button></main>';
    const result = await runAxe(document.body, { runOnly: { type: 'rule', values: ['button-name'] } });
    expect(result.success).toBe(true);
  });

  it('reports a typed violation summary on inaccessible markup (fallback path)', async () => {
    // A button with no text content and no aria-label has no accessible
    // name — axe's `button-name` rule must flag it.
    document.body.innerHTML = '<button type="button"></button>';
    const result = await runAxe(document.body, { runOnly: { type: 'rule', values: ['button-name'] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.violations.length).toBeGreaterThan(0);
      const ids = result.violations.map((v) => v.id);
      expect(ids).toContain('button-name');
      // The summary shape is the typed contract callers rely on.
      const first = result.violations[0]!;
      expect(typeof first.help).toBe('string');
      expect(first.nodes.length).toBeGreaterThan(0);
    }
  });

  it('formatViolations renders an empty list as a stable sentinel', () => {
    expect(formatViolations([])).toBe('no violations');
  });

  it('formatViolations names the rule and nodes for a failure', () => {
    const text = formatViolations([
      { id: 'label', impact: 'critical', help: 'Form elements must have labels', helpUrl: 'https://x', nodes: ['#a', '#b'] },
    ]);
    expect(text).toContain('label');
    expect(text).toContain('critical');
    expect(text).toContain('#a');
    expect(text).toContain('#b');
  });
});
