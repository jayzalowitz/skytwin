// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./watches.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8');

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
      'fetchAdaptiveWorkflowReadiness',
      'createAdaptiveSignalDigestDraft',
      'fetchAdaptiveWorkflowDetail',
      'fetchAdaptiveWorkflowResumableDraft',
      'createAdaptiveWorkflowFeedbackRevision',
      'activateAdaptiveWorkflow',
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

  it('persists the authoring draft and sends explicit CAS activation identity', () => {
    expect(source).toContain('adaptiveWatchDraftKey');
    expect(source).toContain('expectedActiveVersionId: result.workflow.activeVersionId ?? null');
    expect(source).toContain('proposalId: activation.proposalId');
    expect(source).toContain('await refresh(operation)');
  });

  it('does not poison the runs cache on a transient fetch failure (retry stays possible)', () => {
    // handleRuns guards re-fetch behind `!runsByWatchId.has(id)`. Caching an
    // empty array on error would make a transient failure show "no runs"
    // forever. The catch must clear the entry, not set [].
    expect(source).toContain('_state.runsByWatchId.delete(id)');
    expect(source).not.toMatch(/catch[\s\S]{0,200}runsByWatchId\.set\(id,\s*\[\]\)/);
  });

  it('distinguishes hidden retained evidence from matches omitted by the retention bound', () => {
    expect(source).toContain('run.evidence_truncated');
    expect(source).toContain('additional matching evidence item');
    expect(source).toContain('counted but omitted by the evidence retention bound');
    expect(source).toContain('title="Evidence SHA-256 commitment"');
  });

  it('keeps Watch controls usable on small screens and reduced-motion systems', () => {
    expect(stylesSource).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.watch-input\s*{[^}]*font-size:\s*1rem;/);
    expect(stylesSource).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.watch-example\s*{[^}]*min-height:\s*44px;/);
    expect(stylesSource).toMatch(/\.watches-page \.btn\s*{[^}]*transition:(?!\s*all)/s);
    expect(stylesSource).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.watches-page \.btn\s*{[^}]*transition:\s*none;/);
  });

  it('uses the AA text token for compact Watch metadata', () => {
    expect(stylesSource).toMatch(/\.watch-preview-meta,[\s\S]*?\.watch-run-refs\s*{[^}]*color:\s*var\(--text-muted\);/);
    expect(stylesSource).toMatch(/\.watch-replay-stats span\s*{[^}]*color:\s*var\(--text-muted\);/);
    expect(stylesSource).toMatch(/\.watch-activation-note\s*{[^}]*color:\s*var\(--text-muted\);/);
  });
});
