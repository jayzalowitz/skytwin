#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { readStableRegularFile } from '../release-artifacts/file-integrity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DEFAULT_BASELINE = join(HERE, 'adversarial-source-checkout-baseline.json');
const DEFAULT_FIXTURE = join(REPO_ROOT, 'packages/evals/fixtures/v1/adversarial-scenarios.json');
const BASELINE_REPO_PATH = 'scripts/release-evidence/adversarial-source-checkout-baseline.json';
const FIXTURE_REPO_PATH = 'packages/evals/fixtures/v1/adversarial-scenarios.json';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 256;
const DISPOSITIONS = new Set([
  'requires_confirmation', 'blocked_before_dispatch', 'terminal_unknown',
  'dispatch_ambiguous', 'response_rejected', 'normal_policy_flow',
  'executed_once',
]);
const EXPECTED_DISPOSITIONS = new Set([...DISPOSITIONS].filter((value) => value !== 'normal_policy_flow'));
const CONFIRMATIONS = new Set(['single', 'dual']);
const SEVERITIES = new Set(['none', 'destructive', 'extreme']);
const PROVENANCES = new Set(['user_originated', 'trusted_context', 'untrusted_external']);
const ORIGINS = new Set(['email', 'calendar', 'file', 'web', 'mcp', 'missing', 'user']);
const SOURCE_FILE_RE = /^(?:apps|packages)\/[a-z0-9-]+\/src\/[a-z0-9_./-]+\.ts$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DISPATCH_CALLS = new Set([
  'createRoutine',
  'deleteRoutine',
  'executePrepared',
  'executePreparedStreaming',
  'executeWithRouting',
  'executeWithRoutingStreaming',
  'rollback',
]);
const INVENTORY_SCAN_ROOTS = ['apps/api/src', 'apps/worker/src'];

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function exactStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length || JSON.stringify(value) !== JSON.stringify([...value].sort())) {
    throw new Error(`${label} must contain unique lexicographically sorted IDs`);
  }
  return value;
}

function semanticVersion(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a semantic version`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`${label} must be a semantic version`);
  return match.slice(1).map((part) => BigInt(part));
}

function fixtureVersion(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must have the form v<number>`);
  const match = /^v(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`${label} must have the form v<number>`);
  return [BigInt(match[1])];
}

function assertVersionNotDowngraded(current, trusted, parser, label) {
  const currentParts = parser(current, `baseline.${label}`);
  const trustedParts = parser(trusted, `trusted baseline.${label}`);
  for (let index = 0; index < Math.max(currentParts.length, trustedParts.length); index += 1) {
    const currentPart = currentParts[index] ?? 0n;
    const trustedPart = trustedParts[index] ?? 0n;
    if (currentPart > trustedPart) return;
    if (currentPart < trustedPart) {
      throw new Error(`${label} downgraded relative to the trusted baseline`);
    }
  }
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('canonical JSON cannot encode undefined');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function filesystemPath(path) {
  return path instanceof URL ? fileURLToPath(path) : resolve(path);
}

function readStableInput(path, label, maxBytes = MAX_JSON_BYTES, root) {
  const absolutePath = filesystemPath(path);
  try {
    return readStableRegularFile(root ?? dirname(absolutePath), absolutePath, { maxBytes });
  } catch (error) {
    throw new Error(`${label} could not be read safely: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * JSON.parse keeps only the final value for a duplicate object key. Evidence
 * inputs must reject that ambiguity before schema or digest checks interpret
 * them, including pretty-printed checked-in fixtures and baselines that are not
 * required to use the report's canonical one-line encoding.
 */
function parseJsonWithoutDuplicateKeys(bytes, label) {
  const source = Buffer.isBuffer(bytes) || bytes instanceof Uint8Array
    ? decodeUtf8(bytes, label)
    : String(bytes);
  const parsed = JSON.parse(source);
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
        if (keys.has(key)) throw new Error(`${label} contains duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        skipWhitespace();
        offset += 1; // ':'; JSON.parse above already established valid syntax.
        scanValue();
        skipWhitespace();
        if (source[offset] === '}') {
          offset += 1;
          return;
        }
        offset += 1; // ','
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
        offset += 1; // ','
      }
    } else if (source[offset] === '"') {
      scanString();
    } else {
      while (offset < source.length && !/[\s,\]}]/u.test(source[offset])) offset += 1;
    }
  };

  scanValue();
  return parsed;
}

function expectedProvenance(origin) {
  if (origin.authoringTier === 'user_sent_originated' || origin.authoringTier === 'user_sent_reply') {
    return 'user_originated';
  }
  if (['inbox_personal', 'inbox_broadcast', 'inbox_newsletter', 'inbox_automated']
    .includes(origin.authoringTier)) {
    return 'untrusted_external';
  }
  if (origin.source === 'user_request' || origin.source === 'ask_twin') return 'user_originated';
  if (origin.source === 'twin_profile' || origin.source === 'preference_replay') return 'trusted_context';
  return 'untrusted_external';
}

function scenarioFingerprint(scenario) {
  return sha256(canonicalJson({
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
  }));
}

function walkTypeScriptFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!['__tests__', 'dist', 'generated'].includes(entry.name)) {
        files.push(...walkTypeScriptFiles(path));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.generated.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

function calledMethodName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  if (ts.isElementAccessExpression(node.expression) &&
      ts.isStringLiteral(node.expression.argumentExpression)) {
    return node.expression.argumentExpression.text;
  }
  return null;
}

/** Parse call expressions so comments and string literals cannot satisfy the inventory. */
export function collectDispatchCalls(sourceFile, source) {
  const parsed = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calledMethodName(node);
      if (name && DISPATCH_CALLS.has(name)) calls.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return calls;
}

function validateMappedTestBinding(scenario, index) {
  const parts = scenario.executableTestId.split('::');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(`fixture.scenarios[${index}] has a malformed executable test ID`);
  }
  const packageMatch = /^@skytwin\/([a-z0-9-]+)$/.exec(parts[0]);
  const assertionMatch = /^(apps|packages)\/([a-z0-9-]+)\/(src\/[a-z0-9_./-]+\.test\.ts)$/.exec(
    scenario.assertionFile,
  );
  if (!packageMatch || !assertionMatch || packageMatch[1] !== assertionMatch[2] ||
      parts[1] !== assertionMatch[3]) {
    throw new Error(`fixture scenario ${scenario.id} assertion file does not match executable test ID`);
  }
}

export function validateSourceInventory(sourceRoot, entries) {
  const absoluteSourceRoot = resolve(sourceRoot);
  const declared = new Map(entries.map((entry) =>
    [`${entry.sourceFile}::${entry.dispatchCall}`, entry]));
  const observed = new Map();
  for (const scanRoot of INVENTORY_SCAN_ROOTS) {
    for (const absolutePath of walkTypeScriptFiles(join(absoluteSourceRoot, scanRoot))) {
      const sourceFile = relative(absoluteSourceRoot, absolutePath).split(sep).join('/');
      const source = decodeUtf8(
        readStableInput(
          absolutePath,
          `runtime dispatch source ${sourceFile}`,
          MAX_SOURCE_BYTES,
          absoluteSourceRoot,
        ).bytes,
        `runtime dispatch source ${sourceFile}`,
      );
      for (const dispatchCall of collectDispatchCalls(sourceFile, source)) {
        const key = `${sourceFile}::${dispatchCall}`;
        observed.set(key, (observed.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, count] of observed) {
    const entry = declared.get(key);
    if (!entry) throw new Error(`runtime dispatch source is missing from sourceInventory: ${key}`);
    if (entry.occurrences !== count) throw new Error(`runtime dispatch occurrence count changed for ${key}`);
  }
  for (const key of declared.keys()) {
    if (!observed.has(key)) throw new Error(`sourceInventory entry is stale: ${key}`);
  }
}

function parseSourceInventory(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  const entries = value.map((entry, index) => {
    exactKeys(entry, ['sourceFile', 'dispatchCall', 'runtimeEntryPath', 'occurrences'], `${label}[${index}]`);
    if (typeof entry.sourceFile !== 'string' || !SOURCE_FILE_RE.test(entry.sourceFile) ||
        !DISPATCH_CALLS.has(entry.dispatchCall) ||
        typeof entry.runtimeEntryPath !== 'string' ||
        !Number.isSafeInteger(entry.occurrences) || entry.occurrences < 1) {
      throw new Error(`${label}[${index}] is malformed`);
    }
    return entry;
  });
  const keys = entries.map(({ sourceFile, dispatchCall }) => `${sourceFile}::${dispatchCall}`);
  if (new Set(keys).size !== keys.length || JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} must have unique lexicographically sorted source/call entries`);
  }
  return entries;
}

function liveGitIdentity(repoRoot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const status = spawnSync(
    'git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' },
  );
  if (head.status !== 0 || status.status !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) {
    throw new Error('could not resolve the live checkout identity');
  }
  return { commit: head.stdout.trim(), cleanTree: status.stdout === '' };
}

function gitBytes(repoRoot, args, label, maxBytes) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: null,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    maxBuffer: maxBytes + 64 * 1024,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`${label} could not be read from the trusted commit`);
  }
  if (result.stdout.length > maxBytes) throw new Error(`${label} exceeds its byte limit`);
  return result.stdout;
}

function trustedInputsFromCommit(repoRoot, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('trusted commit must be a full lowercase commit SHA');
  }
  const type = decodeUtf8(
    gitBytes(repoRoot, ['cat-file', '-t', commit], 'trusted commit', 32),
    'trusted commit type',
  ).trim();
  if (type !== 'commit') throw new Error('trusted commit does not identify a commit');

  const inventoryBytes = gitBytes(
    repoRoot,
    ['ls-tree', '-z', commit, '--', BASELINE_REPO_PATH, FIXTURE_REPO_PATH],
    'trusted evidence inventory',
    4096,
  );
  const inventory = decodeUtf8(inventoryBytes, 'trusted evidence inventory')
    .split('\0')
    .filter(Boolean);
  const paths = new Set();
  for (const entry of inventory) {
    const match = /^(\d{6}) blob [0-9a-f]{40}\t(.+)$/u.exec(entry);
    if (!match || match[1] !== '100644' ||
        ![BASELINE_REPO_PATH, FIXTURE_REPO_PATH].includes(match[2])) {
      throw new Error('trusted evidence input is not a regular checked-in blob');
    }
    paths.add(match[2]);
  }
  const hasBaseline = paths.has(BASELINE_REPO_PATH);
  const hasFixture = paths.has(FIXTURE_REPO_PATH);
  if (hasBaseline !== hasFixture) {
    throw new Error('trusted commit must contain both adversarial baseline and fixture or neither');
  }
  if (!hasBaseline) return null;
  return {
    baselineBytes: gitBytes(
      repoRoot,
      ['cat-file', 'blob', `${commit}:${BASELINE_REPO_PATH}`],
      'trusted baseline',
      MAX_JSON_BYTES,
    ),
    fixtureBytes: gitBytes(
      repoRoot,
      ['cat-file', 'blob', `${commit}:${FIXTURE_REPO_PATH}`],
      'trusted fixture',
      MAX_JSON_BYTES,
    ),
  };
}

function loadFixtureBytes(
  bytes,
  baseline,
  sourceRoot,
  verifyLiveSources = true,
  label = 'fixture',
) {
  const fixture = parseJsonWithoutDuplicateKeys(bytes, label);
  exactKeys(fixture, [
    'schemaVersion', 'fixturesVersion', 'coverageTargets', 'sourceInventory', 'scenarios',
  ], 'fixture');
  if (fixture.schemaVersion !== baseline.schemaVersion || fixture.fixturesVersion !== baseline.fixturesVersion) {
    throw new Error('fixture schema or version does not match the baseline');
  }
  const digest = sha256(bytes);
  if (digest !== baseline.fixtureSha256) throw new Error('checked-in fixture SHA-256 does not match the baseline');
  exactKeys(fixture.coverageTargets, ['runtimeEntryPaths', 'adapters', 'criticalShapes', 'origins'], 'fixture.coverageTargets');
  exactKeys(baseline.coverageTargets, ['runtimeEntryPaths', 'adapters', 'criticalShapes', 'origins'], 'baseline.coverageTargets');
  for (const key of ['runtimeEntryPaths', 'adapters', 'criticalShapes', 'origins']) {
    const fixtureTargets = exactStringArray(fixture.coverageTargets[key], `fixture.coverageTargets.${key}`);
    const baselineTargets = exactStringArray(baseline.coverageTargets[key], `baseline.coverageTargets.${key}`);
    if (JSON.stringify(fixtureTargets) !== JSON.stringify(baselineTargets)) {
      throw new Error(`fixture coverageTargets.${key} do not match the baseline`);
    }
  }
  const sourceInventory = parseSourceInventory(fixture.sourceInventory, 'fixture.sourceInventory');
  const baselineInventory = parseSourceInventory(baseline.sourceInventory, 'baseline.sourceInventory');
  if (canonicalJson(sourceInventory) !== canonicalJson(baselineInventory)) {
    throw new Error('fixture sourceInventory does not match the baseline');
  }
  for (const entry of sourceInventory) {
    if (!fixture.coverageTargets.runtimeEntryPaths.includes(entry.runtimeEntryPath)) {
      throw new Error(`sourceInventory path is outside coverageTargets: ${entry.runtimeEntryPath}`);
    }
  }
  if (verifyLiveSources) validateSourceInventory(sourceRoot, sourceInventory);
  if (!Array.isArray(fixture.scenarios) || fixture.scenarios.length === 0) {
    throw new Error('fixture.scenarios must be a non-empty array');
  }
  const scenarios = fixture.scenarios.map((scenario, index) => {
    exactKeys(scenario, [
      'id', 'runtimeEntryPath', 'adapter', 'criticalShape', 'action', 'origin', 'failureMode',
      'expectedDisposition', 'expectedConfirmation', 'evidenceMode', 'executableTestId',
      'provenance', 'assertionFile', 'assertionSha256',
    ], `fixture.scenarios[${index}]`);
    exactKeys(scenario.action, ['actionType', 'reversible', 'parameters'], `fixture.scenarios[${index}].action`);
    const originKeys = Object.keys(object(scenario.origin, `fixture.scenarios[${index}].origin`)).sort();
    if (JSON.stringify(originKeys) !== JSON.stringify(['kind', 'source']) &&
        JSON.stringify(originKeys) !== JSON.stringify(['authoringTier', 'kind', 'source'])) {
      throw new Error(`fixture.scenarios[${index}].origin has unexpected or missing fields`);
    }
    for (const field of ['id', 'runtimeEntryPath', 'adapter', 'criticalShape', 'failureMode',
      'expectedDisposition', 'expectedConfirmation', 'evidenceMode', 'executableTestId']) {
      if (typeof scenario[field] !== 'string') throw new Error(`fixture.scenarios[${index}].${field} is malformed`);
    }
    if (!['deterministic_policy', 'mapped_regression'].includes(scenario.evidenceMode) ||
        !EXPECTED_DISPOSITIONS.has(scenario.expectedDisposition) ||
        !['none', 'single', 'dual'].includes(scenario.expectedConfirmation) ||
        !ORIGINS.has(scenario.origin.kind) || !PROVENANCES.has(scenario.provenance)) {
      throw new Error(`fixture.scenarios[${index}] has unsupported evidence metadata`);
    }
    if (typeof scenario.action.actionType !== 'string' ||
        typeof scenario.action.reversible !== 'boolean' ||
        scenario.action.parameters === null || typeof scenario.action.parameters !== 'object' ||
        Array.isArray(scenario.action.parameters) || typeof scenario.origin.source !== 'string' ||
        (scenario.origin.authoringTier !== undefined && typeof scenario.origin.authoringTier !== 'string')) {
      throw new Error(`fixture.scenarios[${index}] has malformed action or origin data`);
    }
    if (scenario.provenance !== expectedProvenance(scenario.origin)) {
      throw new Error(`fixture scenario ${scenario.id} provenance does not match its origin`);
    }
    if (scenario.evidenceMode === 'mapped_regression') {
      if (typeof scenario.assertionFile !== 'string' || !SOURCE_FILE_RE.test(scenario.assertionFile) ||
          typeof scenario.assertionSha256 !== 'string' || !SHA256_RE.test(scenario.assertionSha256)) {
        throw new Error(`fixture.scenarios[${index}] has malformed assertion binding`);
      }
      validateMappedTestBinding(scenario, index);
      if (verifyLiveSources) {
        const absoluteSourceRoot = resolve(sourceRoot);
        const assertionPath = resolve(absoluteSourceRoot, scenario.assertionFile);
        if (!assertionPath.startsWith(`${absoluteSourceRoot}${sep}`) ||
            readStableInput(
              assertionPath,
              `fixture scenario ${scenario.id} assertion source`,
              MAX_SOURCE_BYTES,
              absoluteSourceRoot,
            ).sha256 !== scenario.assertionSha256) {
          throw new Error(`fixture scenario ${scenario.id} assertion source digest does not match`);
        }
      }
    } else if (scenario.assertionFile !== null || scenario.assertionSha256 !== null) {
      throw new Error(`fixture.scenarios[${index}] deterministic scenario has an assertion binding`);
    }
    const dimensions = {
      runtimeEntryPaths: scenario.runtimeEntryPath,
      adapters: scenario.adapter,
      criticalShapes: scenario.criticalShape,
      origins: scenario.origin.kind,
    };
    for (const [key, value] of Object.entries(dimensions)) {
      if (!fixture.coverageTargets[key].includes(value)) {
        throw new Error(`fixture scenario ${scenario.id} is outside coverageTargets.${key}`);
      }
    }
    return scenario;
  });
  const sortedScenarios = [...scenarios].sort((a, b) => a.id.localeCompare(b.id));
  const ids = sortedScenarios.map(({ id }) => id);
  const testIds = scenarios.map(({ executableTestId }) => executableTestId);
  if (new Set(ids).size !== ids.length || new Set(testIds).size !== testIds.length) {
    throw new Error('fixture scenario or executable test IDs are duplicated');
  }
  const assertionFiles = scenarios.flatMap(({ assertionFile }) =>
    assertionFile === null ? [] : [assertionFile]);
  if (new Set(assertionFiles).size !== assertionFiles.length) {
    throw new Error('each mapped regression must use a dedicated assertion file');
  }
  const fingerprints = Object.fromEntries(sortedScenarios.map((scenario) =>
    [scenario.id, scenarioFingerprint(scenario)]));
  exactKeys(baseline.scenarioFingerprints, ids, 'baseline.scenarioFingerprints');
  if (canonicalJson(fingerprints) !== canonicalJson(baseline.scenarioFingerprints)) {
    throw new Error('baseline scenario fingerprints do not match the fixture semantics');
  }
  return { fixture, scenarios: sortedScenarios, ids, digest, fingerprints };
}

function loadFixture(
  fixturePath,
  baseline,
  sourceRoot,
  verifyLiveSources = true,
  label = 'fixture',
) {
  return loadFixtureBytes(
    readStableInput(fixturePath, label).bytes,
    baseline,
    sourceRoot,
    verifyLiveSources,
    label,
  );
}

function expectedDimension(scenarios, targets, field) {
  const values = new Set(scenarios.map((scenario) =>
    field === 'origin' ? scenario.origin.kind : scenario[field]));
  return { covered: targets.filter((target) => values.has(target)).length, total: targets.length };
}

export function verifyAdversarialEvidence(reportPath, baselinePath = DEFAULT_BASELINE, options = {}) {
  const reportBytes = readStableInput(reportPath, 'report').bytes;
  const report = parseJsonWithoutDuplicateKeys(reportBytes, 'report');
  if (decodeUtf8(reportBytes, 'report') !== `${canonicalJson(report)}\n`) {
    throw new Error('report bytes are not canonical JSON (duplicate keys are forbidden)');
  }
  const baselineBytes = readStableInput(baselinePath, 'baseline').bytes;
  const baseline = parseJsonWithoutDuplicateKeys(baselineBytes, 'baseline');
  exactKeys(baseline, [
    'schemaVersion', 'evidenceClass', 'fixturesVersion', 'fixtureSha256', 'exactIds',
    'coverageTargets', 'sourceInventory', 'scenarioFingerprints', 'mitigations', 'limitations',
  ], 'baseline');
  if (!/^[0-9a-f]{64}$/.test(baseline.fixtureSha256)) throw new Error('baseline fixture SHA-256 is malformed');
  semanticVersion(baseline.schemaVersion, 'baseline.schemaVersion');
  fixtureVersion(baseline.fixturesVersion, 'baseline.fixturesVersion');
  const baselineIds = exactStringArray(baseline.exactIds, 'baseline.exactIds');
  let trustedInputs = null;
  if (options.trustedCommit !== undefined) {
    if (options.trustedBaselinePath !== undefined || options.trustedFixturePath !== undefined) {
      throw new Error('trusted commit cannot be combined with trusted filesystem paths');
    }
    trustedInputs = trustedInputsFromCommit(
      options.repoRoot ?? REPO_ROOT,
      options.trustedCommit,
    );
  } else if (options.trustedBaselinePath !== undefined) {
    if (options.trustedFixturePath === undefined) {
      throw new Error('trusted fixture is required with a trusted baseline');
    }
    trustedInputs = {
      baselineBytes: readStableInput(options.trustedBaselinePath, 'trusted baseline').bytes,
      fixtureBytes: readStableInput(options.trustedFixturePath, 'trusted fixture').bytes,
    };
  }
  if (trustedInputs !== null) {
    const trusted = parseJsonWithoutDuplicateKeys(trustedInputs.baselineBytes, 'trusted baseline');
    exactKeys(trusted, [
      'schemaVersion', 'evidenceClass', 'fixturesVersion', 'fixtureSha256', 'exactIds',
      'coverageTargets', 'sourceInventory', 'scenarioFingerprints', 'mitigations', 'limitations',
    ], 'trusted baseline');
    if (trusted.evidenceClass !== 'source_checkout') {
      throw new Error('trusted baseline has an unsupported evidence class');
    }
    if (!/^[0-9a-f]{64}$/.test(trusted.fixtureSha256)) {
      throw new Error('trusted baseline fixture SHA-256 is malformed');
    }
    assertVersionNotDowngraded(
      baseline.schemaVersion, trusted.schemaVersion, semanticVersion, 'schemaVersion',
    );
    assertVersionNotDowngraded(
      baseline.fixturesVersion, trusted.fixturesVersion, fixtureVersion, 'fixturesVersion',
    );
    const trustedIds = exactStringArray(trusted.exactIds, 'trusted baseline.exactIds');
    const currentIds = new Set(baselineIds);
    const removedIds = trustedIds.filter((id) => !currentIds.has(id));
    if (removedIds.length > 0) {
      throw new Error(
        `exactIds shrank relative to the trusted baseline: ${removedIds.join(', ')}`,
      );
    }
    const trustedFixtureBytes = trustedInputs.fixtureBytes;
    if (sha256(trustedFixtureBytes) !== trusted.fixtureSha256) {
      throw new Error('trusted fixture SHA-256 does not match the trusted baseline');
    }
    loadFixtureBytes(
      trustedFixtureBytes,
      trusted,
      options.sourceRoot ?? REPO_ROOT,
      false,
      'trusted fixture',
    );
    exactKeys(trusted.scenarioFingerprints, trustedIds, 'trusted baseline.scenarioFingerprints');
    for (const id of trustedIds) {
      if (baseline.scenarioFingerprints[id] !== trusted.scenarioFingerprints[id]) {
        throw new Error(`scenario semantic fingerprint changed relative to the trusted baseline: ${id}`);
      }
    }
    exactKeys(trusted.coverageTargets, [
      'runtimeEntryPaths', 'adapters', 'criticalShapes', 'origins',
    ], 'trusted baseline.coverageTargets');
    exactKeys(baseline.coverageTargets, [
      'runtimeEntryPaths', 'adapters', 'criticalShapes', 'origins',
    ], 'baseline.coverageTargets');
    for (const key of ['runtimeEntryPaths', 'adapters', 'criticalShapes', 'origins']) {
      const trustedTargets = exactStringArray(
        trusted.coverageTargets[key], `trusted baseline.coverageTargets.${key}`,
      );
      const currentTargets = new Set(exactStringArray(
        baseline.coverageTargets[key], `baseline.coverageTargets.${key}`,
      ));
      const removed = trustedTargets.filter((target) => !currentTargets.has(target));
      if (removed.length > 0) {
        throw new Error(
          `coverageTargets.${key} shrank relative to the trusted baseline: ${removed.join(', ')}`,
        );
      }
    }
    const trustedInventory = parseSourceInventory(trusted.sourceInventory, 'trusted baseline.sourceInventory');
    const currentInventory = parseSourceInventory(baseline.sourceInventory, 'baseline.sourceInventory');
    const currentInventoryPaths = new Set(currentInventory.map(({ runtimeEntryPath }) => runtimeEntryPath));
    const removedInventoryPaths = [...new Set(trustedInventory.map(({ runtimeEntryPath }) => runtimeEntryPath))]
      .filter((runtimeEntryPath) => !currentInventoryPaths.has(runtimeEntryPath));
    if (removedInventoryPaths.length > 0) {
      throw new Error(
        `sourceInventory semantic runtime paths shrank relative to the trusted baseline: ${removedInventoryPaths.join(', ')}`,
      );
    }
    for (const rail of ['mitigations', 'limitations']) {
      if (!Array.isArray(trusted[rail]) ||
          canonicalJson(baseline[rail].slice(0, trusted[rail].length)) !== canonicalJson(trusted[rail])) {
        throw new Error(`${rail} changed or shrank relative to the trusted baseline`);
      }
    }
  }
  const { fixture, scenarios, ids: fixtureIds, digest: fixtureDigest } =
    loadFixture(
      options.fixturePath ?? DEFAULT_FIXTURE,
      baseline,
      options.sourceRoot ?? REPO_ROOT,
    );

  exactKeys(report, [
    'schemaVersion', 'evidenceClass', 'releaseSubject', 'attestation', 'source', 'fixtures',
    'exactIds', 'environment', 'determinism', 'structuralCoverage', 'testSummary',
    'results', 'failures', 'mitigations',
    'limitations', 'developmentStatus', 'allowIncomplete', 'releaseReadiness', 'zeroBypassesClaimed',
  ], 'report');
  if (report.schemaVersion !== baseline.schemaVersion || report.evidenceClass !== 'source_checkout' ||
      baseline.evidenceClass !== 'source_checkout') {
    throw new Error('schema or evidence class does not match the source-checkout baseline');
  }
  if (report.releaseSubject !== null || report.attestation !== null || report.releaseReadiness !== null ||
      report.zeroBypassesClaimed !== false || report.allowIncomplete !== true ||
      report.developmentStatus !== 'incomplete') {
    throw new Error('source-checkout evidence contains a forbidden or malformed release claim');
  }
  exactKeys(report.source, ['commit', 'ref', 'cleanTree'], 'report.source');
  if (!/^[0-9a-f]{40}$/.test(report.source.commit) || typeof report.source.ref !== 'string' ||
      typeof report.source.cleanTree !== 'boolean') throw new Error('source identity is malformed');
  const live = liveGitIdentity(options.repoRoot ?? REPO_ROOT);
  const expectedCommit = options.expectedCommit ?? live.commit;
  if (report.source.commit !== expectedCommit || report.source.commit !== live.commit || expectedCommit !== live.commit) {
    throw new Error('source commit does not match the expected and live checkout');
  }
  if (report.source.cleanTree !== live.cleanTree) {
    throw new Error('reported clean-tree state does not match the live checkout');
  }
  if (options.requireClean === true && (!report.source.cleanTree || !live.cleanTree)) {
    throw new Error('source checkout must be clean for uploaded CI evidence');
  }
  exactKeys(report.fixtures, ['version', 'sha256'], 'report.fixtures');
  if (report.fixtures.version !== baseline.fixturesVersion || report.fixtures.sha256 !== fixtureDigest) {
    throw new Error('report fixture identity does not match the checked-in fixture');
  }
  exactKeys(report.environment, ['node', 'platform', 'arch', 'ci'], 'report.environment');
  if (typeof report.environment.node !== 'string' || typeof report.environment.platform !== 'string' ||
      typeof report.environment.arch !== 'string' || typeof report.environment.ci !== 'boolean') {
    throw new Error('environment identity is malformed');
  }
  exactKeys(report.determinism, ['networkPolicy', 'randomSeed', 'clockPolicy', 'scenarioOrder'], 'report.determinism');
  if (report.determinism.networkPolicy !== 'not_enforced' || report.determinism.randomSeed !== null ||
      report.determinism.clockPolicy !== 'not_controlled' || report.determinism.scenarioOrder !== 'lexicographic_id') {
    throw new Error('determinism declaration is unsupported');
  }

  const reportIds = exactStringArray(report.exactIds, 'report.exactIds');
  if (JSON.stringify(fixtureIds) !== JSON.stringify(baselineIds) ||
      JSON.stringify(reportIds) !== JSON.stringify(baselineIds)) {
    throw new Error('fixture or report exact IDs do not match the baseline');
  }
  if (!Array.isArray(report.results)) throw new Error('report.results must be an array');
  const resultIds = report.results.map((result, index) => {
    exactKeys(result, [
      'id', 'runtimeEntryPath', 'adapter', 'criticalShape', 'origin', 'failureMode', 'status',
      'evidenceMode', 'executableTestId', 'executableTestStatus', 'expectedDisposition',
      'expectedConfirmation', 'assertionSha256', 'actualDisposition', 'actualConfirmation',
      'actualSeverity', 'reason',
    ], `report.results[${index}]`);
    const scenario = scenarios[index];
    if (!scenario || result.id !== scenario.id) throw new Error('result IDs do not exactly match fixture order');
    const immutable = {
      runtimeEntryPath: scenario.runtimeEntryPath,
      adapter: scenario.adapter,
      criticalShape: scenario.criticalShape,
      origin: scenario.origin.kind,
      failureMode: scenario.failureMode,
      evidenceMode: scenario.evidenceMode,
      executableTestId: scenario.executableTestId,
      assertionSha256: scenario.assertionSha256,
      expectedDisposition: scenario.expectedDisposition,
      expectedConfirmation: scenario.expectedConfirmation,
    };
    for (const [key, value] of Object.entries(immutable)) {
      if (result[key] !== value) throw new Error(`result ${result.id} ${key} does not match the fixture`);
    }
    if (!['passed', 'failed', 'uncovered'].includes(result.status) ||
        !['passed', 'failed'].includes(result.executableTestStatus) || typeof result.reason !== 'string') {
      throw new Error(`report.results[${index}] has invalid status or reason`);
    }
    if ((result.actualDisposition !== null && !DISPOSITIONS.has(result.actualDisposition)) ||
        (result.actualConfirmation !== null && !CONFIRMATIONS.has(result.actualConfirmation)) ||
        (result.actualSeverity !== null && !SEVERITIES.has(result.actualSeverity))) {
      throw new Error(`report.results[${index}] has an invalid actual value`);
    }
    if (result.status === 'uncovered') throw new Error(`mapped exact test result ${result.id} cannot be uncovered`);
    if (result.executableTestStatus === 'failed') {
      if (result.status !== 'failed' || result.actualDisposition !== null ||
          result.actualConfirmation !== null || result.actualSeverity !== null ||
          result.reason !== 'mapped executable test failed') {
        throw new Error(`report.results[${index}] has inconsistent failed-test semantics`);
      }
    } else if (result.evidenceMode === 'mapped_regression') {
      if (result.actualDisposition !== null || result.actualConfirmation !== null ||
          result.actualSeverity !== null || result.status !== 'passed' ||
          result.reason !==
            'exact mapped regression assertion passed with integrity-bound source') {
        throw new Error(`report.results[${index}] has inconsistent mapped-regression semantics`);
      }
    } else {
      if (result.actualDisposition === null || result.actualSeverity === null) {
        throw new Error(`report.results[${index}] has incomplete deterministic-policy actuals`);
      }
      const expectedConfirmation = result.expectedConfirmation === 'none' ? null : result.expectedConfirmation;
      const matches = result.actualDisposition === result.expectedDisposition &&
        result.actualConfirmation === expectedConfirmation;
      if ((matches && (result.status !== 'passed' ||
          result.reason !== 'deterministic policy primitive matched the catalog expectation')) ||
          (!matches && (result.status !== 'failed' ||
          result.reason !== 'deterministic policy primitive did not match the catalog expectation'))) {
        throw new Error(`report.results[${index}] has inconsistent deterministic-policy semantics`);
      }
    }
    return result.id;
  });
  if (JSON.stringify(resultIds) !== JSON.stringify(reportIds)) throw new Error('result IDs do not match report exact IDs');
  const counts = report.results.reduce((acc, result) => {
    acc[result.status] += 1;
    return acc;
  }, { passed: 0, failed: 0, uncovered: 0 });
  exactKeys(report.structuralCoverage, [
    'scenarios', 'runtimeEntryPaths', 'adapters', 'criticalShapes', 'origins',
  ], 'report.structuralCoverage');
  const expectedStructuralCoverage = {
    scenarios: { covered: scenarios.length, total: scenarios.length },
    runtimeEntryPaths: expectedDimension(scenarios, fixture.coverageTargets.runtimeEntryPaths, 'runtimeEntryPath'),
    adapters: expectedDimension(scenarios, fixture.coverageTargets.adapters, 'adapter'),
    criticalShapes: expectedDimension(scenarios, fixture.coverageTargets.criticalShapes, 'criticalShape'),
    origins: expectedDimension(scenarios, fixture.coverageTargets.origins, 'origin'),
  };
  for (const key of Object.keys(expectedStructuralCoverage)) {
    exactKeys(report.structuralCoverage[key], ['covered', 'total'], `report.structuralCoverage.${key}`);
    if (report.structuralCoverage[key].covered !== expectedStructuralCoverage[key].covered ||
        report.structuralCoverage[key].total !== expectedStructuralCoverage[key].total) {
      throw new Error(`report.structuralCoverage.${key} does not match fixture-derived coverage`);
    }
  }
  exactKeys(report.testSummary, ['passed', 'failed', 'uncovered'], 'report.testSummary');
  if (report.testSummary.passed !== counts.passed || report.testSummary.failed !== counts.failed ||
      report.testSummary.uncovered !== counts.uncovered) {
    throw new Error('test summary counts do not match results');
  }

  if (!Array.isArray(report.failures) || !Array.isArray(report.mitigations) ||
      !Array.isArray(report.limitations) || report.mitigations.some((value) => typeof value !== 'string') ||
      report.limitations.some((value) => typeof value !== 'string')) {
    throw new Error('failures, mitigations, or limitations are malformed');
  }
  if (JSON.stringify(report.mitigations) !== JSON.stringify(baseline.mitigations) ||
      JSON.stringify(report.limitations) !== JSON.stringify(baseline.limitations)) {
    throw new Error('mitigations or limitations do not match the immutable baseline');
  }
  const expectedFailures = report.results
    .filter(({ status }) => status === 'failed')
    .map(({ id, reason }) => ({ id, reason }));
  report.failures.forEach((failure, index) => {
    exactKeys(failure, ['id', 'reason'], `report.failures[${index}]`);
    if (typeof failure.id !== 'string' || typeof failure.reason !== 'string') {
      throw new Error(`report.failures[${index}] is malformed`);
    }
  });
  if (JSON.stringify(report.failures) !== JSON.stringify(expectedFailures)) {
    throw new Error('ordered failure records do not exactly match failed results');
  }
  const expectedDigest = sha256(reportBytes);
  const expectedChecksum = `${expectedDigest}  ${basename(reportPath)}\n`;
  const checksumBytes = readStableInput(
    `${filesystemPath(reportPath)}.sha256`,
    'report checksum',
    MAX_CHECKSUM_BYTES,
  ).bytes;
  if (!checksumBytes.equals(Buffer.from(expectedChecksum, 'utf8'))) {
    throw new Error('companion SHA-256 does not match the report bytes');
  }
  return { scenarioCount: reportIds.length, uncovered: counts.uncovered, digest: expectedDigest };
}

function parseArgs(args) {
  const reportPath = args.shift();
  if (!reportPath) throw new Error('usage: verify-adversarial-evidence <report.json> [--baseline path] [--trusted-commit sha] [--fixture path] [--expected-commit sha] [--require-clean]');
  let baselinePath = DEFAULT_BASELINE;
  const options = {};
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--require-clean') { options.requireClean = true; continue; }
    const value = args.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--baseline') baselinePath = resolve(value);
    else if (flag === '--trusted-commit') options.trustedCommit = value;
    else if (flag === '--fixture') options.fixturePath = resolve(value);
    else if (flag === '--expected-commit') options.expectedCommit = value;
    else throw new Error(`unsupported option ${flag}`);
  }
  if (options.expectedCommit !== undefined && !/^[0-9a-f]{40}$/.test(options.expectedCommit)) {
    throw new Error('--expected-commit must be a full lowercase commit SHA');
  }
  if (options.trustedCommit !== undefined && !/^[0-9a-f]{40}$/.test(options.trustedCommit)) {
    throw new Error('--trusted-commit must be a full lowercase commit SHA');
  }
  return { reportPath: resolve(reportPath), baselinePath, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const result = verifyAdversarialEvidence(parsed.reportPath, parsed.baselinePath, parsed.options);
    process.stdout.write(`verified source-checkout adversarial evidence: ${result.scenarioCount} scenarios, ${result.uncovered} uncovered, sha256 ${result.digest}\n`);
  } catch (error) {
    process.stderr.write(`adversarial evidence verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
