import axe from 'axe-core';
import type { AxeResults, ImpactValue, Result, RunOptions } from 'axe-core';

/**
 * Accessibility test harness for the dashboard (#402).
 *
 * The dashboard is an Express-served static SPA — the page chrome lives in
 * `public/index.html` and the per-route bodies are rendered client-side. We
 * run axe-core against DOM trees mounted in jsdom so the WCAG-fixable
 * portion of the a11y audit (axe-core clean on every route) is enforced in
 * CI. The screen-reader (VoiceOver / NVDA) and full keyboard-only passes in
 * issue #402 are inherently manual and remain a human checklist item.
 *
 * Returns a typed result object rather than throwing, matching the repo
 * convention for expected failure modes — the caller (a vitest assertion)
 * decides how to surface violations.
 */
export interface AxeViolationSummary {
  /** axe rule id, e.g. `color-contrast`, `label`, `region`. */
  readonly id: string;
  /** axe severity, or `null` when axe-core could not classify it. */
  readonly impact: ImpactValue | null;
  /** Human-readable rule description. */
  readonly help: string;
  /** Link to the Deque rule documentation. */
  readonly helpUrl: string;
  /** CSS selectors for each node that failed the rule. */
  readonly nodes: readonly string[];
}

export type RunAxeResult =
  | { readonly success: true }
  | { readonly success: false; readonly violations: readonly AxeViolationSummary[] };

/**
 * WCAG 2.1 A + AA is the dashboard's conformance target (DESIGN.md). Scope
 * axe to those tag sets so experimental / best-practice rules don't fail
 * the suite on subjective findings axe can't reliably auto-detect.
 */
const DEFAULT_RUN_OPTIONS: RunOptions = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  },
};

function summarize(violations: readonly Result[]): AxeViolationSummary[] {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }));
}

/**
 * Run axe-core against an element (or the whole document) and return a
 * typed pass/fail result. `options` is merged over the WCAG-scoped
 * defaults so individual tests can disable a rule that genuinely cannot
 * apply in a detached jsdom fragment (e.g. `region`, which expects a full
 * landmark layout).
 */
export async function runAxe(
  context: Element | Document = document,
  options: RunOptions = {},
): Promise<RunAxeResult> {
  const results: AxeResults = await axe.run(context, { ...DEFAULT_RUN_OPTIONS, ...options });
  if (results.violations.length === 0) {
    return { success: true };
  }
  return { success: false, violations: summarize(results.violations) };
}

/**
 * Render a `runAxe` failure as a readable multi-line string for use in a
 * test assertion message, so a CI failure names the exact rule + nodes
 * instead of a bare boolean.
 */
export function formatViolations(violations: readonly AxeViolationSummary[]): string {
  if (violations.length === 0) return 'no violations';
  return violations
    .map(
      (v) =>
        `  [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n    nodes: ${v.nodes.join(', ')}`,
    )
    .join('\n');
}
