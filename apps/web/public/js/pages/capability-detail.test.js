import { describe, expect, it } from 'vitest';
import { renderRegretMessageList, summarizeRegretResults } from './capability-detail.js';

describe('capability regret report', () => {
  it('counts only exact result enums as reported rollbacks', () => {
    expect(summarizeRegretResults([
      { result: 'rolled_back' },
      { result: 'rollback_failed', message: 'not dispatched' },
      { result: 'no_plan_linkage' },
      { result: 'unexpected_success', message: '<img src=x onerror=alert(1)>' },
    ], [{ actionId: 'irreversible' }])).toEqual({
      reportedRolledBack: 1,
      unavailable: 2,
      noPlanLinkage: 1,
      irreversible: 1,
      messages: ['not dispatched', '<img src=x onerror=alert(1)>'],
    });
  });

  it('fails malformed response collections into a non-success report', () => {
    expect(summarizeRegretResults([null, 'invalid'], null)).toEqual({
      reportedRolledBack: 0,
      unavailable: 2,
      noPlanLinkage: 0,
      irreversible: 0,
      messages: [],
    });
    expect(summarizeRegretResults(null, null).reportedRolledBack).toBe(0);
  });

  it('escapes API-derived report messages before rendering', () => {
    const rendered = renderRegretMessageList(['<img src=x onerror=alert(1)>']);
    expect(rendered).toContain('&lt;img');
    expect(rendered).not.toContain('<img');
  });
});
