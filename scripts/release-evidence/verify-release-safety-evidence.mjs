#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TRACKED_TYPESCRIPT = /^(?:apps|packages)\/[a-z0-9._/-]+\.ts$/u;

// Keep these literals independent from the producer. A producer change cannot
// silently teach this verifier to accept a new schema, identity, or input set.
const RELEASE_SAFETY_SCHEMA_VERSION = 1;
const RELEASE_SAFETY_GENERATOR = "release-safety-evidence-generator";
const RELEASE_SAFETY_INVENTORY_PATH =
  "scripts/release-evidence/release-safety-entry-paths.json";
const RELEASE_SAFETY_FIXTURE_PATH =
  "packages/evals/fixtures/v1/adversarial-scenarios.json";
const RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH =
  "release-claims-ci/adversarial-evidence.json";
const RELEASE_SAFETY_REPORT_PATH =
  "release-claims-ci/release-safety-evidence.json";
const DETERMINISTIC_POLICY_TEST_PATH =
  "packages/evals/src/__tests__/adversarial-evidence.test.ts";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function same(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${description} does not match canonical evidence`);
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

function readContained(root, relativePath, description) {
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
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    realpathSync(absolute) !== absolute
  )
    throw new Error(`${description} is not a canonical regular file`);
  return readFileSync(absolute);
}

function readJson(root, path, description) {
  const bytes = readContained(root, path, description);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
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
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`${description} failed`);
  return result.stdout.trim();
}

function positiveInteger(value, description) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? "")))
    throw new Error(`${description} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${description} is too large`);
  return parsed;
}

function expectedTagContext(env) {
  if (!REPOSITORY.test(env.GITHUB_REPOSITORY ?? ""))
    throw new Error("GITHUB_REPOSITORY must identify owner/repository");
  if (!COMMIT.test(env.GITHUB_SHA ?? ""))
    throw new Error("GITHUB_SHA must be a full lowercase commit");
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    !String(env.GITHUB_REF ?? "").startsWith("refs/tags/v")
  )
    throw new Error("release safety verification is tag-push only");
  return {
    repository: env.GITHUB_REPOSITORY,
    sourceCommit: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    event: env.GITHUB_EVENT_NAME,
    runId: positiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
  };
}

export function verifyReleaseSafetyEvidence({
  root = DEFAULT_ROOT,
  reportPath = RELEASE_SAFETY_REPORT_PATH,
  adversarialPath = RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH,
  expected = {},
  requireComplete = false,
} = {}) {
  root = realpathSync(resolve(root));
  const reportInput = readJson(root, reportPath, "release safety report");
  const inventoryInput = readJson(
    root,
    RELEASE_SAFETY_INVENTORY_PATH,
    "release safety inventory",
  );
  const fixtureInput = readJson(
    root,
    RELEASE_SAFETY_FIXTURE_PATH,
    "adversarial fixture",
  );
  const adversarialInput = readJson(
    root,
    adversarialPath,
    "adversarial report",
  );
  const report = reportInput.value;
  const inventory = inventoryInput.value;
  const fixture = fixtureInput.value;
  const adversarial = adversarialInput.value;

  exactKeys(
    report,
    [
      "schemaVersion",
      "generatedBy",
      "status",
      "repository",
      "sourceCommit",
      "ref",
      "event",
      "runId",
      "runAttempt",
      "sourceTree",
      "inputs",
      "coverage",
      "sourceFiles",
      "testFiles",
      "entryPaths",
      "failures",
      "limitations",
      "claimState",
      "releaseStatus",
    ],
    "release safety report",
  );
  if (
    report.schemaVersion !== RELEASE_SAFETY_SCHEMA_VERSION ||
    report.generatedBy !== RELEASE_SAFETY_GENERATOR ||
    !["limited", "pass"].includes(report.status) ||
    !COMMIT.test(report.sourceCommit ?? "") ||
    !COMMIT.test(report.sourceTree ?? "") ||
    report.claimState !== "limited" ||
    report.releaseStatus !== "blocked"
  )
    throw new Error(
      "release safety report identity or conservative status is invalid",
    );
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && report[key] !== value)
      throw new Error(
        `release safety report ${key} is not the expected tag context`,
      );
  }
  const head = git(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "HEAD identity",
  );
  const tree = git(
    root,
    ["rev-parse", "--verify", `${head}^{tree}`],
    "tree identity",
  );
  if (report.sourceCommit !== head || report.sourceTree !== tree)
    throw new Error(
      "release safety report source identity is not the checked-out commit and tree",
    );
  if (
    git(
      root,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "clean checkout",
    ) !== ""
  )
    throw new Error("release safety verification requires a clean checkout");
  exactKeys(
    report.inputs,
    ["inventory", "fixture", "adversarialReport"],
    "release safety inputs",
  );
  const expectedInputs = {
    inventory: {
      path: RELEASE_SAFETY_INVENTORY_PATH,
      sha256: sha256(inventoryInput.bytes),
    },
    fixture: {
      path: RELEASE_SAFETY_FIXTURE_PATH,
      sha256: sha256(fixtureInput.bytes),
    },
    adversarialReport: {
      path: RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH,
      sha256: sha256(adversarialInput.bytes),
    },
  };
  same(report.inputs, expectedInputs, "release safety input identity");

  if (
    adversarial.evidenceClass !== "source_checkout" ||
    adversarial.source?.commit !== head ||
    adversarial.source?.cleanTree !== true ||
    adversarial.fixtures?.sha256 !== expectedInputs.fixture.sha256 ||
    adversarial.developmentStatus !== "incomplete" ||
    adversarial.releaseReadiness !== null ||
    adversarial.zeroBypassesClaimed !== false
  )
    throw new Error(
      "adversarial input is not the conservative exact-source report",
    );
  const scenarios = new Map(
    fixture.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const results = new Map(
    adversarial.results.map((result) => [result.id, result]),
  );
  const fixtureIds = [...scenarios.keys()].sort();
  if (
    scenarios.size !== fixture.scenarios.length ||
    results.size !== adversarial.results.length ||
    JSON.stringify(adversarial.exactIds) !== JSON.stringify(fixtureIds) ||
    JSON.stringify([...results.keys()]) !== JSON.stringify(fixtureIds)
  )
    throw new Error("adversarial scenario/result inventory is ambiguous");
  const scenarioCounts = adversarial.results.reduce(
    (counts, result) => {
      if (!Object.hasOwn(counts, result.status))
        throw new Error("adversarial result status is invalid");
      counts[result.status] += 1;
      return counts;
    },
    { passed: 0, failed: 0, uncovered: 0 },
  );
  exactKeys(
    adversarial.testSummary,
    ["passed", "failed", "uncovered"],
    "adversarial test summary",
  );
  if (
    Object.entries(scenarioCounts).some(
      ([status, count]) => adversarial.testSummary[status] !== count,
    )
  )
    throw new Error(
      "adversarial test summary does not match canonical evidence",
    );

  exactKeys(
    inventory,
    ["schemaVersion", "entryPaths", "limitations"],
    "release safety inventory",
  );
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.entryPaths))
    throw new Error("release safety inventory schema is invalid");
  const catalogPaths = uniqueSortedStrings(
    fixture.coverageTargets?.runtimeEntryPaths,
    "catalog runtime entry paths",
  );
  same(
    inventory.entryPaths.map((entry) => entry.id),
    catalogPaths,
    "release safety denominator",
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

  const expectedEntries = [];
  const expectedFailures = [];
  const sourcePaths = new Set();
  const testPaths = new Set();
  for (const [index, entry] of inventory.entryPaths.entries()) {
    exactKeys(
      entry,
      ["id", "sourceFiles", "safetyScenarioIds", "explanationScenarioIds"],
      `inventory.entryPaths[${index}]`,
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
        `${entry.id} explanation scenarios are not a safety subset`,
      );
    sourceFiles.forEach((path) => sourcePaths.add(path));
    let safetyPassed = true;
    for (const id of safetyScenarioIds) {
      const scenario = scenarios.get(id);
      const result = results.get(id);
      if (!scenario || scenario.runtimeEntryPath !== entry.id || !result)
        throw new Error(`${entry.id} scenario ${id} is missing or mismatched`);
      if (result.runtimeEntryPath !== entry.id || result.status !== "passed")
        safetyPassed = false;
      const testPath =
        scenario.evidenceMode === "mapped_regression"
          ? scenario.assertionFile
          : DETERMINISTIC_POLICY_TEST_PATH;
      if (typeof testPath !== "string")
        throw new Error(`${id} has no test path`);
      if (!TRACKED_TYPESCRIPT.test(testPath))
        throw new Error(`${id} has an unsafe test path`);
      testPaths.add(testPath);
    }
    const explanationCovered =
      explanationScenarioIds.length > 0 &&
      explanationScenarioIds.every((id) => {
        const scenario = scenarios.get(id);
        return (
          scenario?.evidenceMode === "mapped_regression" &&
          results.get(id)?.status === "passed"
        );
      });
    if (!safetyPassed)
      expectedFailures.push({
        entryPath: entry.id,
        kind: "safety",
        reason: "one or more adversarial scenarios did not pass",
      });
    if (!explanationCovered)
      expectedFailures.push({
        entryPath: entry.id,
        kind: "explanation",
        reason:
          "no passing integrity-bound explanation persistence assertion is declared",
      });
    expectedEntries.push({
      id: entry.id,
      sourceFiles,
      safetyScenarioIds,
      explanationScenarioIds,
      safetyStatus: safetyPassed ? "covered" : "failed",
      explanationStatus: explanationCovered ? "covered" : "uncovered",
    });
  }
  same(report.entryPaths, expectedEntries, "release safety entry-path results");
  same(report.failures, expectedFailures, "release safety failures");
  same(report.limitations, inventory.limitations, "release safety limitations");

  const expectedSourceFiles = [...sourcePaths].sort().map((path) => {
    git(
      root,
      ["ls-files", "--error-unmatch", "--", path],
      `tracked source ${path}`,
    );
    return {
      path,
      sha256: sha256(
        readContained(root, path, `release safety source ${path}`),
      ),
    };
  });
  const expectedTestFiles = [...testPaths].sort().map((path) => {
    git(
      root,
      ["ls-files", "--error-unmatch", "--", path],
      `tracked test ${path}`,
    );
    const digest = sha256(
      readContained(root, path, `release safety test ${path}`),
    );
    for (const scenario of fixture.scenarios.filter(
      (item) => item.assertionFile === path,
    )) {
      if (
        !SHA256.test(scenario.assertionSha256 ?? "") ||
        scenario.assertionSha256 !== digest
      )
        throw new Error(`fixture assertion digest is stale for ${path}`);
    }
    return { path, sha256: digest };
  });
  same(report.sourceFiles, expectedSourceFiles, "release safety source hashes");
  same(report.testFiles, expectedTestFiles, "release safety test hashes");

  const expectedCoverage = {
    entryPaths: {
      covered: expectedEntries.length,
      total: expectedEntries.length,
      failed: 0,
    },
    safety: {
      covered: expectedEntries.filter(
        (entry) => entry.safetyStatus === "covered",
      ).length,
      total: expectedEntries.length,
      failed: expectedEntries.filter((entry) => entry.safetyStatus === "failed")
        .length,
    },
    explanations: {
      covered: expectedEntries.filter(
        (entry) => entry.explanationStatus === "covered",
      ).length,
      total: expectedEntries.length,
      failed: expectedEntries.filter(
        (entry) => entry.explanationStatus !== "covered",
      ).length,
    },
    adversarialScenarios: {
      ...scenarioCounts,
      total: adversarial.results.length,
    },
    sourceFiles: {
      verified: expectedSourceFiles.length,
      total: expectedSourceFiles.length,
      failed: 0,
    },
    testFiles: {
      verified: expectedTestFiles.length,
      total: expectedTestFiles.length,
      failed: 0,
    },
    limitations: { total: inventory.limitations.length },
  };
  same(report.coverage, expectedCoverage, "release safety coverage counts");
  const expectedStatus = expectedFailures.length === 0 ? "pass" : "limited";
  if (report.status !== expectedStatus)
    throw new Error("release safety status does not match failures");
  if (requireComplete && report.status !== "pass")
    throw new Error("release safety evidence is truthful but incomplete");
  return {
    status: report.status,
    entryPaths: expectedEntries.length,
    explanationsCovered: expectedCoverage.explanations.covered,
    failures: expectedFailures.length,
    sha256: sha256(reportInput.bytes),
  };
}

function parseArgs(argv) {
  let reportPath = RELEASE_SAFETY_REPORT_PATH;
  let adversarialPath = RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH;
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--report") reportPath = value;
    else if (flag === "--adversarial") adversarialPath = value;
    else throw new Error(`unsupported argument ${flag}`);
  }
  if (
    reportPath !== RELEASE_SAFETY_REPORT_PATH ||
    adversarialPath !== RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH
  )
    throw new Error("release safety evidence paths are fixed");
  return { reportPath, adversarialPath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = verifyReleaseSafetyEvidence({
      ...args,
      expected: expectedTagContext(process.env),
    });
    process.stdout.write(
      `verified release safety evidence: ${result.entryPaths} entry paths, ` +
        `${result.explanationsCovered} explanation-covered, ${result.failures} disclosed gaps, ` +
        `sha256 ${result.sha256}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `release safety evidence verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
