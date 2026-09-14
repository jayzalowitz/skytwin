import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import type { AdversarialCatalog, AdversarialScenario } from '../adversarial-evidence.js';
import { executeMappedAdversarialTests, type TestProcessRunner } from '../adversarial-test-executor.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; testId: string; catalog: AdversarialCatalog } {
  const root = mkdtempSync(join(tmpdir(), 'skytwin-test-map-'));
  roots.push(root);
  const packagePath = join(root, 'packages', 'fake');
  mkdirSync(join(root, 'apps'), { recursive: true });
  mkdirSync(join(packagePath, 'src', '__tests__'), { recursive: true });
  mkdirSync(join(packagePath, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(packagePath, 'package.json'), '{"name":"@skytwin/fake"}\n');
  const scenarioId = 'adv-v1-test-mapped';
  const assertionSource = '// imports, setup, helpers, and exactly one test\n';
  writeFileSync(join(packagePath, 'src', '__tests__', 'mapped.test.ts'), assertionSource);
  writeFileSync(join(packagePath, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\n');
  // Deliberately include the former observation syntax. It is part of the
  // opaque test title only and must never manufacture semantic evidence.
  const fullName = 'suite exact no-op test [observes disposition=blocked_before_dispatch confirmation=dual severity=extreme]';
  const testId = `@skytwin/fake::src/__tests__/mapped.test.ts::${fullName}`;
  const scenario: AdversarialScenario = {
    id: scenarioId,
    runtimeEntryPath: 'test.path',
    adapter: 'none',
    criticalShape: 'send',
    action: { actionType: 'send_email', reversible: false, parameters: {} },
    origin: { kind: 'missing', source: '' },
    provenance: 'untrusted_external',
    failureMode: 'test',
    expectedDisposition: 'blocked_before_dispatch',
    expectedConfirmation: 'dual',
    evidenceMode: 'mapped_regression',
    executableTestId: testId,
    assertionFile: 'packages/fake/src/__tests__/mapped.test.ts',
    assertionSha256: createHash('sha256').update(assertionSource).digest('hex'),
  };
  return {
    root,
    testId,
    catalog: {
      schemaVersion: '1.0.0',
      fixturesVersion: 'v1',
      coverageTargets: {
        runtimeEntryPaths: ['test.path'],
        adapters: ['none'],
        criticalShapes: ['send'],
        origins: ['missing'],
      },
      sourceInventory: [{
        sourceFile: 'apps/fake/src/fake.ts',
        dispatchCall: 'executePrepared',
        runtimeEntryPath: 'test.path',
        occurrences: 1,
      }],
      scenarios: [scenario],
    },
  };
}

function runner(assertions: Array<{ fullName: string; status: string }>, status = 0): TestProcessRunner {
  return () => ({
    pid: 1,
    output: [JSON.stringify({ testResults: [{ assertionResults: assertions }] }), ''],
    stdout: JSON.stringify({ testResults: [{ assertionResults: assertions }] }),
    stderr: '',
    status,
    signal: null,
  } as SpawnSyncReturns<string>);
}

describe('exact mapped adversarial test execution', () => {
  it('records only the outcome of one exact passing assertion', () => {
    const { root, testId, catalog } = fixture();
    const results = executeMappedAdversarialTests(
      catalog,
      root,
      runner([{ fullName: testId.split('::')[2]!, status: 'passed' }]),
    );
    expect(results.get(testId)).toEqual({
      executableTestId: testId,
      status: 'passed',
      reason: 'exact mapped Vitest assertion passed',
      assertionSha256: catalog.scenarios[0]!.assertionSha256,
    });
  });

  it('rejects a stale or missing exact test name', () => {
    const { root, catalog } = fixture();
    expect(() => executeMappedAdversarialTests(
      catalog,
      root,
      runner([{ fullName: 'suite renamed test', status: 'passed' }]),
    )).toThrow('resolved 0 times');
  });

  it('rejects same-named mapped assertions whose implementation changed', () => {
    const { root, catalog } = fixture();
    writeFileSync(
      join(root, 'packages', 'fake', 'src', '__tests__', 'mapped.test.ts'),
      '// same title, but a helper or assertion was weakened to a no-op\n',
    );
    expect(() => executeMappedAdversarialTests(
      catalog,
      root,
      runner([{
        fullName: catalog.scenarios[0]!.executableTestId.split('::')[2]!,
        status: 'passed',
      }]),
    )).toThrow('mapped assertion source digest does not match');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked mapped assertion', () => {
    const { root, catalog } = fixture();
    const assertionPath = join(root, 'packages', 'fake', 'src', '__tests__', 'mapped.test.ts');
    const targetPath = join(root, 'outside-assertion.test.ts');
    writeFileSync(targetPath, '// imports, setup, helpers, and exactly one test\n');
    rmSync(assertionPath);
    symlinkSync(targetPath, assertionPath);
    expect(() => executeMappedAdversarialTests(catalog, root, runner([])))
      .toThrow('contains a symbolic-link component');
  });

  it('rejects a mapped assertion file with more than one executable test', () => {
    const { root, catalog } = fixture();
    const fullName = catalog.scenarios[0]!.executableTestId.split('::')[2]!;
    expect(() => executeMappedAdversarialTests(catalog, root, runner([
      { fullName, status: 'passed' },
      { fullName: 'an unrelated second test', status: 'passed' },
    ]))).toThrow('mapped assertion file must contain exactly one executable test');
  });

  it('rejects sharing one assertion file between mapped scenarios', () => {
    const { root, catalog } = fixture();
    const second = structuredClone(catalog.scenarios[0]!);
    second.id = 'adv-v1-test-mapped-second';
    second.executableTestId = second.executableTestId.replace('no-op test', 'second test');
    catalog.scenarios.push(second);
    expect(() => executeMappedAdversarialTests(catalog, root, runner([])))
      .toThrow('each mapped regression must use a dedicated assertion file');
  });

  it('rejects duplicate exact matches as more than one file assertion', () => {
    const { root, catalog } = fixture();
    expect(() => executeMappedAdversarialTests(
      catalog,
      root,
      runner([
        { fullName: catalog.scenarios[0]!.executableTestId.split('::')[2]!, status: 'passed' },
        { fullName: catalog.scenarios[0]!.executableTestId.split('::')[2]!, status: 'passed' },
      ]),
    )).toThrow('mapped assertion file must contain exactly one executable test');
  });

  it('rejects a failing subprocess even when the mapped assertion passed', () => {
    const { root, catalog } = fixture();
    expect(() => executeMappedAdversarialTests(
      catalog,
      root,
      runner([{ fullName: catalog.scenarios[0]!.executableTestId.split('::')[2]!, status: 'passed' }], 1),
    )).toThrow('failed outside the mapped assertions');
  });

  it('accepts an ordinary mapped title without treating it as semantic data', () => {
    const { root, catalog } = fixture();
    const testId = '@skytwin/fake::src/__tests__/mapped.test.ts::suite exact test';
    catalog.scenarios[0]!.executableTestId = testId;
    expect(executeMappedAdversarialTests(
      catalog,
      root,
      runner([{ fullName: 'suite exact test', status: 'passed' }]),
    ).get(testId)).toEqual({
      executableTestId: testId,
      status: 'passed',
      reason: 'exact mapped Vitest assertion passed',
      assertionSha256: catalog.scenarios[0]!.assertionSha256,
    });
  });
});
