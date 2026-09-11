// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderTwinBriefingWidget } from './dashboard.js';

describe('dashboard briefing states', () => {
  it('renders a reduced-motion-safe loading skeleton', () => {
    const html = renderTwinBriefingWidget(null, 'loading');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('digest-skel');
  });

  it('does not swallow API failure', () => {
    const html = renderTwinBriefingWidget(null, 'error');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Open briefing and retry');
  });

  it('renders a cold-start nudge but hides connected empty state', () => {
    const cold = renderTwinBriefingWidget({ structured: { coverage: { coldStart: true } } });
    expect(cold).toContain("Connect a source and I'll start your briefing");
    const empty = renderTwinBriefingWidget({
      structured: { coverage: { coldStart: false }, todos: [], topics: [] },
      prose_markdown: null,
    });
    expect(empty).toBe('');
  });

  it('keeps prose fallback discoverable', () => {
    const html = renderTwinBriefingWidget({
      prose_markdown: '# Daily\nA calm prose fallback.',
      generated_at: '2026-09-10T00:00:00Z',
      read_at: null,
    });
    expect(html).toContain('A calm prose fallback.');
    expect(html).toContain('Read full briefing');
  });

  it('keeps memory/watch-only and sample content discoverable even without connector coverage', () => {
    const memoryOnly = renderTwinBriefingWidget({
      id: 'live',
      structured: {
        coverage: { coldStart: true },
        todos: [],
        topics: [],
        memorySuggestions: [{ id: 'memory-1' }],
        watchRuns: [{ id: 'watch-1' }],
      },
    });
    expect(memoryOnly).toContain('2 updates are ready');
    expect(memoryOnly).toContain('Read full briefing');
    expect(memoryOnly).not.toContain("Connect a source and I'll start your briefing");
  });
});
