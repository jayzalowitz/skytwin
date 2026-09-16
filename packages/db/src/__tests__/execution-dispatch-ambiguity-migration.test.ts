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

const phases = ['adapter_execute', 'adapter_stream', 'lease_expiry', 'lease_recovery'];
const reasonCodes = [
  'adapter_result_unbound',
  'adapter_exception',
  'stream_protocol_invalid',
  'stream_incomplete',
  'stream_exception',
  'lease_expired',
  'legacy_ambiguous',
];
const validPairs = [
  ['adapter_execute', 'adapter_result_unbound'],
  ['adapter_execute', 'adapter_exception'],
  ['adapter_stream', 'stream_protocol_invalid'],
  ['adapter_stream', 'stream_incomplete'],
  ['adapter_stream', 'stream_exception'],
  ['lease_expiry', 'lease_expired'],
  ['lease_recovery', 'legacy_ambiguous'],
].map(([phase, reasonCode]) => `${phase}:${reasonCode}`).sort();

function extractAllowedPairs(sql: string): string[] {
  const constraint = sql.match(
    /CONSTRAINT execution_dispatch_ambiguity_observation_pair_check CHECK \(([\s\S]*?)\n  \),\n  observation/,
  )?.[1];
  expect(constraint).toBeDefined();
  const pairs: string[] = [];
  for (const match of constraint!.matchAll(
    /phase = '([^']+)' AND reason_code IN \(([^)]*)\)/g,
  )) {
    const phase = match[1]!;
    for (const reason of match[2]!.matchAll(/'([^']+)'/g)) {
      pairs.push(`${phase}:${reason[1]}`);
    }
  }
  return pairs.sort();
}

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

  it.each([migration, schema])(
    'admits exactly the finite trusted phase and reason-code pairs',
    (sql) => {
      const allowed = extractAllowedPairs(sql);
      expect(allowed).toEqual(validPairs);
      for (const phase of phases) {
        for (const reasonCode of reasonCodes) {
          const pair = `${phase}:${reasonCode}`;
          if (validPairs.includes(pair)) expect(allowed).toContain(pair);
          else expect(allowed).not.toContain(pair);
        }
      }
    },
  );

  it('does not admit unknown phase or reason values independently', () => {
    for (const sql of [migration, schema]) {
      expect(sql).toContain('execution_dispatch_ambiguity_observation_pair_check');
      expect(sql).not.toMatch(/phase STRING NOT NULL CHECK/);
      expect(sql).not.toMatch(/reason_code STRING NOT NULL CHECK/);
    }
    expect(migration).not.toContain('raw_error');
    expect(migration).not.toContain('adapter_output');
    expect(migration).not.toContain('capability_hash');
  });
});
