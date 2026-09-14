import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  validateSourceInventory,
  verifyAdversarialEvidence,
} from './verify-adversarial-evidence.mjs';

const baselinePath = new URL('./adversarial-source-checkout-baseline.json', import.meta.url);
const fixturePath = new URL('../../packages/evals/fixtures/v1/adversarial-scenarios.json', import.meta.url);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function scenarioFingerprint(scenario) {
  return createHash('sha256').update(canonicalJson({
    runtimeEntryPath: scenario.runtimeEntryPath,
    adapter: scenario.adapter,
    criticalShape: scenario.criticalShape,
    action: scenario.action,
    origin: scenario.origin,
    provenance: scenario.provenance,
    failureMode: scenario.failureMode,
    expectedDisposition: scenario.expectedDisposition,
    expectedConfirmation: scenario.expectedConfirmation,
    evidenceMode: scenario.evidenceMode,
    executableTestId: scenario.executableTestId,
    assertionFile: scenario.assertionFile,
    assertionSha256: scenario.assertionSha256,
  })).digest('hex');
}

function result(scenario) {
  const deterministic = scenario.evidenceMode === 'deterministic_policy';
  return {
    id: scenario.id,
    runtimeEntryPath: scenario.runtimeEntryPath,
    adapter: scenario.adapter,
    criticalShape: scenario.criticalShape,
    origin: scenario.origin.kind,
    failureMode: scenario.failureMode,
    status: 'passed',
    evidenceMode: scenario.evidenceMode,
    executableTestId: scenario.executableTestId,
    assertionSha256: scenario.assertionSha256,
    executableTestStatus: 'passed',
    expectedDisposition: scenario.expectedDisposition,
    expectedConfirmation: scenario.expectedConfirmation,
    actualDisposition: deterministic ? scenario.expectedDisposition : null,
    actualConfirmation: deterministic
      ? (scenario.expectedConfirmation === 'none' ? null : scenario.expectedConfirmation)
      : null,
    actualSeverity: deterministic
      ? 'destructive'
      : null,
    reason: deterministic
      ? 'deterministic policy primitive matched the catalog expectation'
      : 'exact mapped regression assertion passed with integrity-bound source',
  };
}

function validReport(commit) {
  const results = [...fixture.scenarios].sort((a, b) => a.id.localeCompare(b.id)).map(result);
  return {
    schemaVersion: '1.0.0',
    evidenceClass: 'source_checkout',
    releaseSubject: null,
    attestation: null,
    source: { commit, ref: 'test', cleanTree: true },
    fixtures: { version: 'v1', sha256: baseline.fixtureSha256 },
    exactIds: [...baseline.exactIds],
    environment: { node: '20.19.0', platform: 'linux', arch: 'x64', ci: true },
    determinism: { networkPolicy: 'not_enforced', randomSeed: null, clockPolicy: 'not_controlled', scenarioOrder: 'lexicographic_id' },
    structuralCoverage: {
      scenarios: { covered: results.length, total: results.length },
      runtimeEntryPaths: { covered: 6, total: 10 },
      adapters: { covered: 4, total: 4 },
      criticalShapes: { covered: 8, total: 8 },
      origins: { covered: 7, total: 7 },
    },
    testSummary: { passed: results.length, failed: 0, uncovered: 0 },
    results,
    failures: [],
    mitigations: [...baseline.mitigations],
    limitations: [...baseline.limitations],
    developmentStatus: 'incomplete',
    allowIncomplete: true,
    releaseReadiness: null,
    zeroBypassesClaimed: false,
  };
}

function writeEvidence(directory, report, rawBytes) {
  const path = join(directory, 'evidence.json');
  const bytes = rawBytes ?? `${canonicalJson(report)}\n`;
  writeFileSync(path, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${path}.sha256`, `${digest}  ${basename(path)}\n`);
  return path;
}

function withRepository(run) {
  const directory = mkdtempSync(join(tmpdir(), 'skytwin-adversarial-'));
  try {
    writeFileSync(join(directory, '.gitignore'), 'evidence.json*\nfixture.json\nbaseline.json\n');
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'eval-test@skytwin.invalid'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Eval Test'], { cwd: directory });
    execFileSync('git', ['add', '.gitignore'], { cwd: directory });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: directory });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
    run({
      directory,
      commit,
      options: {
        fixturePath,
        trustedFixturePath: fixturePath,
        expectedCommit: commit,
        requireClean: true,
        repoRoot: directory,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function commitTrustedEvidence(directory, { includeBaseline = true, includeFixture = true } = {}) {
  if (includeBaseline) {
    const trustedBaselinePath = join(
      directory,
      'scripts/release-evidence/adversarial-source-checkout-baseline.json',
    );
    mkdirSync(join(directory, 'scripts/release-evidence'), { recursive: true });
    writeFileSync(trustedBaselinePath, readFileSync(baselinePath));
  }
  if (includeFixture) {
    const trustedFixturePath = join(
      directory,
      'packages/evals/fixtures/v1/adversarial-scenarios.json',
    );
    mkdirSync(join(directory, 'packages/evals/fixtures/v1'), { recursive: true });
    writeFileSync(trustedFixturePath, readFileSync(fixturePath));
  }
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '--quiet', '-m', 'trusted evidence'], { cwd: directory });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
}

function immutableTrustOptions(context, trustedCommit, expectedCommit = trustedCommit) {
  const { trustedFixturePath: _unused, ...options } = context.options;
  return { ...options, trustedCommit, expectedCommit };
}

test('accepts canonical fixture-bound evidence matching the live checkout', () => withRepository((context) => {
  const verified = verifyAdversarialEvidence(
    writeEvidence(context.directory, validReport(context.commit)), baselinePath, context.options,
  );
  assert.equal(verified.scenarioCount, baseline.exactIds.length);
}));

test('reads the trusted baseline and fixture directly from an immutable commit', () =>
  withRepository((context) => {
    const trustedCommit = commitTrustedEvidence(context.directory);
    const verified = verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(trustedCommit)),
      baselinePath,
      immutableTrustOptions(context, trustedCommit),
    );
    assert.equal(verified.scenarioCount, baseline.exactIds.length);
  }));

test('allows immutable-trust bootstrap only when both trusted inputs are absent', () =>
  withRepository((context) => {
    const verified = verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(context.commit)),
      baselinePath,
      immutableTrustOptions(context, context.commit),
    );
    assert.equal(verified.scenarioCount, baseline.exactIds.length);
  }));

test('rejects an immutable trusted commit containing only one evidence input', () =>
  withRepository((context) => {
    const trustedCommit = commitTrustedEvidence(context.directory, { includeFixture: false });
    assert.throws(
      () => verifyAdversarialEvidence(
        writeEvidence(context.directory, validReport(trustedCommit)),
        baselinePath,
        immutableTrustOptions(context, trustedCommit),
      ),
      /must contain both adversarial baseline and fixture or neither/,
    );
  }));

test('rejects mutable trusted paths combined with an immutable trusted commit', () =>
  withRepository((context) => {
    const trustedCommit = commitTrustedEvidence(context.directory);
    assert.throws(
      () => verifyAdversarialEvidence(
        writeEvidence(context.directory, validReport(trustedCommit)),
        baselinePath,
        {
          ...immutableTrustOptions(context, trustedCommit),
          trustedBaselinePath: baselinePath,
          trustedFixturePath: fixturePath,
        },
      ),
      /cannot be combined with trusted filesystem paths/,
    );
  }));

test('source inventory rejects renamed and newly introduced execution dispatch callsites', () => {
  const directory = mkdtempSync(join(tmpdir(), 'skytwin-source-inventory-'));
  const apiRoot = join(directory, 'apps', 'api', 'src', 'routes');
  const workerRoot = join(directory, 'apps', 'worker', 'src', 'jobs');
  const apiServicesRoot = join(directory, 'apps', 'api', 'src', 'services');
  const sourceFile = join(apiRoot, 'events.ts');
  const inventory = [{
    sourceFile: 'apps/api/src/routes/events.ts',
    dispatchCall: 'executePrepared',
    runtimeEntryPath: 'api.events_ingest',
    occurrences: 1,
  }];
  try {
    mkdirSync(apiRoot, { recursive: true });
    mkdirSync(workerRoot, { recursive: true });
    mkdirSync(apiServicesRoot, { recursive: true });
    writeFileSync(sourceFile, 'await router.executePrepared(prepared, action, risk, userId);\n');
    assert.doesNotThrow(() => validateSourceInventory(directory, inventory));

    writeFileSync(sourceFile, [
      '// router.rollback(planId, adapterName)',
      'const example = "router.createRoutine(userId, schedule, plan)";',
      'await router.executePrepared(prepared, action, risk, userId);',
      '',
    ].join('\n'));
    assert.doesNotThrow(() => validateSourceInventory(directory, inventory));

    writeFileSync(sourceFile, 'await router.rollback(planId, adapterName);\n');
    assert.throws(
      () => validateSourceInventory(directory, inventory),
      /missing from sourceInventory.*rollback/,
    );

    writeFileSync(sourceFile, 'await router.executePrepared(prepared, action, risk, userId);\n');
    writeFileSync(join(apiServicesRoot, 'new-entry.ts'), 'await router.executePrepared(prepared, action, risk, userId);\n');
    assert.throws(
      () => validateSourceInventory(directory, inventory),
      /missing from sourceInventory.*new-entry\.ts/,
    );

    rmSync(join(apiServicesRoot, 'new-entry.ts'));
    mkdirSync(join(apiServicesRoot, '__tests__'), { recursive: true });
    mkdirSync(join(apiServicesRoot, 'generated'), { recursive: true });
    writeFileSync(
      join(apiServicesRoot, '__tests__', 'ignored.test.ts'),
      'await router.executePrepared(prepared, action, risk, userId);\n',
    );
    writeFileSync(
      join(apiServicesRoot, 'generated', 'ignored.ts'),
      'await router.executePrepared(prepared, action, risk, userId);\n',
    );
    assert.doesNotThrow(() => validateSourceInventory(directory, inventory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects missing, extra, duplicate, and reordered IDs', () => {
  for (const mutate of [
    (ids) => ids.slice(1),
    (ids) => [...ids, 'adv-v1-extra'],
    (ids) => [...ids.slice(0, -1), ids[0]],
    (ids) => [...ids].reverse(),
  ]) withRepository((context) => {
    const report = validReport(context.commit);
    report.exactIds = mutate(report.exactIds);
    assert.throws(
      () => verifyAdversarialEvidence(writeEvidence(context.directory, report), baselinePath, context.options),
      /exact IDs|unique lexicographically sorted IDs/,
    );
  });
});

test('rejects fixture target drift when only its digest is refreshed', () => withRepository((context) => {
  const changed = structuredClone(fixture);
  changed.coverageTargets.runtimeEntryPaths = changed.coverageTargets.runtimeEntryPaths.slice(1);
  const tamperedFixture = join(context.directory, 'fixture.json');
  const fixtureBytes = `${JSON.stringify(changed)}\n`;
  writeFileSync(tamperedFixture, fixtureBytes);
  const changedBaseline = structuredClone(baseline);
  changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const changedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(context.commit)), changedBaselinePath,
      { ...context.options, fixturePath: tamperedFixture },
    ),
    /coverageTargets\.runtimeEntryPaths do not match/,
  );
}));

test('mapped regressions require dedicated assertion files matching their executable test IDs', () => {
  for (const mutate of [
    (changed) => {
      const mapped = changed.scenarios.filter(({ evidenceMode }) => evidenceMode === 'mapped_regression');
      mapped[0].assertionFile = mapped[1].assertionFile;
      mapped[0].assertionSha256 = mapped[1].assertionSha256;
      return /assertion file does not match executable test ID/;
    },
    (changed) => {
      const mapped = changed.scenarios.filter(({ evidenceMode }) => evidenceMode === 'mapped_regression');
      mapped[1].assertionFile = mapped[0].assertionFile;
      mapped[1].assertionSha256 = mapped[0].assertionSha256;
      const [packageName, file] = mapped[0].executableTestId.split('::');
      mapped[1].executableTestId = `${packageName}::${file}::a distinct full test name`;
      return /each mapped regression must use a dedicated assertion file/;
    },
  ]) withRepository((context) => {
    const changedFixture = structuredClone(fixture);
    const expected = mutate(changedFixture);
    const fixtureBytes = `${JSON.stringify(changedFixture)}\n`;
    const changedFixturePath = join(context.directory, 'fixture.json');
    writeFileSync(changedFixturePath, fixtureBytes);
    const changedBaseline = structuredClone(baseline);
    changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
    const changedBaselinePath = join(context.directory, 'baseline.json');
    writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));
    assert.throws(
      () => verifyAdversarialEvidence(
        writeEvidence(context.directory, validReport(context.commit)), changedBaselinePath,
        { ...context.options, fixturePath: changedFixturePath },
      ),
      expected,
    );
  });
});

test('rejects coordinated fixture and current-baseline target shrink against a trusted prior baseline', () => withRepository((context) => {
  const changedFixture = structuredClone(fixture);
  changedFixture.coverageTargets.runtimeEntryPaths =
    changedFixture.coverageTargets.runtimeEntryPaths.filter((entry) => entry !== 'api.approvals');
  const fixtureBytes = `${JSON.stringify(changedFixture)}\n`;
  const tamperedFixture = join(context.directory, 'fixture.json');
  writeFileSync(tamperedFixture, fixtureBytes);

  const changedBaseline = structuredClone(baseline);
  changedBaseline.coverageTargets.runtimeEntryPaths =
    changedBaseline.coverageTargets.runtimeEntryPaths.filter((entry) => entry !== 'api.approvals');
  changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const changedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));

  const report = validReport(context.commit);
  report.fixtures.sha256 = changedBaseline.fixtureSha256;
  report.structuralCoverage.runtimeEntryPaths.total -= 1;
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, report), changedBaselinePath,
      {
        ...context.options,
        fixturePath: tamperedFixture,
        trustedBaselinePath: baselinePath,
      },
    ),
    /coverageTargets\.runtimeEntryPaths shrank relative to the trusted baseline: api\.approvals/,
  );
}));

test('rejects coordinated fixture, current-baseline, and report scenario shrink against a trusted prior baseline', () => withRepository((context) => {
  // This scenario is redundant across every target dimension, so removing it
  // leaves all coverage-target arrays and dimension counts unchanged. The
  // append-only exact-ID comparison must still preserve the scenario denominator.
  const removedId = 'adv-v1-email-send-untrusted';
  const changedFixture = structuredClone(fixture);
  changedFixture.scenarios = changedFixture.scenarios.filter(({ id }) => id !== removedId);
  const fixtureBytes = `${JSON.stringify(changedFixture)}\n`;
  const tamperedFixture = join(context.directory, 'fixture.json');
  writeFileSync(tamperedFixture, fixtureBytes);

  const changedBaseline = structuredClone(baseline);
  changedBaseline.exactIds = changedBaseline.exactIds.filter((id) => id !== removedId);
  delete changedBaseline.scenarioFingerprints[removedId];
  changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const changedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));

  const report = validReport(context.commit);
  report.exactIds = report.exactIds.filter((id) => id !== removedId);
  report.results = report.results.filter(({ id }) => id !== removedId);
  report.fixtures.sha256 = changedBaseline.fixtureSha256;
  report.structuralCoverage.scenarios = {
    covered: report.results.length,
    total: report.results.length,
  };
  report.testSummary.passed = report.results.length;
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, report), changedBaselinePath,
      {
        ...context.options,
        fixturePath: tamperedFixture,
        trustedBaselinePath: baselinePath,
      },
    ),
    /exactIds shrank relative to the trusted baseline: adv-v1-email-send-untrusted/,
  );
}));

test('rejects coordinated weakening of an existing scenario semantic contract', () => withRepository((context) => {
  const changedFixture = structuredClone(fixture);
  const changedScenario = changedFixture.scenarios.find(({ id }) =>
    id === 'adv-v1-email-send-untrusted');
  changedScenario.expectedDisposition = 'response_rejected';
  const fixtureBytes = `${JSON.stringify(changedFixture)}\n`;
  const changedFixturePath = join(context.directory, 'fixture.json');
  writeFileSync(changedFixturePath, fixtureBytes);

  const changedBaseline = structuredClone(baseline);
  changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  changedBaseline.scenarioFingerprints[changedScenario.id] = scenarioFingerprint(changedScenario);
  const changedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));

  const report = validReport(context.commit);
  report.fixtures.sha256 = changedBaseline.fixtureSha256;
  const changedResult = report.results.find(({ id }) => id === changedScenario.id);
  changedResult.expectedDisposition = changedScenario.expectedDisposition;
  changedResult.actualDisposition = changedScenario.expectedDisposition;
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, report), changedBaselinePath,
      {
        ...context.options,
        fixturePath: changedFixturePath,
        trustedBaselinePath: baselinePath,
      },
    ),
    /scenario semantic fingerprint changed relative to the trusted baseline/,
  );
}));

test('rejects an untrusted fixture presented beside a trusted baseline', () => withRepository((context) => {
  const changedFixturePath = join(context.directory, 'fixture.json');
  writeFileSync(changedFixturePath, `${JSON.stringify({ ...fixture, unexpected: true })}\n`);
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(context.commit)), baselinePath,
      {
        ...context.options,
        trustedBaselinePath: baselinePath,
        trustedFixturePath: changedFixturePath,
      },
    ),
    /trusted fixture SHA-256 does not match/,
  );
}));

test('rejects removal or rewriting of trusted mitigation and limitation rails', () => {
  for (const rail of ['mitigations', 'limitations']) withRepository((context) => {
    const changedBaseline = structuredClone(baseline);
    changedBaseline[rail] = changedBaseline[rail].slice(1);
    const changedBaselinePath = join(context.directory, 'baseline.json');
    writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));
    assert.throws(
      () => verifyAdversarialEvidence(
        writeEvidence(context.directory, validReport(context.commit)), changedBaselinePath,
        { ...context.options, trustedBaselinePath: baselinePath },
      ),
      new RegExp(`${rail} changed or shrank relative to the trusted baseline`),
    );
  });
});

test('rejects a live dispatch call omitted from the coordinated source inventory', () => withRepository((context) => {
  const changedFixture = structuredClone(fixture);
  changedFixture.sourceInventory = changedFixture.sourceInventory.filter(({ sourceFile }) =>
    sourceFile !== 'apps/api/src/routes/events.ts');
  const fixtureBytes = `${JSON.stringify(changedFixture)}\n`;
  const changedFixturePath = join(context.directory, 'fixture.json');
  writeFileSync(changedFixturePath, fixtureBytes);
  const changedBaseline = structuredClone(baseline);
  changedBaseline.sourceInventory = changedFixture.sourceInventory;
  changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const changedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));
  const report = validReport(context.commit);
  report.fixtures.sha256 = changedBaseline.fixtureSha256;
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, report), changedBaselinePath,
      { ...context.options, fixturePath: changedFixturePath },
    ),
    /runtime dispatch source is missing from sourceInventory.*events\.ts/,
  );
}));

test('allows trusted inventory callsites to move while preserving semantic runtime paths', () => withRepository((context) => {
  const trustedFixture = structuredClone(fixture);
  trustedFixture.sourceInventory[0].sourceFile = 'apps/api/src/legacy/approvals.ts';
  const trustedFixtureBytes = `${JSON.stringify(trustedFixture)}\n`;
  const trustedFixturePath = join(context.directory, 'fixture.json');
  writeFileSync(trustedFixturePath, trustedFixtureBytes);
  const trustedBaseline = structuredClone(baseline);
  trustedBaseline.sourceInventory = trustedFixture.sourceInventory;
  trustedBaseline.fixtureSha256 = createHash('sha256').update(trustedFixtureBytes).digest('hex');
  const trustedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(trustedBaselinePath, JSON.stringify(trustedBaseline));

  const verified = verifyAdversarialEvidence(
    writeEvidence(context.directory, validReport(context.commit)), baselinePath,
    {
      ...context.options,
      trustedBaselinePath,
      trustedFixturePath,
    },
  );
  assert.equal(verified.scenarioCount, baseline.exactIds.length);
}));

test('rejects a semantic runtime path removed through coordinated inventory relabeling', () => withRepository((context) => {
  const changedFixture = structuredClone(fixture);
  const approvalsEntry = changedFixture.sourceInventory.find(({ runtimeEntryPath }) =>
    runtimeEntryPath === 'api.approvals');
  approvalsEntry.runtimeEntryPath = 'api.events_ingest';
  const fixtureBytes = `${JSON.stringify(changedFixture)}\n`;
  const changedFixturePath = join(context.directory, 'fixture.json');
  writeFileSync(changedFixturePath, fixtureBytes);
  const changedBaseline = structuredClone(baseline);
  changedBaseline.sourceInventory = changedFixture.sourceInventory;
  changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const changedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));
  const report = validReport(context.commit);
  report.fixtures.sha256 = changedBaseline.fixtureSha256;

  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, report), changedBaselinePath,
      {
        ...context.options,
        fixturePath: changedFixturePath,
        trustedBaselinePath: baselinePath,
      },
    ),
    /sourceInventory semantic runtime paths shrank relative to the trusted baseline: api\.approvals/,
  );
}));

test('rejects schema and fixture version downgrades against a trusted prior baseline', () => {
  for (const [field, value, message] of [
    ['schemaVersion', '0.9.0', /schemaVersion downgraded relative to the trusted baseline/],
    ['fixturesVersion', 'v0', /fixturesVersion downgraded relative to the trusted baseline/],
  ]) withRepository((context) => {
    const changedBaseline = structuredClone(baseline);
    changedBaseline[field] = value;
    const changedBaselinePath = join(context.directory, 'baseline.json');
    writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));
    assert.throws(
      () => verifyAdversarialEvidence(
        writeEvidence(context.directory, validReport(context.commit)), changedBaselinePath,
        { ...context.options, trustedBaselinePath: baselinePath },
      ),
      message,
    );
  });
});

test('allows an exact scenario addition relative to the trusted prior baseline', () => withRepository((context) => {
  const added = structuredClone(fixture.scenarios[0]);
  added.id = 'adv-v1-z-added-send';
  added.executableTestId = `${added.executableTestId} added coverage`;
  const changedFixture = structuredClone(fixture);
  changedFixture.scenarios.push(added);
  const fixtureBytes = `${JSON.stringify(changedFixture)}\n`;
  const changedFixturePath = join(context.directory, 'fixture.json');
  writeFileSync(changedFixturePath, fixtureBytes);

  const changedBaseline = structuredClone(baseline);
  changedBaseline.exactIds = [...changedBaseline.exactIds, added.id].sort();
  changedBaseline.scenarioFingerprints[added.id] = scenarioFingerprint(added);
  changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const changedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));

  const report = validReport(context.commit);
  report.exactIds = [...report.exactIds, added.id].sort();
  report.results = [...report.results, result(added)].sort((a, b) => a.id.localeCompare(b.id));
  report.fixtures.sha256 = changedBaseline.fixtureSha256;
  report.structuralCoverage.scenarios = {
    covered: report.results.length,
    total: report.results.length,
  };
  report.testSummary.passed = report.results.length;
  const verified = verifyAdversarialEvidence(
    writeEvidence(context.directory, report), changedBaselinePath,
    {
      ...context.options,
      fixturePath: changedFixturePath,
      trustedBaselinePath: baselinePath,
    },
  );
  assert.equal(verified.scenarioCount, baseline.exactIds.length + 1);
}));

test('rejects fixture payload, immutable metadata, and inflated structural coverage', () => withRepository((context) => {
  const tamperedFixture = join(context.directory, 'fixture.json');
  const changed = structuredClone(fixture);
  changed.scenarios[0].failureMode = 'changed fixture payload';
  writeFileSync(tamperedFixture, `${JSON.stringify(changed)}\n`);
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(context.commit)), baselinePath,
      { ...context.options, fixturePath: tamperedFixture },
    ),
    /fixture SHA-256/,
  );
  const metadata = validReport(context.commit);
  metadata.results[0].runtimeEntryPath = 'api.assistant';
  assert.throws(
    () => verifyAdversarialEvidence(writeEvidence(context.directory, metadata), baselinePath, context.options),
    /runtimeEntryPath does not match/,
  );
  const inflated = validReport(context.commit);
  inflated.structuralCoverage.runtimeEntryPaths.covered = 9;
  assert.throws(
    () => verifyAdversarialEvidence(writeEvidence(context.directory, inflated), baselinePath, context.options),
    /fixture-derived coverage/,
  );
}));

test('rejects a provenance label that contradicts the frozen origin', () => withRepository((context) => {
  const changedFixture = structuredClone(fixture);
  const scenario = changedFixture.scenarios.find(({ id }) => id === 'adv-v1-email-send-untrusted');
  scenario.provenance = 'user_originated';
  const fixtureBytes = `${JSON.stringify(changedFixture)}\n`;
  const changedFixturePath = join(context.directory, 'fixture.json');
  writeFileSync(changedFixturePath, fixtureBytes);
  const changedBaseline = structuredClone(baseline);
  changedBaseline.fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  changedBaseline.scenarioFingerprints[scenario.id] = scenarioFingerprint(scenario);
  const changedBaselinePath = join(context.directory, 'baseline.json');
  writeFileSync(changedBaselinePath, JSON.stringify(changedBaseline));
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(context.commit)), changedBaselinePath,
      { ...context.options, fixturePath: changedFixturePath },
    ),
    /provenance does not match its origin/,
  );
}));

test('rejects stale source identity and mismatched live clean state', () => withRepository((context) => {
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(context.commit)), baselinePath,
      { ...context.options, expectedCommit: '0'.repeat(40) },
    ),
    /expected and live checkout/,
  );
  const falselyDirty = validReport(context.commit);
  falselyDirty.source.cleanTree = false;
  assert.throws(
    () => verifyAdversarialEvidence(writeEvidence(context.directory, falselyDirty), baselinePath, context.options),
    /clean-tree state/,
  );
  writeFileSync(join(context.directory, 'dirty.txt'), 'dirty\n');
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(context.commit)), baselinePath, context.options,
    ),
    /clean-tree state|must be clean/,
  );
  const honestlyDirty = validReport(context.commit);
  honestlyDirty.source.cleanTree = false;
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, honestlyDirty), baselinePath, context.options,
    ),
    /must be clean/,
  );
}));

test('rejects noncanonical bytes and duplicate JSON keys', () => withRepository((context) => {
  const report = validReport(context.commit);
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, report, `${JSON.stringify(report, null, 2)}\n`),
      baselinePath, context.options,
    ),
    /not canonical JSON/,
  );
  const canonical = canonicalJson(report);
  const duplicate = canonical.replace(
    '"schemaVersion":"1.0.0"',
    '"schemaVersion":"0.0.0","schemaVersion":"1.0.0"',
  );
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, report, `${duplicate}\n`), baselinePath, context.options,
    ),
    /duplicate JSON key/,
  );
}));

test('rejects duplicate keys in current and trusted fixture/baseline inputs', () => {
  const duplicateSchemaVersion = (bytes) => bytes.replace(
    '"schemaVersion": "1.0.0",',
    '"schemaVersion": "0.0.0",\n  "schemaVersion": "1.0.0",',
  );

  for (const input of ['baseline', 'fixture', 'trusted baseline', 'trusted fixture']) {
    withRepository((context) => {
      const reportPath = writeEvidence(context.directory, validReport(context.commit));
      const options = { ...context.options };
      let currentBaselinePath = baselinePath;

      if (input === 'baseline') {
        currentBaselinePath = join(context.directory, 'baseline.json');
        writeFileSync(
          currentBaselinePath,
          duplicateSchemaVersion(readFileSync(baselinePath, 'utf8')),
        );
      } else if (input === 'fixture') {
        const currentFixturePath = join(context.directory, 'fixture.json');
        writeFileSync(
          currentFixturePath,
          duplicateSchemaVersion(readFileSync(fixturePath, 'utf8')),
        );
        options.fixturePath = currentFixturePath;
      } else if (input === 'trusted baseline') {
        const trustedBaselinePath = join(context.directory, 'baseline.json');
        writeFileSync(
          trustedBaselinePath,
          duplicateSchemaVersion(readFileSync(baselinePath, 'utf8')),
        );
        options.trustedBaselinePath = trustedBaselinePath;
      } else {
        const trustedFixturePath = join(context.directory, 'fixture.json');
        const trustedFixtureBytes = duplicateSchemaVersion(readFileSync(fixturePath, 'utf8'));
        writeFileSync(trustedFixturePath, trustedFixtureBytes);
        const trustedBaseline = structuredClone(baseline);
        trustedBaseline.fixtureSha256 = createHash('sha256')
          .update(trustedFixtureBytes)
          .digest('hex');
        const trustedBaselinePath = join(context.directory, 'baseline.json');
        writeFileSync(trustedBaselinePath, JSON.stringify(trustedBaseline));
        options.trustedBaselinePath = trustedBaselinePath;
        options.trustedFixturePath = trustedFixturePath;
      }

      assert.throws(
        () => verifyAdversarialEvidence(reportPath, currentBaselinePath, options),
        new RegExp(`${input} contains duplicate JSON key`),
      );
    });
  }
});

test('rejects nested duplicate keys whose spellings use equivalent JSON escapes', () =>
  withRepository((context) => {
    const changedBaselinePath = join(context.directory, 'baseline.json');
    const duplicate = readFileSync(baselinePath, 'utf8').replace(
      '"runtimeEntryPaths": [',
      '"runtimeEntryPaths": [],\n    "\\u0072untimeEntryPaths": [',
    );
    writeFileSync(changedBaselinePath, duplicate);
    assert.throws(
      () => verifyAdversarialEvidence(
        writeEvidence(context.directory, validReport(context.commit)),
        changedBaselinePath,
        context.options,
      ),
      /baseline contains duplicate JSON key "runtimeEntryPaths"/,
    );
  }));

test('rejects malformed UTF-8 before interpreting baseline JSON', () =>
  withRepository((context) => {
    const changedBaselinePath = join(context.directory, 'baseline.json');
    const bytes = Buffer.from(readFileSync(baselinePath));
    const index = bytes.indexOf(Buffer.from('source_checkout'));
    assert.notEqual(index, -1);
    bytes[index] = 0xff;
    writeFileSync(changedBaselinePath, bytes);
    assert.throws(
      () => verifyAdversarialEvidence(
        writeEvidence(context.directory, validReport(context.commit)),
        changedBaselinePath,
        context.options,
      ),
      /baseline is not valid UTF-8/,
    );
  }));

test('rejects symlinked evidence inputs before parsing them', {
  skip: process.platform === 'win32',
}, () => withRepository((context) => {
  const linkedFixture = join(context.directory, 'linked-fixture.json');
  symlinkSync(fileURLToPath(fixturePath), linkedFixture);
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, validReport(context.commit)),
      baselinePath,
      { ...context.options, fixturePath: linkedFixture },
    ),
    /fixture could not be read safely.*symbolic-link component/,
  );
}));

test('rejects invalid actual enums and contradictory mapped semantics', () => withRepository((context) => {
  const invalid = validReport(context.commit);
  invalid.results[0].actualSeverity = 'catastrophic';
  assert.throws(
    () => verifyAdversarialEvidence(writeEvidence(context.directory, invalid), baselinePath, context.options),
    /invalid actual value/,
  );
  const missingActual = validReport(context.commit);
  const deterministic = missingActual.results.find((entry) => entry.evidenceMode === 'deterministic_policy');
  deterministic.actualSeverity = null;
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, missingActual), baselinePath, context.options,
    ),
    /incomplete deterministic-policy actuals/,
  );
  const fabricatedActual = validReport(context.commit);
  const fabricatedMapped = fabricatedActual.results.find((entry) =>
    entry.evidenceMode === 'mapped_regression');
  fabricatedMapped.actualDisposition = fabricatedMapped.expectedDisposition;
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, fabricatedActual), baselinePath, context.options,
    ),
    /mapped-regression semantics/,
  );
  const contradictory = validReport(context.commit);
  const mapped = contradictory.results.find((entry) => entry.evidenceMode === 'mapped_regression');
  mapped.status = 'failed';
  contradictory.testSummary = { passed: contradictory.results.length - 1, failed: 1, uncovered: 0 };
  contradictory.failures = [{ id: mapped.id, reason: mapped.reason }];
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, contradictory), baselinePath, context.options,
    ),
    /mapped-regression semantics/,
  );
}));

test('rejects mutable claim text and a checksum for different bytes', () => withRepository((context) => {
  const claims = validReport(context.commit);
  claims.limitations.pop();
  assert.throws(
    () => verifyAdversarialEvidence(writeEvidence(context.directory, claims), baselinePath, context.options),
    /immutable baseline/,
  );
  const completeClaim = validReport(context.commit);
  completeClaim.developmentStatus = 'complete';
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, completeClaim), baselinePath, context.options,
    ),
    /release claim/,
  );
  const path = writeEvidence(context.directory, validReport(context.commit));
  writeFileSync(`${path}.sha256`, `${'0'.repeat(64)}  evidence.json\n`);
  assert.throws(() => verifyAdversarialEvidence(path, baselinePath, context.options), /SHA-256/);
}));

test('rejects a tampered failure reason even when the failure ID is unchanged', () => withRepository((context) => {
  const report = validReport(context.commit);
  const mapped = report.results.find((entry) => entry.evidenceMode === 'mapped_regression');
  mapped.status = 'failed';
  mapped.executableTestStatus = 'failed';
  mapped.actualDisposition = null;
  mapped.actualConfirmation = null;
  mapped.actualSeverity = null;
  mapped.reason = 'mapped executable test failed';
  report.testSummary = { passed: report.results.length - 1, failed: 1, uncovered: 0 };
  report.failures = [{ id: mapped.id, reason: 'tampered failure reason' }];
  assert.throws(
    () => verifyAdversarialEvidence(
      writeEvidence(context.directory, report), baselinePath, context.options,
    ),
    /ordered failure records/,
  );
}));
