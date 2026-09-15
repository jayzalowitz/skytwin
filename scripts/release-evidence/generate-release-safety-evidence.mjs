#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_SAFETY_SCHEMA_VERSION = 1;
export const RELEASE_SAFETY_GENERATOR = "release-safety-evidence-generator";
export const RELEASE_SAFETY_INVENTORY_PATH =
  "scripts/release-evidence/release-safety-entry-paths.json";
export const RELEASE_SAFETY_FIXTURE_PATH =
  "packages/evals/fixtures/v1/adversarial-scenarios.json";
export const RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH =
  "release-claims-ci/adversarial-evidence.json";
export const RELEASE_SAFETY_REPORT_PATH =
  "release-claims-ci/release-safety-evidence.json";
export const DETERMINISTIC_POLICY_TEST_PATH =
  "packages/evals/src/__tests__/adversarial-evidence.test.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
const COMMIT = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TRACKED_TYPESCRIPT = /^(?:apps|packages)\/[a-z0-9._/-]+\.ts$/u;
const GIT_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root, args, description) {
  const result = spawnSync(
    "/usr/bin/git",
    [
      "--no-pager",
      "--literal-pathspecs",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.excludesFile=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.untrackedCache=false",
      ...args,
    ],
    { cwd: root, env: GIT_ENV, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(`${description} failed`);
  return result.stdout.trim();
}

function containedRegularFile(root, relativePath, description) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${description} path is unsafe`);
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`${description} escapes the repository`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error(`${description} is not a single-link regular file`);
  if (realpathSync(absolute) !== absolute)
    throw new Error(`${description} traverses a symlink`);
  const descriptor = openSync(
    absolute,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? "")))
    throw new Error(`${name} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} is too large`);
  return number;
}

function releaseContext(env) {
  if (!REPOSITORY.test(env.GITHUB_REPOSITORY ?? ""))
    throw new Error("GITHUB_REPOSITORY must identify owner/repository");
  if (!COMMIT.test(env.GITHUB_SHA ?? ""))
    throw new Error("GITHUB_SHA must be a full lowercase commit");
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    !String(env.GITHUB_REF ?? "").startsWith("refs/tags/v")
  )
    throw new Error("release safety evidence is tag-push only");
  return {
    repository: env.GITHUB_REPOSITORY,
    sourceCommit: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    event: env.GITHUB_EVENT_NAME,
    runId: parsePositiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    runAttempt: parsePositiveInteger(
      env.GITHUB_RUN_ATTEMPT,
      "GITHUB_RUN_ATTEMPT",
    ),
  };
}

function uniqueSortedStrings(value, description, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length ||
    JSON.stringify(value) !== JSON.stringify([...value].sort())
  )
    throw new Error(`${description} must be unique and sorted`);
  return value;
}

function loadJson(root, path, description) {
  const bytes = containedRegularFile(root, path, description);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
  return { bytes, value };
}

function exactKeys(value, keys, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  )
    throw new Error(`${description} has unexpected or missing fields`);
}

export function buildReleaseSafetyEvidence({
  root = DEFAULT_ROOT,
  env = process.env,
  adversarialPath = RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH,
} = {}) {
  root = realpathSync(resolve(root));
  const context = releaseContext(env);
  const head = git(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "HEAD identity",
  );
  if (head !== context.sourceCommit) throw new Error("HEAD is not GITHUB_SHA");
  const sourceTree = git(
    root,
    ["rev-parse", "--verify", `${head}^{tree}`],
    "tree identity",
  );
  if (!COMMIT.test(sourceTree))
    throw new Error("source tree identity is malformed");

  const inventoryInput = loadJson(
    root,
    RELEASE_SAFETY_INVENTORY_PATH,
    "release safety inventory",
  );
  const fixtureInput = loadJson(
    root,
    RELEASE_SAFETY_FIXTURE_PATH,
    "adversarial fixture",
  );
  const adversarialInput = loadJson(
    root,
    adversarialPath,
    "adversarial report",
  );
  const inventory = inventoryInput.value;
  const fixture = fixtureInput.value;
  const adversarial = adversarialInput.value;
  exactKeys(
    inventory,
    ["schemaVersion", "entryPaths", "limitations"],
    "release safety inventory",
  );
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.entryPaths))
    throw new Error("release safety inventory schema is unsupported");
  const fixtureScenarios = new Map(
    fixture.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const results = new Map(
    adversarial.results.map((result) => [result.id, result]),
  );
  if (
    adversarial.evidenceClass !== "source_checkout" ||
    adversarial.source?.commit !== head ||
    adversarial.source?.cleanTree !== true ||
    adversarial.fixtures?.sha256 !== sha256(fixtureInput.bytes) ||
    adversarial.developmentStatus !== "incomplete" ||
    adversarial.releaseReadiness !== null ||
    adversarial.zeroBypassesClaimed !== false
  )
    throw new Error(
      "adversarial report is not the exact conservative source report",
    );
  const catalogPaths = uniqueSortedStrings(
    fixture.coverageTargets?.runtimeEntryPaths,
    "adversarial runtime entry paths",
  );
  const inventoryIds = inventory.entryPaths.map((entry) => entry.id);
  if (JSON.stringify(inventoryIds) !== JSON.stringify(catalogPaths))
    throw new Error(
      "release safety inventory must exactly equal the adversarial runtime entry paths",
    );
  if (
    !Array.isArray(inventory.limitations) ||
    inventory.limitations.length === 0 ||
    inventory.limitations.some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    new Set(inventory.limitations).size !== inventory.limitations.length
  )
    throw new Error("release safety limitations are malformed");

  const sourcePaths = new Set();
  const testPaths = new Set();
  const failures = [];
  const entries = inventory.entryPaths.map((entry, index) => {
    exactKeys(
      entry,
      ["id", "sourceFiles", "safetyScenarioIds", "explanationScenarioIds"],
      `entryPaths[${index}]`,
    );
    const sourceFiles = uniqueSortedStrings(
      entry.sourceFiles,
      `${entry.id}.sourceFiles`,
    );
    if (sourceFiles.some((path) => !TRACKED_TYPESCRIPT.test(path)))
      throw new Error(
        `${entry.id}.sourceFiles must contain TypeScript product paths`,
      );
    const safetyScenarioIds = uniqueSortedStrings(
      entry.safetyScenarioIds,
      `${entry.id}.safetyScenarioIds`,
    );
    const explanationScenarioIds = uniqueSortedStrings(
      entry.explanationScenarioIds,
      `${entry.id}.explanationScenarioIds`,
      { allowEmpty: true },
    );
    if (explanationScenarioIds.some((id) => !safetyScenarioIds.includes(id)))
      throw new Error(
        `${entry.id} explanation scenarios must be safety scenarios`,
      );
    sourceFiles.forEach((path) => sourcePaths.add(path));
    const scenarioStatuses = safetyScenarioIds.map((id) => {
      const scenario = fixtureScenarios.get(id);
      const result = results.get(id);
      if (
        !scenario ||
        scenario.runtimeEntryPath !== entry.id ||
        !result ||
        result.id !== id
      )
        throw new Error(
          `${entry.id} references a missing or mismatched scenario ${id}`,
        );
      const testPath =
        scenario.evidenceMode === "mapped_regression"
          ? scenario.assertionFile
          : DETERMINISTIC_POLICY_TEST_PATH;
      if (typeof testPath !== "string")
        throw new Error(`${id} has no integrity-bound test path`);
      if (!TRACKED_TYPESCRIPT.test(testPath))
        throw new Error(`${id} has an unsafe test path`);
      testPaths.add(testPath);
      return { id, status: result.status, testPath };
    });
    const safetyPassed = scenarioStatuses.every(
      ({ status }) => status === "passed",
    );
    const explanationCovered =
      explanationScenarioIds.length > 0 &&
      explanationScenarioIds.every((id) => {
        const scenario = fixtureScenarios.get(id);
        const result = results.get(id);
        return (
          scenario?.evidenceMode === "mapped_regression" &&
          result?.status === "passed"
        );
      });
    if (!safetyPassed)
      failures.push({
        entryPath: entry.id,
        kind: "safety",
        reason: "one or more adversarial scenarios did not pass",
      });
    if (!explanationCovered)
      failures.push({
        entryPath: entry.id,
        kind: "explanation",
        reason:
          "no passing integrity-bound explanation persistence assertion is declared",
      });
    return {
      id: entry.id,
      sourceFiles,
      safetyScenarioIds,
      explanationScenarioIds,
      safetyStatus: safetyPassed ? "covered" : "failed",
      explanationStatus: explanationCovered ? "covered" : "uncovered",
    };
  });

  const sourceFiles = [...sourcePaths].sort().map((path) => {
    git(
      root,
      ["ls-files", "--error-unmatch", "--", path],
      `tracked source ${path}`,
    );
    return {
      path,
      sha256: sha256(
        containedRegularFile(root, path, `release safety source ${path}`),
      ),
    };
  });
  const testFiles = [...testPaths].sort().map((path) => {
    git(
      root,
      ["ls-files", "--error-unmatch", "--", path],
      `tracked test ${path}`,
    );
    const digest = sha256(
      containedRegularFile(root, path, `release safety test ${path}`),
    );
    for (const scenario of fixture.scenarios.filter(
      (item) => item.assertionFile === path,
    )) {
      if (scenario.assertionSha256 !== digest)
        throw new Error(`fixture assertion digest is stale for ${path}`);
    }
    return { path, sha256: digest };
  });
  const resultCounts = adversarial.results.reduce(
    (counts, result) => ({
      ...counts,
      [result.status]: counts[result.status] + 1,
    }),
    { passed: 0, failed: 0, uncovered: 0 },
  );
  const coverage = {
    entryPaths: { covered: entries.length, total: entries.length, failed: 0 },
    safety: {
      covered: entries.filter((entry) => entry.safetyStatus === "covered")
        .length,
      total: entries.length,
      failed: entries.filter((entry) => entry.safetyStatus === "failed").length,
    },
    explanations: {
      covered: entries.filter((entry) => entry.explanationStatus === "covered")
        .length,
      total: entries.length,
      failed: entries.filter((entry) => entry.explanationStatus !== "covered")
        .length,
    },
    adversarialScenarios: {
      ...resultCounts,
      total: adversarial.results.length,
    },
    sourceFiles: {
      verified: sourceFiles.length,
      total: sourceFiles.length,
      failed: 0,
    },
    testFiles: {
      verified: testFiles.length,
      total: testFiles.length,
      failed: 0,
    },
    limitations: { total: inventory.limitations.length },
  };
  return {
    schemaVersion: RELEASE_SAFETY_SCHEMA_VERSION,
    generatedBy: RELEASE_SAFETY_GENERATOR,
    status: failures.length === 0 ? "pass" : "limited",
    ...context,
    sourceTree,
    inputs: {
      inventory: {
        path: RELEASE_SAFETY_INVENTORY_PATH,
        sha256: sha256(inventoryInput.bytes),
      },
      fixture: {
        path: RELEASE_SAFETY_FIXTURE_PATH,
        sha256: sha256(fixtureInput.bytes),
      },
      adversarialReport: {
        path: adversarialPath,
        sha256: sha256(adversarialInput.bytes),
      },
    },
    coverage,
    sourceFiles,
    testFiles,
    entryPaths: entries,
    failures,
    limitations: inventory.limitations,
    claimState: "limited",
    releaseStatus: "blocked",
  };
}

function parseArgs(argv) {
  let adversarialPath = RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH;
  let outputPath = RELEASE_SAFETY_REPORT_PATH;
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--adversarial") adversarialPath = value;
    else if (flag === "--output") outputPath = value;
    else throw new Error(`unsupported argument ${flag}`);
  }
  if (
    adversarialPath !== RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH ||
    outputPath !== RELEASE_SAFETY_REPORT_PATH
  )
    throw new Error("release safety evidence paths are fixed");
  return { adversarialPath, outputPath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = buildReleaseSafetyEvidence({
      adversarialPath: args.adversarialPath,
    });
    const absolute = resolve(DEFAULT_ROOT, args.outputPath);
    if (realpathSync(dirname(absolute)) !== dirname(absolute))
      throw new Error("release safety output directory is unsafe");
    writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(
      `release safety evidence: ${report.coverage.safety.covered}/${report.coverage.safety.total} safety, ` +
        `${report.coverage.explanations.covered}/${report.coverage.explanations.total} explanations; ${report.status}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `release safety evidence failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
