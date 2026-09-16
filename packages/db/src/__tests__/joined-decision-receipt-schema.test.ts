import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('joined decision receipt schema parity', () => {
  it('defines migration 081 and fresh schema with owner-bound roots and repository append keys', () => {
    const migration = read('../migrations/087-joined-decision-receipts.sql');
    const fresh = read('../schemas/schema.sql');
    for (const sql of [migration, fresh]) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS decision_receipts');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS decision_receipt_revisions');
      expect(sql).toContain('FOREIGN KEY (decision_id, user_id) REFERENCES decisions (id, user_id)');
      expect(sql).toContain('UNIQUE (receipt_id, sequence)');
      expect(sql).toContain('UNIQUE (receipt_id, event_key)');
      expect(sql).toContain('trusted BOOL NOT NULL DEFAULT false');
      expect(sql).toContain('revision_digest STRING NOT NULL');
      expect(sql).not.toMatch(/UPDATE\s+decision_receipt/iu);
    }
    expect(fresh).toContain('CREATE TABLE IF NOT EXISTS inference_receipts');
    expect(fresh).toContain('CREATE TABLE IF NOT EXISTS inference_receipt_completions');
    expect(fresh).toContain('CREATE UNIQUE INDEX IF NOT EXISTS explanation_records_id_decision_idx');
  });

  it('keeps the composed fresh schema free of the duplicate execution-plan index artifact', () => {
    const fresh = read('../schemas/schema.sql');
    expect(fresh.match(/CREATE INDEX IF NOT EXISTS idx_decision_outcomes_execution_plan/g)).toHaveLength(1);
  });
});
