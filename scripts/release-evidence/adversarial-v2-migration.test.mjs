import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAdversarialV2MigrationBaseline,
  canonicalJson,
  verifyAdversarialV2Migration,
  V2_BASELINE_PATH,
  V2_MIGRATION_PATH,
} from './adversarial-v2-migration.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  return JSON.parse(readFileSync(resolve(ROOT, V2_MIGRATION_PATH), 'utf8'));
}

function writeCase(value, { regenerate = false } = {}) {
  const directory = mkdtempSync(join(ROOT, '.adversarial-v2-migration-test-'));
  temporary.push(directory);
  const fixturePath = join(directory, 'migration.json');
  const baselinePath = join(directory, 'baseline.json');
  writeFileSync(fixturePath, `${JSON.stringify(value, null, 2)}\n`);
  const baseline = regenerate
    ? buildAdversarialV2MigrationBaseline({ root: ROOT, fixturePath })
    : JSON.parse(readFileSync(resolve(ROOT, V2_BASELINE_PATH), 'utf8'));
  writeFileSync(baselinePath, `${canonicalJson(baseline)}\n`);
  return { fixturePath, baselinePath };
}

describe('v2 adversarial scenario migration', () => {
  it('preserves v1 provenance while keeping both successors reserved and non-claiming', () => {
    const result = verifyAdversarialV2Migration();
    expect(result).toMatchObject({ status: 'reserved', activeSuccessors: 0 });
    expect(Object.keys(result.baseline.retiredHarnessFingerprints)).toEqual([
      'adv-v1-approvals-untrusted-account-dual',
      'adv-v1-capability-regret-no-dispatch',
    ]);
    expect(result.baseline.limitations.join(' ')).toMatch(/not executed or counted/i);
  });

  it('is deterministic under the checked-in generator contract', () => {
    expect(buildAdversarialV2MigrationBaseline()).toEqual(
      JSON.parse(readFileSync(resolve(ROOT, V2_BASELINE_PATH), 'utf8')),
    );
  });

  it('rejects missing retired-harness provenance', () => {
    const changed = fixture();
    changed.retiredHarnesses.shift();
    const paths = writeCase(changed);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths }))
      .toThrow(/required v1 retirement|wrong supersession|exactly one reserved/i);
  });

  it('rejects a forged last-valid commit', () => {
    const changed = fixture();
    changed.retiredHarnesses[0].lastValidCommit = '0'.repeat(40);
    const paths = writeCase(changed);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths }))
      .toThrow(/ancestor|last-valid/i);
  });

  it('rejects a wrong v1 assertion hash even with a shaped digest', () => {
    const changed = fixture();
    changed.retiredHarnesses[0].assertionSha256 = '0'.repeat(64);
    const paths = writeCase(changed);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths }))
      .toThrow(/immutable v1 provenance/i);
  });

  it('rejects wrong supersession provenance', () => {
    const changed = fixture();
    changed.successorReservations[0].supersedes =
      'adv-v1-capability-regret-no-dispatch';
    const paths = writeCase(changed);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths }))
      .toThrow(/wrong supersession provenance/i);
  });

  it('rejects a forged activation record', () => {
    const changed = fixture();
    changed.activations.push({
      id: changed.successorReservations[0].id,
      assertionSha256: changed.successorReservations[0].reservedAssertionSha256,
      activatedAtCommit: changed.retiredHarnesses[0].lastValidCommit,
    });
    const paths = writeCase(changed);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths }))
      .toThrow(/activation provenance|does not contain/i);
  });

  it('rejects a coordinated rewrite relative to trusted v2 provenance', () => {
    const changed = fixture();
    changed.retiredHarnesses[0].reason += ' Rewritten later.';
    const paths = writeCase(changed, { regenerate: true });
    expect(() => verifyAdversarialV2Migration({
      root: ROOT,
      ...paths,
      trustedRoot: ROOT,
    })).toThrow(/deleted or rewritten relative to trusted v2 provenance/i);
  });

  it('rejects deletion from the generated baseline', () => {
    const paths = writeCase(fixture());
    const baseline = JSON.parse(readFileSync(paths.baselinePath, 'utf8'));
    delete baseline.retiredHarnessFingerprints['adv-v1-approvals-untrusted-account-dual'];
    writeFileSync(paths.baselinePath, `${canonicalJson(baseline)}\n`);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths }))
      .toThrow(/baseline identity|retiredHarnessFingerprints/i);
  });

  it('rejects duplicate keys before interpreting fixture provenance', () => {
    const paths = writeCase(fixture());
    const source = readFileSync(paths.fixturePath, 'utf8');
    writeFileSync(paths.fixturePath, source.replace(
      '"schemaVersion": "2.0.0",',
      '"schemaVersion": "2.0.0",\n  "schemaVersion": "2.0.0",',
    ));
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths }))
      .toThrow(/duplicate JSON key "schemaVersion"/i);
  });
});
