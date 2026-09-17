import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReleaseSafetyEvidence,
  DETERMINISTIC_POLICY_TEST_PATH,
  RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH,
  RELEASE_SAFETY_FIXTURE_PATH,
  RELEASE_SAFETY_INVENTORY_PATH,
  RELEASE_SAFETY_REPORT_PATH,
} from "./generate-release-safety-evidence.mjs";
import { verifyReleaseSafetyEvidence } from "./verify-release-safety-evidence.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function copy(root, path) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(REPO_ROOT, path), destination);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeJson(root, path, value) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "skytwin-release-safety-"));
  temporaryRoots.push(root);
  copy(root, RELEASE_SAFETY_INVENTORY_PATH);
  copy(root, RELEASE_SAFETY_FIXTURE_PATH);
  const inventory = JSON.parse(
    readFileSync(join(root, RELEASE_SAFETY_INVENTORY_PATH), "utf8"),
  );
  const fixture = JSON.parse(
    readFileSync(join(root, RELEASE_SAFETY_FIXTURE_PATH), "utf8"),
  );
  const paths = new Set([
    DETERMINISTIC_POLICY_TEST_PATH,
    ...inventory.entryPaths.flatMap((entry) => entry.sourceFiles),
    ...fixture.scenarios.flatMap((scenario) =>
      scenario.assertionFile ? [scenario.assertionFile] : [],
    ),
  ]);
  for (const path of paths) copy(root, path);
  writeFileSync(join(root, ".gitignore"), "/release-claims-ci/\n");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Release Safety Test"]);
  git(root, ["config", "user.email", "release-safety@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const fixtureBytes = readFileSync(join(root, RELEASE_SAFETY_FIXTURE_PATH));
  const results = fixture.scenarios
    .map((scenario) => ({
      id: scenario.id,
      runtimeEntryPath: scenario.runtimeEntryPath,
      status: "passed",
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  writeJson(root, RELEASE_SAFETY_ADVERSARIAL_REPORT_PATH, {
    evidenceClass: "source_checkout",
    source: { commit, ref: "DETACHED", cleanTree: true },
    fixtures: { sha256: sha256(fixtureBytes) },
    exactIds: results.map(({ id }) => id),
    results,
    testSummary: { failed: 0, passed: results.length, uncovered: 0 },
    developmentStatus: "incomplete",
    releaseReadiness: null,
    zeroBypassesClaimed: false,
  });
  const env = {
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_SHA: commit,
    GITHUB_REF: "refs/tags/v0.7.0-beta",
    GITHUB_EVENT_NAME: "push",
    GITHUB_RUN_ID: "101",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const report = buildReleaseSafetyEvidence({ root, env });
  expect(report.sourceTree).toBe(tree);
  writeJson(root, RELEASE_SAFETY_REPORT_PATH, report);
  return { root, report, env };
}

describe("release safety evidence", () => {
  it("records the exact source denominator and disclosed explanation gaps", () => {
    const { root, report, env } = fixtureRoot();
    const result = verifyReleaseSafetyEvidence({
      root,
      expected: {
        repository: env.GITHUB_REPOSITORY,
        sourceCommit: env.GITHUB_SHA,
        ref: env.GITHUB_REF,
        event: env.GITHUB_EVENT_NAME,
        runId: 101,
        runAttempt: 2,
      },
    });
    expect(result).toMatchObject({
      status: "limited",
      entryPaths: 10,
      explanationsCovered: 6,
      failures: 4,
    });
    expect(
      report.entryPaths
        .filter(({ explanationStatus }) => explanationStatus === "covered")
        .map(({ id }) => id),
    ).toEqual([
      "api.assistant",
      "api.events_ingest",
      "api.routines",
      "execution_router.pre_dispatch_guard",
      "shared_types.injection_guard",
      "worker.memory_action_loop",
    ]);
    expect(report.failures).toEqual([
      expect.objectContaining({
        entryPath: "api.approvals",
        kind: "explanation",
      }),
      expect.objectContaining({
        entryPath: "api.capability_regret",
        kind: "explanation",
      }),
      expect.objectContaining({
        entryPath: "execution_router.openclaw_response",
        kind: "explanation",
      }),
      expect.objectContaining({
        entryPath: "ironclaw_adapter.execute",
        kind: "explanation",
      }),
    ]);
    expect(() =>
      verifyReleaseSafetyEvidence({ root, requireComplete: true }),
    ).toThrow(/truthful but incomplete/);
  });

  it.each([
    [
      "source tree",
      (report) => {
        report.sourceTree = "0".repeat(40);
      },
      /source identity/,
    ],
    [
      "coverage count",
      (report) => {
        report.coverage.explanations.covered = 10;
      },
      /coverage counts/,
    ],
    [
      "passing status",
      (report) => {
        report.status = "pass";
      },
      /status does not match/,
    ],
    [
      "limitation deletion",
      (report) => {
        report.limitations.pop();
      },
      /limitations/,
    ],
  ])("rejects %s substitution", (_name, mutate, pattern) => {
    const { root, report } = fixtureRoot();
    mutate(report);
    writeJson(root, RELEASE_SAFETY_REPORT_PATH, report);
    expect(() => verifyReleaseSafetyEvidence({ root })).toThrow(pattern);
  });

  it("rejects source bytes that differ from the committed evidence", () => {
    const { root, report } = fixtureRoot();
    writeFileSync(join(root, report.sourceFiles[0].path), "substituted\n");
    expect(() => verifyReleaseSafetyEvidence({ root })).toThrow(
      /clean checkout/,
    );
  });

  it("rejects a report copied from a different tag run", () => {
    const { root } = fixtureRoot();
    expect(() =>
      verifyReleaseSafetyEvidence({
        root,
        expected: { runId: 999 },
      }),
    ).toThrow(/expected tag context/);
  });

  it("allows generated outputs only when every tracked byte still matches HEAD", () => {
    const { root } = fixtureRoot();
    writeFileSync(join(root, "publication-output.json"), "generated\n");
    expect(() => verifyReleaseSafetyEvidence({ root })).toThrow(
      /clean checkout/,
    );
    expect(() =>
      verifyReleaseSafetyEvidence({ root, trackedExactCheckout: true }),
    ).not.toThrow();
  });

  it.each(["skip-worktree", "assume-unchanged"])(
    "rejects a tracked mutation hidden by %s in tracked-exact mode",
    (flag) => {
      const { root, report } = fixtureRoot();
      const path = report.sourceFiles[0].path;
      git(root, ["update-index", `--${flag}`, path]);
      writeFileSync(join(root, path), "hidden tracked mutation\n");
      expect(git(root, ["status", "--porcelain=v1"])).toBe("");
      expect(() =>
        verifyReleaseSafetyEvidence({
          root,
          trackedExactCheckout: true,
        }),
      ).toThrow(/skip-worktree or assume-unchanged/);
    },
  );
});
