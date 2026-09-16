import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('Gmail archive feedback preparation gate boundaries', () => {
  it('uses no additional migration and exposes no new DB root capability', () => {
    expect(existsSync(new URL('../migrations/088-gmail-archive-feedback-preparation.sql', import.meta.url)))
      .toBe(false);
    for (const barrel of [read('../index.ts'), read('../repositories/index.ts')]) {
      expect(barrel).not.toContain('inspectGmailArchiveApprovalFeedbackApplication');
      expect(barrel).not.toContain('InspectGmailArchiveFeedbackApplicationResult');
    }
  });

  it('gates before the execution barrier and never depends on the feedback receipt', () => {
    const source = read('../repositories/gmail-archive-preparation-repository.ts');
    const gate = source.indexOf('inspectGmailArchiveApprovalFeedbackApplication(client, state)');
    const barrier = source.indexOf('SELECT * FROM pre_effect_barriers', gate);
    const eligibility = source.indexOf('FROM signals AS signal', gate);
    const policyWrite = source.indexOf('INSERT INTO explanation_records', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(barrier).toBeGreaterThan(gate);
    expect(eligibility).toBeGreaterThan(barrier);
    expect(policyWrite).toBeGreaterThan(eligibility);
    expect(source).not.toMatch(/feedback-receipt|finalizeGmailArchiveFeedbackReceipt/);
  });

  it('selects one exact approval feedback under lock and keeps the seam read-only', () => {
    const source = read('../repositories/gmail-archive-feedback-application-repository.ts');
    const start = source.indexOf('export async function inspectGmailArchiveApprovalFeedbackApplication');
    const end = source.indexOf('/**\n * Lock and verify the complete application graph', start);
    const seam = source.slice(start, end);
    expect(seam).toContain('feedback.user_id = $1 AND feedback.decision_id = $2');
    expect(seam).toContain('feedback.approval_request_id = $3');
    expect(seam).toContain('ORDER BY feedback.id');
    expect(seam).toContain('LIMIT 2 FOR UPDATE');
    expect(seam).not.toMatch(/\b(?:INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/);
  });

  it('allows the blocked reader only the exact single feedback continuation mode', () => {
    const source = read('../repositories/gmail-archive-terminal-status-repository.ts');
    expect(source).toContain(
      "{ allowSingleFeedbackContinuation: barrier.status === 'blocked' }",
    );
  });
});
