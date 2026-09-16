import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('Gmail archive feedback projection schema', () => {
  const migration = read('../migrations/093-gmail-archive-feedback-projection.sql');
  const schema = read('../schemas/schema.sql');

  it('keys one exact application to feedback, owner, decision, and profile', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS twin_feedback_applications');
    expect(migration).toContain('UNIQUE (feedback_event_id)');
    expect(migration).toContain(
      'FOREIGN KEY (feedback_event_id, user_id, decision_id)',
    );
    expect(migration).toContain(
      'REFERENCES feedback_events (id, user_id, decision_id) ON DELETE CASCADE',
    );
    expect(migration).toContain('FOREIGN KEY (profile_id, user_id)');
    expect(migration).not.toMatch(
      /twin_feedback_applications_profile_owner_fk[\s\S]{0,200}ON DELETE CASCADE/,
    );
  });

  it('enforces unique profile versions and changed/no-op version shapes', () => {
    expect(migration).toContain('migration_087_profile_version_duplicate_preflight');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS twin_profile_versions_profile_version_idx',
    );
    expect(migration).toContain(
      'output_profile_version = input_profile_version + 1',
    );
    expect(migration).toContain(
      'output_profile_version = input_profile_version',
    );
    expect(schema).toContain(
      'CONSTRAINT twin_profile_versions_profile_version_idx UNIQUE (profile_id, version)',
    );
  });

  it('requires a canonical digest and validates all IF NOT EXISTS namesakes', () => {
    expect(migration).toContain("output_digest ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain('migration_087_application_relationship_preflight');
    expect(migration).toContain('migration_087_profile_owner_index_preflight');
    expect(migration).toContain('migration_087_profile_version_index_preflight');
    expect(migration).toContain('migration_087_feedback_identity_index_preflight');
    expect(migration).toContain('migration_087_application_feedback_unique_preflight');
    expect(migration).toContain('migration_087_application_feedback_fk_preflight');
    expect(migration).toContain('migration_087_application_profile_fk_preflight');
    expect(migration).toContain('migration_087_application_checks_preflight');
  });

  it('keeps application state installation-local and the leaf unwired', () => {
    const backup = read('../backup/backup.ts');
    const root = read('../index.ts');
    const repositories = read('../repositories/index.ts');
    expect(backup).not.toContain('twin_feedback_applications');
    expect(root).not.toContain('gmailArchiveFeedbackApplicationRepository');
    expect(repositories).not.toContain('gmailArchiveFeedbackApplicationRepository');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS twin_feedback_applications');
  });
});
