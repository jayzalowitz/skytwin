import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  classifyActionSeverity,
  evaluateInjectionGuard,
  resolveActionProvenance,
} from '@skytwin/shared-types';
import type { ActionProvenance } from '@skytwin/shared-types';
import type { ExecutableTestResult } from './adversarial-test-executor.js';

export const ADVERSARIAL_SCHEMA_VERSION = '1.0.0';
export const ADVERSARIAL_FIXTURES_VERSION = 'v1';
export const ADVERSARIAL_FIXTURE_URL = new URL(
  '../fixtures/v1/adversarial-scenarios.json',
  import.meta.url,
);

export type AdversarialAdapter = 'none' | 'direct' | 'ironclaw' | 'openclaw';
export type CriticalShape =
  | 'send' | 'delete' | 'purchase' | 'credential' | 'account'
  | 'shell' | 'filesystem' | 'database';
export type OriginKind = 'email' | 'calendar' | 'file' | 'web' | 'mcp' | 'missing' | 'user';
export type ExpectedDisposition =
  | 'requires_confirmation' | 'blocked_before_dispatch' | 'terminal_unknown'
  | 'dispatch_ambiguous' | 'response_rejected' | 'executed_once';
export type ConfirmationLevel = 'none' | 'single' | 'dual';
export type EvidenceMode = 'deterministic_policy' | 'mapped_regression';
export type AdversarialDispatchCall =
  | 'createRoutine'
  | 'deleteRoutine'
  | 'executePrepared'
  | 'executePreparedStreaming'
  | 'executeWithRouting'
  | 'executeWithRoutingStreaming'
  | 'rollback';

export interface AdversarialCoverageTargets {
  runtimeEntryPaths: string[];
  adapters: AdversarialAdapter[];
  criticalShapes: CriticalShape[];
  origins: OriginKind[];
}

export interface AdversarialScenario {
  id: string;
  runtimeEntryPath: string;
  adapter: AdversarialAdapter;
  criticalShape: CriticalShape;
  action: {
    actionType: string;
    reversible: boolean;
    parameters: Record<string, unknown>;
  };
  origin: {
    kind: OriginKind;
    source: string;
    authoringTier?: string;
  };
  provenance: ActionProvenance;
  failureMode: string;
  expectedDisposition: ExpectedDisposition;
  expectedConfirmation: ConfirmationLevel;
  evidenceMode: EvidenceMode;
  executableTestId: string;
  assertionFile: string | null;
  assertionSha256: string | null;
}

export interface AdversarialSourceInventoryEntry {
  sourceFile: string;
  dispatchCall: AdversarialDispatchCall;
  runtimeEntryPath: string;
  occurrences: number;
}

export interface AdversarialCatalog {
  schemaVersion: typeof ADVERSARIAL_SCHEMA_VERSION;
  fixturesVersion: typeof ADVERSARIAL_FIXTURES_VERSION;
  coverageTargets: AdversarialCoverageTargets;
  sourceInventory: AdversarialSourceInventoryEntry[];
  scenarios: AdversarialScenario[];
}

export interface AdversarialResult {
  id: string;
  runtimeEntryPath: string;
  adapter: AdversarialAdapter;
  criticalShape: CriticalShape;
  origin: OriginKind;
  failureMode: string;
  status: 'passed' | 'failed' | 'uncovered';
  evidenceMode: EvidenceMode;
  executableTestId: string;
  assertionSha256: string | null;
  executableTestStatus: 'passed' | 'failed';
  expectedDisposition: ExpectedDisposition;
  expectedConfirmation: ConfirmationLevel;
  actualDisposition: ExpectedDisposition | 'normal_policy_flow' | null;
  actualConfirmation: 'single' | 'dual' | null;
  actualSeverity: 'none' | 'destructive' | 'extreme' | null;
  reason: string;
}

interface CoverageDenominator {
  covered: number;
  total: number;
}

export interface AdversarialEvidenceReport {
  schemaVersion: typeof ADVERSARIAL_SCHEMA_VERSION;
  evidenceClass: 'source_checkout';
  releaseSubject: null;
  attestation: null;
  source: { commit: string; ref: string; cleanTree: boolean };
  fixtures: { version: typeof ADVERSARIAL_FIXTURES_VERSION; sha256: string };
  exactIds: string[];
  environment: { node: string; platform: NodeJS.Platform; arch: string; ci: boolean };
  determinism: {
    networkPolicy: 'not_enforced';
    randomSeed: null;
    clockPolicy: 'not_controlled';
    scenarioOrder: 'lexicographic_id';
  };
  structuralCoverage: {
    scenarios: CoverageDenominator;
    runtimeEntryPaths: CoverageDenominator;
    adapters: CoverageDenominator;
    criticalShapes: CoverageDenominator;
    origins: CoverageDenominator;
  };
  testSummary: { passed: number; failed: number; uncovered: number };
  results: AdversarialResult[];
  failures: Array<{ id: string; reason: string }>;
  mitigations: string[];
  limitations: string[];
  developmentStatus: 'incomplete';
  allowIncomplete: true;
  releaseReadiness: null;
  zeroBypassesClaimed: false;
}

const ADAPTERS = new Set<AdversarialAdapter>(['none', 'direct', 'ironclaw', 'openclaw']);
const SHAPES = new Set<CriticalShape>([
  'send', 'delete', 'purchase', 'credential', 'account', 'shell', 'filesystem', 'database',
]);
const ORIGINS = new Set<OriginKind>(['email', 'calendar', 'file', 'web', 'mcp', 'missing', 'user']);
const PROVENANCES = new Set<ActionProvenance>([
  'user_originated', 'trusted_context', 'untrusted_external',
]);
const DISPOSITIONS = new Set<ExpectedDisposition>([
  'requires_confirmation', 'blocked_before_dispatch', 'terminal_unknown',
  'dispatch_ambiguous', 'response_rejected',
  'executed_once',
]);
const MODES = new Set<EvidenceMode>(['deterministic_policy', 'mapped_regression']);
const ID_RE = /^adv-v1-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SOURCE_FILE_RE = /^(?:apps|packages)\/[a-z0-9-]+\/src\/[a-z0-9_./-]+\.ts$/;
const DISPATCH_CALLS = new Set<AdversarialDispatchCall>([
  'createRoutine',
  'deleteRoutine',
  'executePrepared',
  'executePreparedStreaming',
  'executeWithRouting',
  'executeWithRoutingStreaming',
  'rollback',
]);
const INVENTORY_SCAN_ROOTS = ['apps/api/src', 'apps/worker/src'] as const;
export const ADVERSARIAL_MITIGATIONS = [
  'untrusted or missing provenance is evaluated by the injection guard',
  'destructive shapes require explicit confirmation',
  'extreme shapes require dual confirmation',
  'retained scenario semantics and mapped assertion source digests are append-only after bootstrap',
  'recognized API and worker dispatch terminal method names are checked against a source inventory',
] as const;
export const ADVERSARIAL_LIMITATIONS = [
  'This evidence describes a source checkout, not a packaged release artifact.',
  'Release subject identity and attestation are intentionally absent.',
  'This development foundation does not yet enumerate every API, worker, assistant, memory, and routine entry path required for a release gate.',
  'The v1 baseline has no pre-introduction trusted history; append-only comparison begins with the first main commit containing both evidence inputs.',
  'Source inventory scanning recognizes a fixed set of terminal method names in API and worker TypeScript; aliases, computed or dynamic dispatch, new method names, and direct provider effects are outside this check.',
  'Network access is not sandbox-enforced for mapped Vitest processes; tests are expected to use their declared mocks.',
  'The mapped Vitest process clock is not controlled by this evidence runner.',
  'Mapped Vitest results prove only that an exact assertion passed or failed; semantic actual fields remain null until a structured runtime observation channel exists.',
  'Mapped assertion integrity binds a dedicated one-scenario test file, including its imports, setup, helpers, and assertions; changing that harness requires a new scenario ID instead of rewriting retained evidence.',
  'The companion checksum detects accidental report corruption but is not an external trust root.',
  'Structural coverage is independent of test outcomes; passing mapped checks does not establish release readiness or prove zero bypasses.',
  'The verified report and checksum remain mutable filesystem paths; a same-user process could replace them after verification and before artifact upload.',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${path} has unexpected or missing fields`);
  }
}

function stringField(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function parseUniqueStrings<T extends string>(
  value: unknown,
  path: string,
  allowed?: ReadonlySet<T>,
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path} must be a non-empty string array`);
  }
  const entries = value as T[];
  if (new Set(entries).size !== entries.length ||
      JSON.stringify(entries) !== JSON.stringify([...entries].sort())) {
    throw new Error(`${path} must be unique and lexicographically sorted`);
  }
  if (allowed && entries.some((entry) => !allowed.has(entry))) {
    throw new Error(`${path} contains an unsupported value`);
  }
  return entries;
}

function parseScenario(value: unknown, index: number): AdversarialScenario {
  const path = `scenarios[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  exactKeys(value, [
    'id', 'runtimeEntryPath', 'adapter', 'criticalShape', 'action', 'origin', 'failureMode',
    'provenance', 'expectedDisposition', 'expectedConfirmation', 'evidenceMode', 'executableTestId',
    'assertionFile', 'assertionSha256',
  ], path);
  const action = value['action'];
  const origin = value['origin'];
  if (!isPlainObject(action)) throw new Error(`${path}.action must be an object`);
  if (!isPlainObject(origin)) throw new Error(`${path}.origin must be an object`);
  exactKeys(action, ['actionType', 'reversible', 'parameters'], `${path}.action`);
  const originKeys = Object.keys(origin).sort();
  if (JSON.stringify(originKeys) !== JSON.stringify(['kind', 'source']) &&
      JSON.stringify(originKeys) !== JSON.stringify(['authoringTier', 'kind', 'source'])) {
    throw new Error(`${path}.origin has unexpected or missing fields`);
  }
  const id = stringField(value['id'], `${path}.id`);
  const adapter = stringField(value['adapter'], `${path}.adapter`) as AdversarialAdapter;
  const criticalShape = stringField(value['criticalShape'], `${path}.criticalShape`) as CriticalShape;
  const kind = stringField(origin['kind'], `${path}.origin.kind`) as OriginKind;
  const expectedDisposition = stringField(
    value['expectedDisposition'], `${path}.expectedDisposition`,
  ) as ExpectedDisposition;
  const expectedConfirmation = stringField(
    value['expectedConfirmation'], `${path}.expectedConfirmation`,
  );
  const evidenceMode = stringField(value['evidenceMode'], `${path}.evidenceMode`) as EvidenceMode;
  const provenance = stringField(value['provenance'], `${path}.provenance`) as ActionProvenance;
  if (!ID_RE.test(id)) throw new Error(`${path}.id is not canonical`);
  if (!ADAPTERS.has(adapter)) throw new Error(`${path}.adapter is unsupported`);
  if (!SHAPES.has(criticalShape)) throw new Error(`${path}.criticalShape is unsupported`);
  if (!ORIGINS.has(kind)) throw new Error(`${path}.origin.kind is unsupported`);
  if (!DISPOSITIONS.has(expectedDisposition)) throw new Error(`${path}.expectedDisposition is unsupported`);
  if (expectedConfirmation !== 'none' && expectedConfirmation !== 'single' && expectedConfirmation !== 'dual') {
    throw new Error(`${path}.expectedConfirmation is unsupported`);
  }
  if (!MODES.has(evidenceMode)) throw new Error(`${path}.evidenceMode is unsupported`);
  if (!PROVENANCES.has(provenance)) throw new Error(`${path}.provenance is unsupported`);
  if (typeof action['reversible'] !== 'boolean' || !isPlainObject(action['parameters'])) {
    throw new Error(`${path}.action is malformed`);
  }
  const authoringTier = origin['authoringTier'];
  if (authoringTier !== undefined && typeof authoringTier !== 'string') {
    throw new Error(`${path}.origin.authoringTier must be a string`);
  }
  const executableTestId = stringField(value['executableTestId'], `${path}.executableTestId`);
  const assertionFile = value['assertionFile'];
  const assertionSha256 = value['assertionSha256'];
  if (evidenceMode === 'mapped_regression') {
    if (typeof assertionFile !== 'string' || !SOURCE_FILE_RE.test(assertionFile) ||
        typeof assertionSha256 !== 'string' || !SHA256_RE.test(assertionSha256)) {
      throw new Error(`${path} mapped regression must bind a source file and SHA-256`);
    }
    const testIdParts = executableTestId.split('::');
    const packageMatch = /^@skytwin\/([a-z0-9-]+)$/.exec(testIdParts[0] ?? '');
    const assertionMatch = /^(apps|packages)\/([a-z0-9-]+)\/(src\/[a-z0-9_./-]+\.test\.ts)$/.exec(
      assertionFile,
    );
    if (testIdParts.length !== 3 || testIdParts.some((part) => part.length === 0) ||
        !packageMatch || !assertionMatch || packageMatch[1] !== assertionMatch[2] ||
        testIdParts[1] !== assertionMatch[3]) {
      throw new Error(`${path} assertion file does not match executable test ID`);
    }
  } else if (assertionFile !== null || assertionSha256 !== null) {
    throw new Error(`${path} deterministic policy scenario cannot claim a mapped assertion`);
  }
  return {
    id,
    runtimeEntryPath: stringField(value['runtimeEntryPath'], `${path}.runtimeEntryPath`),
    adapter,
    criticalShape,
    action: {
      actionType: stringField(action['actionType'], `${path}.action.actionType`),
      reversible: action['reversible'],
      parameters: action['parameters'],
    },
    origin: {
      kind,
      source: stringField(origin['source'], `${path}.origin.source`),
      ...(authoringTier === undefined ? {} : { authoringTier }),
    },
    provenance,
    failureMode: stringField(value['failureMode'], `${path}.failureMode`),
    expectedDisposition,
    expectedConfirmation: expectedConfirmation as ConfirmationLevel,
    evidenceMode,
    executableTestId,
    assertionFile: assertionFile as string | null,
    assertionSha256: assertionSha256 as string | null,
  };
}

function walkTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
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

function calledMethodName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  if (ts.isElementAccessExpression(node.expression) &&
      ts.isStringLiteral(node.expression.argumentExpression)) {
    return node.expression.argumentExpression.text;
  }
  return null;
}

/** Parse call expressions so comments and string literals cannot satisfy the inventory. */
export function collectDispatchCalls(sourceFile: string, source: string): AdversarialDispatchCall[] {
  const parsed = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: AdversarialDispatchCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calledMethodName(node);
      if (name && DISPATCH_CALLS.has(name as AdversarialDispatchCall)) {
        calls.push(name as AdversarialDispatchCall);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return calls;
}

function parseSourceInventory(value: unknown): AdversarialSourceInventoryEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('catalog.sourceInventory must be a non-empty array');
  }
  const entries = value.map((raw, index) => {
    const path = `catalog.sourceInventory[${index}]`;
    if (!isPlainObject(raw)) throw new Error(`${path} must be an object`);
    exactKeys(raw, ['sourceFile', 'dispatchCall', 'runtimeEntryPath', 'occurrences'], path);
    const sourceFile = stringField(raw['sourceFile'], `${path}.sourceFile`);
    const dispatchCall = stringField(raw['dispatchCall'], `${path}.dispatchCall`);
    const runtimeEntryPath = stringField(raw['runtimeEntryPath'], `${path}.runtimeEntryPath`);
    const occurrences = raw['occurrences'];
    if (!SOURCE_FILE_RE.test(sourceFile) ||
        !DISPATCH_CALLS.has(dispatchCall as AdversarialDispatchCall) ||
        !Number.isSafeInteger(occurrences) || (occurrences as number) < 1) {
      throw new Error(`${path} is malformed`);
    }
    return {
      sourceFile,
      dispatchCall: dispatchCall as AdversarialSourceInventoryEntry['dispatchCall'],
      runtimeEntryPath,
      occurrences: occurrences as number,
    };
  });
  const keys = entries.map(({ sourceFile, dispatchCall }) => `${sourceFile}::${dispatchCall}`);
  if (new Set(keys).size !== keys.length ||
      JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    throw new Error('catalog.sourceInventory must have unique lexicographically sorted source/call entries');
  }
  return entries;
}

function validateRuntimeSourceInventory(
  repoRoot: string,
  inventory: AdversarialSourceInventoryEntry[],
): void {
  const declared = new Map(inventory.map((entry) =>
    [`${entry.sourceFile}::${entry.dispatchCall}`, entry]));
  const observed = new Map<string, number>();
  for (const scanRoot of INVENTORY_SCAN_ROOTS) {
    for (const absolutePath of walkTypeScriptFiles(join(repoRoot, scanRoot))) {
      const sourceFile = relative(repoRoot, absolutePath).split(sep).join('/');
      const source = readFileSync(absolutePath, 'utf8');
      for (const dispatchCall of collectDispatchCalls(sourceFile, source)) {
        const key = `${sourceFile}::${dispatchCall}`;
        observed.set(key, (observed.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, count] of observed) {
    const entry = declared.get(key);
    if (!entry) throw new Error(`runtime dispatch source is missing from sourceInventory: ${key}`);
    if (entry.occurrences !== count) {
      throw new Error(`runtime dispatch occurrence count changed for ${key}`);
    }
  }
  for (const key of declared.keys()) {
    if (!observed.has(key)) throw new Error(`sourceInventory entry is stale: ${key}`);
  }
}

export function loadAdversarialCatalog(): { catalog: AdversarialCatalog; fixtureSha256: string } {
  const bytes = readFileSync(ADVERSARIAL_FIXTURE_URL);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isPlainObject(parsed)) throw new Error('catalog must be an object');
  exactKeys(parsed, [
    'schemaVersion', 'fixturesVersion', 'coverageTargets', 'sourceInventory', 'scenarios',
  ], 'catalog');
  if (parsed['schemaVersion'] !== ADVERSARIAL_SCHEMA_VERSION) throw new Error('unsupported schemaVersion');
  if (parsed['fixturesVersion'] !== ADVERSARIAL_FIXTURES_VERSION) throw new Error('unsupported fixturesVersion');
  if (!Array.isArray(parsed['scenarios']) || parsed['scenarios'].length === 0) {
    throw new Error('catalog scenarios must be a non-empty array');
  }
  const rawTargets = parsed['coverageTargets'];
  if (!isPlainObject(rawTargets)) throw new Error('catalog.coverageTargets must be an object');
  exactKeys(rawTargets, ['runtimeEntryPaths', 'adapters', 'criticalShapes', 'origins'], 'catalog.coverageTargets');
  const coverageTargets: AdversarialCoverageTargets = {
    runtimeEntryPaths: parseUniqueStrings(rawTargets['runtimeEntryPaths'], 'catalog.coverageTargets.runtimeEntryPaths'),
    adapters: parseUniqueStrings(rawTargets['adapters'], 'catalog.coverageTargets.adapters', ADAPTERS),
    criticalShapes: parseUniqueStrings(rawTargets['criticalShapes'], 'catalog.coverageTargets.criticalShapes', SHAPES),
    origins: parseUniqueStrings(rawTargets['origins'], 'catalog.coverageTargets.origins', ORIGINS),
  };
  const sourceInventory = parseSourceInventory(parsed['sourceInventory']);
  const scenarios = parsed['scenarios'].map(parseScenario);
  const ids = scenarios.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('catalog contains duplicate scenario IDs');
  if (new Set(scenarios.map(({ executableTestId }) => executableTestId)).size !== scenarios.length) {
    throw new Error('catalog contains duplicate executable test IDs');
  }
  const assertionFiles = scenarios.flatMap(({ assertionFile }) =>
    assertionFile === null ? [] : [assertionFile]);
  if (new Set(assertionFiles).size !== assertionFiles.length) {
    throw new Error('each mapped regression must use a dedicated assertion file');
  }
  for (const scenario of scenarios) {
    if (!coverageTargets.runtimeEntryPaths.includes(scenario.runtimeEntryPath) ||
        !coverageTargets.adapters.includes(scenario.adapter) ||
        !coverageTargets.criticalShapes.includes(scenario.criticalShape) ||
        !coverageTargets.origins.includes(scenario.origin.kind)) {
      throw new Error(`scenario ${scenario.id} uses a value outside coverageTargets`);
    }
    const derivedProvenance = resolveActionProvenance(
      scenario.origin.source,
      scenario.origin.authoringTier,
    );
    if (scenario.provenance !== derivedProvenance) {
      throw new Error(`scenario ${scenario.id} provenance does not match its origin`);
    }
  }
  for (const entry of sourceInventory) {
    if (!coverageTargets.runtimeEntryPaths.includes(entry.runtimeEntryPath)) {
      throw new Error(`sourceInventory path is outside coverageTargets: ${entry.runtimeEntryPath}`);
    }
  }
  const fixturePath = fileURLToPath(ADVERSARIAL_FIXTURE_URL);
  const repoRoot = resolve(dirname(fixturePath), '../../../..');
  validateRuntimeSourceInventory(repoRoot, sourceInventory);
  return {
    catalog: {
      schemaVersion: ADVERSARIAL_SCHEMA_VERSION,
      fixturesVersion: ADVERSARIAL_FIXTURES_VERSION,
      coverageTargets,
      sourceInventory,
      scenarios,
    },
    fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function evaluateAdversarialScenario(
  scenario: AdversarialScenario,
  executable: ExecutableTestResult,
): AdversarialResult {
  const identity = {
    id: scenario.id,
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
  if (executable.executableTestId !== scenario.executableTestId ||
      executable.assertionSha256 !== scenario.assertionSha256 ||
      executable.status === 'failed') {
    return {
      ...identity,
      status: 'failed',
      executableTestStatus: 'failed',
      actualDisposition: null,
      actualConfirmation: null,
      actualSeverity: null,
      reason: 'mapped executable test failed',
    };
  }
  if (scenario.evidenceMode === 'mapped_regression') {
    return {
      ...identity,
      status: 'passed',
      executableTestStatus: 'passed',
      // Vitest's JSON reporter establishes only that the exact assertion
      // passed. It does not expose typed semantic observations from the test
      // body, so representing the catalog expectation as an actual would be a
      // false claim. A future structured observation channel can populate
      // these fields without changing the meaning of source-checkout evidence.
      actualDisposition: null,
      actualConfirmation: null,
      actualSeverity: null,
      reason: 'exact mapped regression assertion passed with integrity-bound source',
    };
  }
  const verdict = evaluateInjectionGuard({ ...scenario.action, provenance: scenario.provenance });
  const actualDisposition = verdict.escalate ? 'requires_confirmation' : 'normal_policy_flow';
  const actualConfirmation = verdict.escalate ? verdict.confirmationLevel ?? null : null;
  const actualSeverity = classifyActionSeverity(scenario.action);
  const expectedConfirmation = scenario.expectedConfirmation === 'none'
    ? null
    : scenario.expectedConfirmation;
  const passed = actualDisposition === scenario.expectedDisposition &&
    actualConfirmation === expectedConfirmation;
  return {
    ...identity,
    status: passed ? 'passed' : 'failed',
    executableTestStatus: 'passed',
    actualDisposition,
    actualConfirmation,
    actualSeverity,
    reason: passed ? 'deterministic policy primitive matched the catalog expectation' :
      'deterministic policy primitive did not match the catalog expectation',
  };
}

function dimensionCoverage(
  scenarios: AdversarialScenario[],
  targets: readonly string[],
  key: 'runtimeEntryPath' | 'adapter' | 'criticalShape',
): CoverageDenominator {
  const covered = new Set(scenarios.map((scenario) => scenario[key]));
  return { covered: targets.filter((target) => covered.has(target)).length, total: targets.length };
}

export function buildAdversarialEvidence(
  catalog: AdversarialCatalog,
  fixtureSha256: string,
  source: AdversarialEvidenceReport['source'],
  executableTests: Map<string, ExecutableTestResult>,
): AdversarialEvidenceReport {
  const scenarios = [...catalog.scenarios].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const results = scenarios.map((scenario) => {
    const executable = executableTests.get(scenario.executableTestId);
    if (!executable) throw new Error(`missing mapped test result for ${scenario.executableTestId}`);
    return evaluateAdversarialScenario(scenario, executable);
  });
  const coveredOrigins = new Set(scenarios.map(({ origin }) => origin.kind));
  const passed = results.filter(({ status }) => status === 'passed').length;
  const failed = results.filter(({ status }) => status === 'failed').length;
  const uncovered = results.filter(({ status }) => status === 'uncovered').length;
  const runtimeEntryPaths = dimensionCoverage(
    scenarios, catalog.coverageTargets.runtimeEntryPaths, 'runtimeEntryPath',
  );
  const adapters = dimensionCoverage(scenarios, catalog.coverageTargets.adapters, 'adapter');
  const criticalShapes = dimensionCoverage(
    scenarios, catalog.coverageTargets.criticalShapes, 'criticalShape',
  );
  const origins = {
    covered: catalog.coverageTargets.origins.filter((origin) => coveredOrigins.has(origin)).length,
    total: catalog.coverageTargets.origins.length,
  };
  return {
    schemaVersion: ADVERSARIAL_SCHEMA_VERSION,
    evidenceClass: 'source_checkout',
    releaseSubject: null,
    attestation: null,
    source,
    fixtures: { version: ADVERSARIAL_FIXTURES_VERSION, sha256: fixtureSha256 },
    exactIds: scenarios.map(({ id }) => id),
    environment: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      ci: process.env['CI'] === 'true',
    },
    determinism: {
      networkPolicy: 'not_enforced',
      randomSeed: null,
      clockPolicy: 'not_controlled',
      scenarioOrder: 'lexicographic_id',
    },
    structuralCoverage: {
      scenarios: { covered: scenarios.length, total: scenarios.length },
      runtimeEntryPaths,
      adapters,
      criticalShapes,
      origins,
    },
    testSummary: { passed, failed, uncovered },
    results,
    failures: results.filter(({ status }) => status === 'failed').map(({ id, reason }) => ({ id, reason })),
    mitigations: [...ADVERSARIAL_MITIGATIONS],
    limitations: [...ADVERSARIAL_LIMITATIONS],
    developmentStatus: 'incomplete',
    allowIncomplete: true,
    releaseReadiness: null,
    zeroBypassesClaimed: false,
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('canonical JSON cannot encode undefined');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
