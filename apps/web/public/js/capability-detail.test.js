// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./pages/capability-detail.js', import.meta.url), 'utf8');

describe('capability rollback report', () => {
  it('renders report-only rollback results without claiming completion', () => {
    expect(source).toContain("status === 'report_only'");
    expect(source).toContain('Review rollback options');
    expect(source).toContain('No changes will be made.');
    expect(source).toContain('Automatic rollback unavailable:');
    expect(source).toContain('No actions were changed. Automatic rollback is not yet available.');
    expect(source).not.toContain("showToast('Regret complete.'");
  });
});
