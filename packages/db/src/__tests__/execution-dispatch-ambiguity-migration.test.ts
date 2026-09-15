import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../migrations/083-execution-dispatch-ambiguities.sql',
    import.meta.url,
  ),
  'utf8',
);
const schema = readFileSync(
  new URL('../schemas/schema.sql', import.meta.url),
  'utf8',
);

describe('execution dispatch ambiguity schema', () => {
  it.each([migration, schema])(
    'binds one immutable explanation to the exact dispatch lease graph',
    (sql) => {
      expect(sql).toContain('execution_dispatch_ambiguities');
      expect(sql).toContain('PRIMARY KEY');
      expect(sql).toContain('FOREIGN KEY (dispatch_lease_id, decision_id)');
      expect(sql).toContain(
        'REFERENCES credential_dispatch_leases (id, decision_id) ON DELETE CASCADE',
      );
      expect(sql).toContain('FOREIGN KEY (explanation_id, decision_id)');
      expect(sql).toContain('REFERENCES explanation_records (id, decision_id)');
      expect(sql).toContain('execution_dispatch_ambiguities_explanation_idx');
      expect(sql).toContain('evidence_schema_version = 1');
    },
  );

  it('admits only finite trusted observation phases and reason codes', () => {
    for (const value of [
      'adapter_execute',
      'adapter_stream',
      'lease_expiry',
      'lease_recovery',
      'adapter_result_unbound',
      'adapter_exception',
      'stream_protocol_invalid',
      'stream_incomplete',
      'stream_exception',
      'lease_expired',
      'legacy_ambiguous',
    ]) {
      expect(migration).toContain(`'${value}'`);
    }
    expect(migration).not.toContain('raw_error');
    expect(migration).not.toContain('adapter_output');
    expect(migration).not.toContain('capability_hash');
  });
});
