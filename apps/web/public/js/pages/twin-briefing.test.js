// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deadlineClass,
  deriveBoundaryStatus,
  hasMissingWriteScope,
  humanizeBlockReason,
  renderActions,
  renderBoundaryStatus,
  renderColdStart,
  renderDigestSection,
  renderProseSection,
} from './twin-briefing.js';

describe('briefing designed states', () => {
  it('renders distinct cold-start and connected quiet states', () => {
    const cold = renderDigestSection({ coverage: { coldStart: true, capabilityStatus: [] } });
    expect(cold).toContain("Connect a source and I'll start your briefing");
    expect((cold.match(/class="digest-act primary"/g) || [])).toHaveLength(1);
    const quiet = renderDigestSection({ coverage: { coldStart: false }, todos: [], topics: [] });
    expect(quiet).toContain("You're all caught up");
    expect(quiet).toContain('Nothing needs you right now');
  });

  it('recognizes only the canonical missing-write-scope reason', () => {
    expect(hasMissingWriteScope({
      blockedReasonCodes: ['missing_write_scope:gmail'],
      whyNotAutoExecuted: ["I don't have permission to do this for you yet"],
    })).toBe(true);
    const legacyLiveDigestDetail = {
      blockedReasonCodes: [],
      whyNotAutoExecuted: ['missing_write_scope:gmail.send'],
    };
    expect(hasMissingWriteScope(legacyLiveDigestDetail)).toBe(false);
    expect(renderActions({ detail: legacyLiveDigestDetail, actions: [] })).not.toContain('class="digest-act grant"');
    expect(humanizeBlockReason('missing_write_scope:gmail')).toBe('This source has not granted write access');
    expect(humanizeBlockReason('trust_tier:observer')).toBe('Your current trust level requires review');
  });

  it('renders a quiet grant action for scope-blocked work', () => {
    const html = renderActions({
      detail: {
        blockedReasonCodes: ['missing_write_scope:gmail'],
        whyNotAutoExecuted: ["I don't have permission to do this for you yet"],
      },
      actions: [{ id: 'send', label: 'Send' }],
    });
    expect(html).toContain('class="digest-act grant"');
    expect(html).not.toContain('data-act="send"');
  });

  it('renders digest content ahead of connector cold-start coverage', () => {
    const html = renderDigestSection({
      coverage: { coldStart: true, connected: [] },
      todos: [{
        ref: 'sample-decision-1',
        text: 'Review the sample account notice',
        detail: { blockedReasonCodes: [], whyNotAutoExecuted: [] },
      }],
      topics: [],
    });
    expect(html).toContain('Review the sample account notice');
    expect(html).not.toContain("Connect a source and I'll start your briefing");
  });

  it('renders at most one primary action per ordinary row', () => {
    const html = renderActions({
      actions: [
        { id: 'accept', label: 'Accept' },
        { id: 'propose', label: 'Propose new' },
      ],
    });
    expect((html.match(/\bprimary\b/g) || [])).toHaveLength(1);
    expect(html).toContain('data-act="accept"');
    expect(html).toContain('data-act="propose"');
  });

  it('marks parseable past deadlines overdue without guessing on prose labels', () => {
    expect(deadlineClass('2026-01-01T00:00:00Z', Date.parse('2026-02-01T00:00:00Z'))).toBe(' is-overdue');
    expect(deadlineClass('in 2 days', Date.parse('2026-02-01T00:00:00Z'))).toBe('');
  });

  it('derives truthful sample, local, remote, and unavailable status', () => {
    expect(deriveBoundaryStatus(null, true)).toEqual({
      reasoning: 'Deterministic sample',
      network: 'No external inference request',
      autonomy: 'Just watch',
    });
    expect(deriveBoundaryStatus(null)).toEqual({
      reasoning: 'Status unavailable',
      network: 'Status unavailable',
      autonomy: 'Status unavailable',
    });
    const remote = deriveBoundaryStatus({
      trustTier: 'observer',
      reasoningMode: { mode: 'bring_your_own_provider' },
      aiProviders: [{ enabled: true, privacy: { networkScope: 'external' } }],
    });
    expect(remote).toMatchObject({ reasoning: 'Configured provider', network: 'External network', autonomy: 'Just watch' });
    expect(renderBoundaryStatus(remote)).toContain('aria-label="Current boundaries"');
  });

  it('renders prose fallback when no structured payload exists', () => {
    const prose = { innerHTML: '' };
    const originalGet = document.getElementById;
    document.getElementById = (id) => id === 'briefing-prose' ? prose : null;
    renderProseSection({
      id: 'briefing-1',
      prose_markdown: 'A calm prose fallback.',
      generated_at: '2026-09-10T00:00:00Z',
      read_at: null,
    });
    expect(prose.innerHTML).toContain('A calm prose fallback.');
    expect(prose.innerHTML).not.toContain('<details class="briefing-prose-details">');
    document.getElementById = originalGet;
  });

  it('keeps loading/error and route gating in the source', () => {
    const source = readFileSync(new URL('./twin-briefing.js', import.meta.url), 'utf8');
    expect(source).toContain('aria-label="Loading briefing"');
    expect(source).toContain("Couldn't load your twin briefing.");
    expect(source).toContain('briefing-prose-content');
    expect(source).toContain("=== '#/briefing'");
    expect(source).not.toMatch(/onclick\s*=/i);
    expect(renderColdStart({})).toContain('data-action="connect-source"');
  });
});
