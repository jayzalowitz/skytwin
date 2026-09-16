import { execFileSync, spawnSync } from 'node:child_process';
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
import { verifyAdversarialV2Ci } from './verify-adversarial-v2-ci.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = [];
const worktrees = [];

afterEach(() => {
  for (const path of worktrees.splice(0)) {
    spawnSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', path], {
      encoding: 'utf8',
    });
  }
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
  it('fails closed when the normal verifier has no external trust input', () => {
    expect(() => verifyAdversarialV2Migration())
      .toThrow(/requires a trusted root or commit/i);
    const result = spawnSync(process.execPath, [
      resolve(ROOT, 'scripts/release-evidence/adversarial-v2-migration.mjs'),
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--trusted-commit is required/i);
  });

  it('preserves v1 provenance while keeping both successors reserved and non-claiming', () => {
    const result = verifyAdversarialV2Migration({ trustedRoot: ROOT });
    expect(result).toMatchObject({ status: 'reserved', activeSuccessors: 0 });
    expect(Object.keys(result.baseline.retiredHarnessFingerprints)).toEqual([
      'adv-v1-approvals-untrusted-account-dual',
      'adv-v1-capability-regret-no-dispatch',
    ]);
    expect(result.baseline.limitations.join(' ')).toMatch(/not executed or counted/i);
  });

  it('permits genesis only from the protected event base with exact audited v1 bytes', () => {
    const expectedCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const trustedCommit = fixture().retiredHarnesses[0].lastValidCommit;
    const directory = mkdtempSync(join(ROOT, '.adversarial-v2-event-test-'));
    temporary.push(directory);
    const eventPath = resolve(directory, 'event.json');
    writeFileSync(eventPath, JSON.stringify({
      pull_request: {
        base: { sha: trustedCommit },
        head: { sha: expectedCommit },
      },
    }));
    const result = verifyAdversarialV2Ci({
      root: ROOT,
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
      },
    });
    expect(result).toMatchObject({ trustedCommit, expectedCommit, status: 'reserved' });
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
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths, trustedRoot: ROOT }))
      .toThrow(/required v1 retirement|wrong supersession|exactly one reserved/i);
  });

  it('rejects a forged last-valid commit', () => {
    const changed = fixture();
    changed.retiredHarnesses[0].lastValidCommit = '0'.repeat(40);
    const paths = writeCase(changed);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths, trustedRoot: ROOT }))
      .toThrow(/ancestor|last-valid/i);
  });

  it('rejects a wrong v1 assertion hash even with a shaped digest', () => {
    const changed = fixture();
    changed.retiredHarnesses[0].assertionSha256 = '0'.repeat(64);
    const paths = writeCase(changed);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths, trustedRoot: ROOT }))
      .toThrow(/immutable v1 provenance/i);
  });

  it('rejects wrong supersession provenance', () => {
    const changed = fixture();
    changed.successorReservations[0].supersedes =
      'adv-v1-capability-regret-no-dispatch';
    const paths = writeCase(changed);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths, trustedRoot: ROOT }))
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
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths, trustedRoot: ROOT }))
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

  it('rejects a coordinated fixture and baseline rewrite through the standard CI command', () => {
    const trustedCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const worktree = mkdtempSync(join(dirname(ROOT), 'adversarial-v2-ci-'));
    rmSync(worktree, { recursive: true, force: true });
    execFileSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', worktree, trustedCommit], {
      encoding: 'utf8',
    });
    worktrees.push(worktree);
    const fixturePath = resolve(worktree, V2_MIGRATION_PATH);
    const changed = JSON.parse(readFileSync(fixturePath, 'utf8'));
    changed.retiredHarnesses[0].reason += ' Coordinated rewrite.';
    writeFileSync(fixturePath, `${JSON.stringify(changed, null, 2)}\n`);
    execFileSync(process.execPath, [
      resolve(ROOT, 'scripts/release-evidence/generate-adversarial-v2-migration-baseline.mjs'),
      worktree,
    ]);
    const eventPath = resolve(worktree, '.github-event.json');
    writeFileSync(eventPath, JSON.stringify({
      pull_request: {
        base: { sha: trustedCommit },
        head: { sha: trustedCommit },
      },
    }));
    const result = spawnSync(process.execPath, [
      resolve(ROOT, 'scripts/release-evidence/verify-adversarial-v2-ci.mjs'),
      '--root', worktree,
    ], {
      cwd: worktree,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/deleted or rewritten relative to trusted v2 provenance/i);
  });

  it('rejects deletion from the generated baseline', () => {
    const paths = writeCase(fixture());
    const baseline = JSON.parse(readFileSync(paths.baselinePath, 'utf8'));
    delete baseline.retiredHarnessFingerprints['adv-v1-approvals-untrusted-account-dual'];
    writeFileSync(paths.baselinePath, `${canonicalJson(baseline)}\n`);
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths, trustedRoot: ROOT }))
      .toThrow(/baseline identity|retiredHarnessFingerprints/i);
  });

  it('rejects duplicate keys before interpreting fixture provenance', () => {
    const paths = writeCase(fixture());
    const source = readFileSync(paths.fixturePath, 'utf8');
    writeFileSync(paths.fixturePath, source.replace(
      '"schemaVersion": "2.0.0",',
      '"schemaVersion": "2.0.0",\n  "schemaVersion": "2.0.0",',
    ));
    expect(() => verifyAdversarialV2Migration({ root: ROOT, ...paths, trustedRoot: ROOT }))
      .toThrow(/duplicate JSON key "schemaVersion"/i);
  });
});
