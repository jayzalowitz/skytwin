import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decisionReceiptRowArtifactV1,
} from '../repositories/decision-receipt-artifacts.js';

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('Gmail archive feedback intent schema', () => {
  const migration = read('../migrations/086-gmail-archive-feedback-intent.sql');
  const schema = read('../schemas/schema.sql');

  it('adds a nullable approval source without rewriting historical feedback', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS approval_request_id UUID');
    expect(migration).not.toMatch(/approval_request_id UUID NOT NULL/i);
    expect(migration).not.toMatch(/UPDATE\s+feedback_events/i);
    expect(schema).toContain('approval_request_id UUID');
  });

  it('fails dirty links before enforcing exact owner, decision, and approval identity', () => {
    const preflight = migration.indexOf('migration_086_feedback_relationship_preflight');
    const foreignKey = migration.indexOf('feedback_events_approval_owner_decision_fk');
    expect(preflight).toBeGreaterThan(-1);
    expect(foreignKey).toBeGreaterThan(preflight);
    expect(migration).toContain('approval.user_id <> feedback.user_id');
    expect(migration).toContain('approval.decision_id <> feedback.decision_id');
    expect(migration).toContain(
      'FOREIGN KEY (approval_request_id, user_id, decision_id)',
    );
    expect(migration).toContain(
      'REFERENCES approval_requests (id, user_id, decision_id)',
    );
    expect(migration).toContain('ON DELETE CASCADE');
  });

  it('permits at most one source feedback event for a non-null approval', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS feedback_events_approval_request_unique_idx',
    );
    expect(migration).toContain('WHERE approval_request_id IS NOT NULL');
    expect(migration).toContain('migration_086_feedback_unique_index_preflight');
  });

  it('keeps feedback source rows nonportable and user-purgeable', () => {
    const backup = read('../backup/backup.ts');
    const userRepository = read('../repositories/user-repository.ts');
    expect(backup).not.toMatch(/(?:SELECT|INSERT INTO)\s+feedback_events/i);
    expect(userRepository.indexOf('DELETE FROM feedback_events')).toBeLessThan(
      userRepository.indexOf('DELETE FROM approval_requests'),
    );
  });

  it('does not change the receipt v1 feedback projection or digest input', () => {
    const historical = {
      id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      decision_id: '33333333-3333-4333-8333-333333333333',
      type: 'approve',
      data: { reason: null },
    };
    expect(decisionReceiptRowArtifactV1('feedback', {
      ...historical,
      approval_request_id: '44444444-4444-4444-8444-444444444444',
    })).toEqual(historical);
  });
});
