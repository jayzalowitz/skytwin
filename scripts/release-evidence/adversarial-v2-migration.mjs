#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStableRegularFile } from '../release-artifacts/file-integrity.mjs';
import { createTrustedGit } from './trusted-git.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '../..');
export const V2_MIGRATION_PATH = 'packages/evals/fixtures/v2/adversarial-scenario-migration.json';
export const V2_BASELINE_PATH = 'scripts/release-evidence/adversarial-v2-migration-baseline.json';
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const V1_ID = /^adv-v1-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const V2_ID = /^adv-v2-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ASSERTION_FILE = /^apps\/api\/src\/__tests__\/[a-z0-9._-]+\.test\.ts$/u;
const V1_FIXTURE_PATH = 'packages/evals/fixtures/v1/adversarial-scenarios.json';
const V1_BASELINE_PATH = 'scripts/release-evidence/adversarial-source-checkout-baseline.json';
const V1_FIXTURE_SHA256 = '3b0125d632a18cb92c2c8a7630ced35c4d369ccc7e777f8a1697f7b0c8c473a8';
const V1_BASELINE_SHA256 = '60133bfd2e0bf5b731e4bb1b51ac3bd4741b99ae8bd11998f7506f81dae12598';
const MIGRATION_BASE_COMMIT = '7c39fa4aa36bbb6716a305c21f7c733a7a99bc41';
const REQUIRED_SUPERSESSIONS = new Map([
  ['adv-v1-approvals-untrusted-account-dual', 'adv-v2-approvals-preflight-explanation'],
  ['adv-v1-capability-regret-no-dispatch', 'adv-v2-capability-regret-explanation'],
]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ASSERTION_BYTES = 4 * 1024 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('canonical JSON cannot encode undefined');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(object(value, label)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function sortedUnique(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
      new Set(value).size !== value.length ||
      JSON.stringify(value) !== JSON.stringify([...value].sort())) {
    throw new Error(`${label} must be a unique sorted string array`);
  }
  return value;
}

function readJson(root, path, label) {
  let bytes;
  try {
    bytes = readStableRegularFile(root, resolve(root, path), { maxBytes: MAX_JSON_BYTES }).bytes;
  } catch (error) {
    throw new Error(`${label} could not be read safely: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return { bytes, value: parseJsonBytes(bytes, label) };
}

function parseJsonBytes(bytes, label) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(source[offset] ?? '')) offset += 1;
  };
  const scanString = () => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === '\\') {
        offset += 2;
      } else if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset));
      } else {
        offset += 1;
      }
    }
    throw new Error(`${label} contains an unterminated JSON string`);
  };
  const scanValue = () => {
    skipWhitespace();
    if (source[offset] === '{') {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      if (source[offset] === '}') {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        const key = scanString();
        if (keys.has(key)) {
          throw new Error(`${label} contains duplicate JSON key ${JSON.stringify(key)}`);
        }
        keys.add(key);
        skipWhitespace();
        offset += 1;
        scanValue();
        skipWhitespace();
        if (source[offset] === '}') {
          offset += 1;
          return;
        }
        offset += 1;
        skipWhitespace();
      }
    } else if (source[offset] === '[') {
      offset += 1;
      skipWhitespace();
      if (source[offset] === ']') {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        scanValue();
        skipWhitespace();
        if (source[offset] === ']') {
          offset += 1;
          return;
        }
        offset += 1;
      }
    } else if (source[offset] === '"') {
      scanString();
    } else {
      while (offset < source.length && !/[\s,\]}]/u.test(source[offset])) offset += 1;
    }
  };
  scanValue();
  return object(value, label);
}

function gitBytes(root, commit, path) {
  const git = createTrustedGit(root);
  const result = git.spawn(['show', `${commit}:${path}`], {
    encoding: null,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`last-valid commit does not contain ${path}`);
  }
  return result.stdout;
}

function assertAncestor(root, commit) {
  const git = createTrustedGit(root);
  const result = git.spawn(['merge-base', '--is-ancestor', commit, 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('last-valid commit is not an ancestor of the current checkout');
  }
}

function fingerprint(value) {
  return sha256(canonicalJson(value));
}

function parseMigration(root, fixturePath = V2_MIGRATION_PATH) {
  const { bytes, value } = readJson(root, fixturePath, 'v2 migration fixture');
  exactKeys(value, [
    'schemaVersion', 'fixturesVersion', 'predecessor', 'retiredHarnesses',
    'successorReservations', 'activations', 'limitations',
  ], 'v2 migration fixture');
  if (value.schemaVersion !== '2.0.0' || value.fixturesVersion !== 'v2') {
    throw new Error('v2 migration fixture version is unsupported');
  }
  const predecessor = object(value.predecessor, 'predecessor');
  exactKeys(predecessor, [
    'fixturesVersion', 'fixturePath', 'fixtureSha256', 'baselinePath', 'baselineSha256',
  ], 'predecessor');
  if (predecessor.fixturesVersion !== 'v1' || !SHA256.test(predecessor.fixtureSha256) ||
      !SHA256.test(predecessor.baselineSha256)) {
    throw new Error('predecessor identity is malformed');
  }
  if (predecessor.fixturePath !== V1_FIXTURE_PATH ||
      predecessor.baselinePath !== V1_BASELINE_PATH ||
      predecessor.fixtureSha256 !== V1_FIXTURE_SHA256 ||
      predecessor.baselineSha256 !== V1_BASELINE_SHA256) {
    throw new Error('immutable v1 predecessor identity was rewritten');
  }
  const v1Fixture = readJson(root, predecessor.fixturePath, 'v1 fixture');
  const v1Baseline = readJson(root, predecessor.baselinePath, 'v1 baseline');
  if (sha256(v1Fixture.bytes) !== predecessor.fixtureSha256 ||
      sha256(v1Baseline.bytes) !== predecessor.baselineSha256) {
    throw new Error('immutable v1 predecessor bytes changed');
  }

  if (!Array.isArray(value.retiredHarnesses) || value.retiredHarnesses.length === 0) {
    throw new Error('retiredHarnesses must be a non-empty array');
  }
  const retired = value.retiredHarnesses.map((entry, index) => {
    const label = `retiredHarnesses[${index}]`;
    exactKeys(entry, [
      'v1ScenarioId', 'assertionFile', 'assertionSha256', 'lastValidCommit',
      'supersededBy', 'reason',
    ], label);
    if (!V1_ID.test(entry.v1ScenarioId) || !V2_ID.test(entry.supersededBy) ||
        !ASSERTION_FILE.test(entry.assertionFile) || !SHA256.test(entry.assertionSha256) ||
        !COMMIT.test(entry.lastValidCommit) || typeof entry.reason !== 'string' ||
        entry.reason.length < 40 || entry.reason.length > 512) {
      throw new Error(`${label} is malformed`);
    }
    const scenario = v1Fixture.value.scenarios?.find(({ id }) => id === entry.v1ScenarioId);
    if (!scenario || scenario.assertionFile !== entry.assertionFile ||
        scenario.assertionSha256 !== entry.assertionSha256 ||
        v1Baseline.value.scenarioFingerprints?.[entry.v1ScenarioId] === undefined) {
      throw new Error(`${label} does not match immutable v1 provenance`);
    }
    assertAncestor(root, entry.lastValidCommit);
    if (sha256(gitBytes(root, entry.lastValidCommit, entry.assertionFile)) !== entry.assertionSha256 ||
        sha256(gitBytes(root, entry.lastValidCommit, predecessor.fixturePath)) !== predecessor.fixtureSha256 ||
        sha256(gitBytes(root, entry.lastValidCommit, predecessor.baselinePath)) !== predecessor.baselineSha256) {
      throw new Error(`${label} last-valid provenance is forged or wrong`);
    }
    return entry;
  });
  const retiredIds = retired.map(({ v1ScenarioId }) => v1ScenarioId);
  if (new Set(retiredIds).size !== retiredIds.length ||
      JSON.stringify(retiredIds) !== JSON.stringify([...retiredIds].sort())) {
    throw new Error('retiredHarnesses must be unique and sorted by v1ScenarioId');
  }
  for (const [v1ScenarioId, supersededBy] of REQUIRED_SUPERSESSIONS) {
    const entry = retired.find((candidate) => candidate.v1ScenarioId === v1ScenarioId);
    if (!entry || entry.supersededBy !== supersededBy ||
        entry.lastValidCommit !== MIGRATION_BASE_COMMIT) {
      throw new Error(`required v1 retirement provenance was deleted or rewritten: ${v1ScenarioId}`);
    }
  }

  if (!Array.isArray(value.successorReservations) || value.successorReservations.length === 0) {
    throw new Error('successorReservations must be a non-empty array');
  }
  const reservations = value.successorReservations.map((entry, index) => {
    const label = `successorReservations[${index}]`;
    exactKeys(entry, [
      'id', 'supersedes', 'runtimeEntryPath', 'adapter', 'criticalShape', 'action',
      'origin', 'provenance', 'failureMode', 'expectedDisposition',
      'expectedConfirmation', 'assertionFile', 'testName', 'reservedAssertionSha256',
      'requiredMockExports',
    ], label);
    if (!V2_ID.test(entry.id) || !V1_ID.test(entry.supersedes) ||
        !ASSERTION_FILE.test(entry.assertionFile) || !SHA256.test(entry.reservedAssertionSha256) ||
        typeof entry.testName !== 'string' || !entry.testName.startsWith(`${entry.id} `) ||
        typeof entry.runtimeEntryPath !== 'string' || typeof entry.adapter !== 'string' ||
        typeof entry.criticalShape !== 'string' || typeof entry.provenance !== 'string' ||
        typeof entry.failureMode !== 'string' || typeof entry.expectedDisposition !== 'string' ||
        typeof entry.expectedConfirmation !== 'string') {
      throw new Error(`${label} is malformed`);
    }
    object(entry.action, `${label}.action`);
    object(entry.origin, `${label}.origin`);
    sortedUnique(entry.requiredMockExports, `${label}.requiredMockExports`);
    let source;
    try {
      source = readStableRegularFile(root, resolve(root, entry.assertionFile), {
        maxBytes: MAX_ASSERTION_BYTES,
      }).bytes;
    } catch (error) {
      throw new Error(`${label} assertion could not be read safely: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const isActivated = Array.isArray(value.activations) &&
      value.activations.some((activation) => activation?.id === entry.id);
    if (!isActivated && sha256(source) !== entry.reservedAssertionSha256) {
      throw new Error(`${label} reserved assertion hash does not match its source`);
    }
    const text = source.toString('utf8');
    if ((!isActivated && !text.includes(`it.skip('${entry.testName}'`)) ||
        entry.requiredMockExports.some((mock) =>
          mock.split('.').some((segment) => !text.includes(segment)))) {
      throw new Error(`${label} source does not declare its reserved execution contract`);
    }
    return entry;
  });
  const reservationIds = reservations.map(({ id }) => id);
  if (new Set(reservationIds).size !== reservationIds.length ||
      JSON.stringify(reservationIds) !== JSON.stringify([...reservationIds].sort())) {
    throw new Error('successorReservations must be unique and sorted by id');
  }
  const retiredBySuccessor = new Map(retired.map((entry) => [entry.supersededBy, entry]));
  for (const reservation of reservations) {
    if (retiredBySuccessor.get(reservation.id)?.v1ScenarioId !== reservation.supersedes) {
      throw new Error(`successor ${reservation.id} has wrong supersession provenance`);
    }
  }
  if (retired.length !== reservations.length) {
    throw new Error('every retired v1 harness must have exactly one reserved v2 successor');
  }

  if (!Array.isArray(value.activations)) throw new Error('activations must be an array');
  const activations = value.activations.map((entry, index) => {
    const label = `activations[${index}]`;
    exactKeys(entry, ['id', 'assertionSha256', 'activatedAtCommit'], label);
    const reservation = reservations.find(({ id }) => id === entry.id);
    if (!reservation || !SHA256.test(entry.assertionSha256) || !COMMIT.test(entry.activatedAtCommit)) {
      throw new Error(`${label} is malformed or has no reservation`);
    }
    assertAncestor(root, entry.activatedAtCommit);
    if (sha256(gitBytes(root, entry.activatedAtCommit, reservation.assertionFile)) !==
        entry.assertionSha256) {
      throw new Error(`${label} activation provenance is forged or wrong`);
    }
    let live;
    try {
      live = readStableRegularFile(root, resolve(root, reservation.assertionFile), {
        maxBytes: MAX_ASSERTION_BYTES,
      }).bytes;
    } catch (error) {
      throw new Error(`${label} active assertion could not be read safely: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const liveText = live.toString('utf8');
    if (sha256(live) !== entry.assertionSha256 ||
        !liveText.includes(`it('${reservation.testName}'`) ||
        liveText.includes(`it.skip('${reservation.testName}'`)) {
      throw new Error(`${label} does not bind an active current assertion`);
    }
    return entry;
  });
  const activationIds = activations.map(({ id }) => id);
  if (new Set(activationIds).size !== activationIds.length ||
      JSON.stringify(activationIds) !== JSON.stringify([...activationIds].sort())) {
    throw new Error('activations must be unique and sorted by id');
  }
  sortedUnique(value.limitations, 'limitations');
  return { bytes, value, predecessor, retired, reservations, activations };
}

export function buildAdversarialV2MigrationBaseline({
  root = DEFAULT_ROOT,
  fixturePath = V2_MIGRATION_PATH,
} = {}) {
  const parsed = parseMigration(root, fixturePath);
  return {
    schemaVersion: '2.0.0',
    evidenceClass: 'source_checkout_migration',
    fixturePath,
    fixtureSha256: sha256(parsed.bytes),
    predecessor: parsed.predecessor,
    retiredHarnessFingerprints: Object.fromEntries(parsed.retired.map((entry) => [
      entry.v1ScenarioId, fingerprint(entry),
    ])),
    successorReservationFingerprints: Object.fromEntries(parsed.reservations.map((entry) => [
      entry.id, fingerprint(entry),
    ])),
    activationFingerprints: Object.fromEntries(parsed.activations.map((entry) => [
      entry.id, fingerprint(entry),
    ])),
    limitations: parsed.value.limitations,
  };
}

function assertFingerprintMap(current, expected, label) {
  exactKeys(current, Object.keys(expected), label);
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error(`${label} does not match the v2 migration fixture`);
  }
}

function trustedBaselineFromCommit(root, commit) {
  if (!COMMIT.test(commit)) throw new Error('trusted v2 commit must be a full lowercase commit SHA');
  assertAncestor(root, commit);
  const fixtureBytes = gitBytes(root, commit, V2_MIGRATION_PATH);
  const baseline = parseJsonBytes(
    gitBytes(root, commit, V2_BASELINE_PATH),
    'trusted v2 migration baseline',
  );
  const fixture = parseJsonBytes(fixtureBytes, 'trusted v2 migration fixture');
  exactKeys(baseline, [
    'schemaVersion', 'evidenceClass', 'fixturePath', 'fixtureSha256', 'predecessor',
    'retiredHarnessFingerprints', 'successorReservationFingerprints',
    'activationFingerprints', 'limitations',
  ], 'trusted v2 migration baseline');
  if (baseline.schemaVersion !== '2.0.0' ||
      baseline.evidenceClass !== 'source_checkout_migration' ||
      baseline.fixturePath !== V2_MIGRATION_PATH ||
      baseline.fixtureSha256 !== sha256(fixtureBytes)) {
    throw new Error('trusted v2 migration baseline identity is invalid');
  }
  const rails = [
    ['retiredHarnesses', 'v1ScenarioId', 'retiredHarnessFingerprints'],
    ['successorReservations', 'id', 'successorReservationFingerprints'],
    ['activations', 'id', 'activationFingerprints'],
  ];
  for (const [fixtureField, idField, baselineField] of rails) {
    if (!Array.isArray(fixture[fixtureField])) {
      throw new Error(`trusted v2 migration fixture ${fixtureField} is invalid`);
    }
    const expected = Object.fromEntries(fixture[fixtureField].map((entry) => {
      object(entry, `trusted ${fixtureField} entry`);
      if (typeof entry[idField] !== 'string') {
        throw new Error(`trusted ${fixtureField} entry has no stable ID`);
      }
      return [entry[idField], fingerprint(entry)];
    }));
    assertFingerprintMap(baseline[baselineField], expected, `trusted ${baselineField}`);
  }
  if (canonicalJson(fixture.predecessor) !== canonicalJson(baseline.predecessor) ||
      canonicalJson(fixture.limitations) !== canonicalJson(baseline.limitations)) {
    throw new Error('trusted v2 migration baseline does not bind its fixture rails');
  }
  return baseline;
}

function assertAppendOnly(current, trusted) {
  for (const field of ['retiredHarnessFingerprints', 'successorReservationFingerprints']) {
    for (const [id, digest] of Object.entries(trusted[field])) {
      if (current[field][id] !== digest) {
        throw new Error(`${field} deleted or rewritten relative to trusted v2 provenance: ${id}`);
      }
    }
  }
  for (const [id, digest] of Object.entries(trusted.activationFingerprints)) {
    if (current.activationFingerprints[id] !== digest) {
      throw new Error(`activation provenance deleted or rewritten relative to trusted v2 provenance: ${id}`);
    }
  }
  if (canonicalJson(current.predecessor) !== canonicalJson(trusted.predecessor)) {
    throw new Error('immutable v1 predecessor provenance was rewritten');
  }
  if (!Array.isArray(trusted.limitations) ||
      canonicalJson(current.limitations.slice(0, trusted.limitations.length)) !==
        canonicalJson(trusted.limitations)) {
    throw new Error('migration limitations changed or shrank relative to trusted v2 provenance');
  }
}

export function verifyAdversarialV2Migration({
  root = DEFAULT_ROOT,
  fixturePath = V2_MIGRATION_PATH,
  baselinePath = V2_BASELINE_PATH,
  trustedRoot,
  trustedCommit,
  trustedFixturePath = V2_MIGRATION_PATH,
  trustedBaselinePath = V2_BASELINE_PATH,
} = {}) {
  if (trustedRoot !== undefined && trustedCommit !== undefined) {
    throw new Error('trustedRoot and trustedCommit are mutually exclusive');
  }
  const expected = buildAdversarialV2MigrationBaseline({ root, fixturePath });
  const { value: baseline } = readJson(root, baselinePath, 'v2 migration baseline');
  exactKeys(baseline, [
    'schemaVersion', 'evidenceClass', 'fixturePath', 'fixtureSha256', 'predecessor',
    'retiredHarnessFingerprints', 'successorReservationFingerprints',
    'activationFingerprints', 'limitations',
  ], 'v2 migration baseline');
  if (baseline.schemaVersion !== '2.0.0' ||
      baseline.evidenceClass !== 'source_checkout_migration' ||
      baseline.fixturePath !== fixturePath || baseline.fixtureSha256 !== expected.fixtureSha256 ||
      canonicalJson(baseline.predecessor) !== canonicalJson(expected.predecessor) ||
      canonicalJson(baseline.limitations) !== canonicalJson(expected.limitations)) {
    throw new Error('v2 migration baseline identity or limitations do not match');
  }
  assertFingerprintMap(
    baseline.retiredHarnessFingerprints,
    expected.retiredHarnessFingerprints,
    'retiredHarnessFingerprints',
  );
  assertFingerprintMap(
    baseline.successorReservationFingerprints,
    expected.successorReservationFingerprints,
    'successorReservationFingerprints',
  );
  assertFingerprintMap(
    baseline.activationFingerprints,
    expected.activationFingerprints,
    'activationFingerprints',
  );

  if (trustedRoot) {
    const trusted = verifyAdversarialV2Migration({
      root: trustedRoot,
      fixturePath: trustedFixturePath,
      baselinePath: trustedBaselinePath,
    });
    assertAppendOnly(baseline, trusted.baseline);
  } else if (trustedCommit) {
    assertAppendOnly(baseline, trustedBaselineFromCommit(root, trustedCommit));
  }
  const activeSuccessors = Object.keys(baseline.activationFingerprints).length;
  return {
    baseline,
    status: activeSuccessors === Object.keys(baseline.successorReservationFingerprints).length
      ? 'active'
      : 'reserved',
    activeSuccessors,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const root = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT;
    const trustedCommit = process.argv[3];
    const result = verifyAdversarialV2Migration({ root, trustedCommit });
    process.stdout.write(
      `v2 adversarial migration verified: ${Object.keys(result.baseline.retiredHarnessFingerprints).length} retired, ` +
      `${Object.keys(result.baseline.successorReservationFingerprints).length} reserved, ` +
      `${result.activeSuccessors} active (${result.status})\n`,
    );
  } catch (error) {
    process.stderr.write(`v2 adversarial migration verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
