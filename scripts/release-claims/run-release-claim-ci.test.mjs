import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANONICAL_CI_EVIDENCE_COMMANDS,
  RELEASE_CLAIM_CI_CONSTANTS_PATH,
  RELEASE_CLAIM_CI_HARNESS_PATH,
  RELEASE_CLAIM_CI_LEDGER_PATH,
  RELEASE_CLAIM_CI_RESULT_PATH,
  RELEASE_CLAIM_CI_RUNTIME_CAPTURE_PATH,
  RELEASE_CLAIM_CI_SOURCE_PATHS,
} from "./release-constants.mjs";
import {
  releaseClaimCommandEnvironment,
  runReleaseClaimCi,
  validateReleaseClaimCiResult,
} from "./run-release-claim-ci.mjs";

const roots = [];
const env = {
  GITHUB_REPOSITORY: "owner/repository",
  GITHUB_REF: "refs/tags/v0.7.0-beta",
  GITHUB_EVENT_NAME: "push",
  GITHUB_RUN_ID: "1234",
  GITHUB_RUN_ATTEMPT: "2",
};

function git(root, args) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "skytwin-release-ci-"));
  roots.push(root);
  write(root, RELEASE_CLAIM_CI_LEDGER_PATH, '{"release":"blocked"}\n');
  write(
    root,
    RELEASE_CLAIM_CI_CONSTANTS_PATH,
    readFileSync(new URL("./release-constants.mjs", import.meta.url)),
  );
  write(
    root,
    RELEASE_CLAIM_CI_RUNTIME_CAPTURE_PATH,
    readFileSync(
      new URL("./capture-release-claim-ci-runtime.mjs", import.meta.url),
    ),
  );
  write(
    root,
    RELEASE_CLAIM_CI_HARNESS_PATH,
    readFileSync(new URL("./run-release-claim-ci.mjs", import.meta.url)),
  );
  for (const path of RELEASE_CLAIM_CI_SOURCE_PATHS.slice(4))
    write(
      root,
      path,
      readFileSync(new URL(`../../${path}`, import.meta.url)),
    );
  write(root, ".gitignore", "/release-claims-ci/\n");
  write(root, "package.json", '{"scripts":{"test":"vitest run"}}\n');
  write(root, "tracked-link-target.txt", "tracked symlink target\n");
  symlinkSync("tracked-link-target.txt", join(root, "tracked-link.txt"));
  const workspaceDirectories = new Map([
    ["@skytwin/api", "apps/api"],
    ["@skytwin/worker", "apps/worker"],
    ["skytwin-desktop", "apps/desktop"],
  ]);
  for (const command of CANONICAL_CI_EVIDENCE_COMMANDS.values()) {
    const workspace = command.args[1];
    const workspaceDirectory =
      workspaceDirectories.get(workspace) ??
      `packages/${String(workspace).replace(/^@skytwin\//u, "")}`;
    write(
      root,
      `${workspaceDirectory}/package.json`,
      `{"name":${JSON.stringify(workspace)},"scripts":{"test":"vitest run"}}\n`,
    );
    const separator = command.args.indexOf("--");
    for (const testPath of command.args.slice(separator + 1))
      write(root, `${workspaceDirectory}/${testPath}`, "// canonical test\n");
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "--all"]);
  git(root, [
    "-c",
    "user.name=SkyTwin Test",
    "-c",
    "user.email=test@skytwin.local",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

function releaseEnv(root, overrides = {}) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "skytwin-release-runtime-"));
  roots.push(runtimeRoot);
  const unresolvedPnpmEntryPath = join(
    runtimeRoot,
    "runtime/lib/node_modules/.pnpm/pnpm@9.1.0/node_modules/pnpm/dist/pnpm.cjs",
  );
  write(
    runtimeRoot,
    "runtime/lib/node_modules/.pnpm/pnpm@9.1.0/node_modules/pnpm/dist/pnpm.cjs",
    "// delegated pnpm CLI bundle\n",
  );
  const pnpmEntryPath = realpathSync(unresolvedPnpmEntryPath);
  const nodePath = realpathSync(process.execPath);
  return {
    ...env,
    GITHUB_SHA: git(root, ["rev-parse", "HEAD"]),
    PATH: "/attacker/path",
    GITHUB_PATH: "/attacker/github-path",
    NODE_OPTIONS: "--import=/attacker/loader.mjs",
    PNPM_HOME: "/attacker/pnpm-home",
    COREPACK_HOME: "/attacker/corepack-home",
    SKYTWIN_RELEASE_CI_NODE_PATH: nodePath,
    SKYTWIN_RELEASE_CI_NODE_SHA256: createHash("sha256")
      .update(readFileSync(nodePath))
      .digest("hex"),
    SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH: pnpmEntryPath,
    SKYTWIN_RELEASE_CI_PNPM_ENTRY_SHA256: createHash("sha256")
      .update(readFileSync(pnpmEntryPath))
      .digest("hex"),
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("release claim CI result producer", () => {
  it("tracks every frozen release claim source in the synthetic repository", () => {
    const root = fixtureRoot();
    for (const path of RELEASE_CLAIM_CI_SOURCE_PATHS)
      expect(git(root, ["ls-files", "--error-unmatch", "--", path])).toBe(
        path,
      );
  });

  it("uses the exact focused account-free proof commands from the ledger", () => {
    expect(
      CANONICAL_CI_EVIDENCE_COMMANDS.get("connectors.account-free-api-disabled")
        ?.args,
    ).toEqual([
      "--filter",
      "@skytwin/api",
      "test",
      "--",
      "src/__tests__/oauth-google-disabled.test.ts",
      "src/__tests__/oauth-microsoft.test.ts",
      "src/__tests__/credentials-routes.test.ts",
      "src/__tests__/capabilities-routes.test.ts",
      "src/__tests__/execution-setup.test.ts",
    ]);
    expect(
      CANONICAL_CI_EVIDENCE_COMMANDS.get(
        "connectors.account-free-worker-disabled",
      )?.args,
    ).toEqual([
      "--filter",
      "@skytwin/worker",
      "test",
      "--",
      "src/__tests__/connector-discovery.test.ts",
      "src/__tests__/execution-account-boundary.test.ts",
      "src/__tests__/changelog-poll.test.ts",
      "src/__tests__/federation-sync.test.ts",
      "src/__tests__/briefing-generator.test.ts",
      "src/__tests__/briefing-generator-adaptive.test.ts",
      "src/__tests__/promotion-eligibility-check.test.ts",
    ]);
    expect(
      CANONICAL_CI_EVIDENCE_COMMANDS.get(
        "connectors.account-free-shared-classifier",
      )?.args,
    ).toEqual([
      "--filter",
      "@skytwin/shared-types",
      "test",
      "--",
      "src/__tests__/google-preview-boundary.test.ts",
    ]);
    expect(
      CANONICAL_CI_EVIDENCE_COMMANDS.get(
        "connectors.account-free-router-disabled",
      )?.args,
    ).toEqual([
      "--filter",
      "@skytwin/execution-router",
      "test",
      "--",
      "src/__tests__/adapter-discovery.test.ts",
      "src/__tests__/execution-router.test.ts",
    ]);
    expect(
      CANONICAL_CI_EVIDENCE_COMMANDS.get(
        "connectors.account-free-desktop-disabled",
      )?.args,
    ).toEqual([
      "--filter",
      "skytwin-desktop",
      "test",
      "--",
      "src/__tests__/service-manager-env.test.ts",
    ]);
    expect(
      CANONICAL_CI_EVIDENCE_COMMANDS.has("connectors.account-free-disabled"),
    ).toBe(false);
  });

  it("records every frozen command exit code and immutable workflow identity", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
    const report = await runReleaseClaimCi({ root, env: runtimeEnv, execute });

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedBy: "release-claim-ci-harness",
      result: "pass",
      repository: runtimeEnv.GITHUB_REPOSITORY,
      sourceCommit: runtimeEnv.GITHUB_SHA,
      ref: runtimeEnv.GITHUB_REF,
      event: runtimeEnv.GITHUB_EVENT_NAME,
      runId: 1234,
      runAttempt: 2,
    });
    expect(execute).toHaveBeenCalledTimes(CANONICAL_CI_EVIDENCE_COMMANDS.size);
    for (const call of execute.mock.calls) {
      expect(call[0]).toMatchObject({
        executable: runtimeEnv.SKYTWIN_RELEASE_CI_NODE_PATH,
        root: realpathSync(root),
      });
      expect(call[0].args[0]).toBe(
        runtimeEnv.SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH,
      );
      expect(call[0]).not.toHaveProperty("shell");
    }
    expect(validateReleaseClaimCiResult(report)).toEqual([]);
    expect(
      JSON.parse(
        readFileSync(join(root, RELEASE_CLAIM_CI_RESULT_PATH), "utf8"),
      ),
    ).toEqual(report);
  }, 20_000);

  it("writes a failing result when a command fails or cannot start", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    let invocation = 0;
    const report = await runReleaseClaimCi({
      root,
      env: runtimeEnv,
      execute: async () => {
        invocation += 1;
        if (invocation === 1) return { exitCode: 7, error: null };
        if (invocation === 2) throw new Error("spawn failed");
        return { exitCode: 0, error: null };
      },
    });
    const checks = report.claims.flatMap((claim) => claim.checks);
    expect(report.result).toBe("fail");
    expect(checks[0]).toMatchObject({ result: "fail", exitCode: 7 });
    expect(checks[1]).toMatchObject({ result: "fail", exitCode: null });
    expect(checks[1].observed).toContain("spawn failed");
    expect(validateReleaseClaimCiResult(report)).toEqual([]);
  });

  it("bounds failure observations and rejects oversized evidence", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const report = await runReleaseClaimCi({
      root,
      env: runtimeEnv,
      execute: async () => {
        throw new Error("x".repeat(8192));
      },
    });
    const checks = report.claims.flatMap((claim) => claim.checks);
    expect(checks.every((check) => check.observed.length === 4096)).toBe(true);
    expect(validateReleaseClaimCiResult(report)).toEqual([]);

    checks[0].observed += "x";
    expect(validateReleaseClaimCiResult(report)).toContain(
      `${report.claims[0].claimId}/${checks[0].id} is not a canonical observed result`,
    );
  });

  it("rejects missing, duplicate, and extra canonical checks", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const report = await runReleaseClaimCi({
      root,
      env: runtimeEnv,
      execute: async () => ({ exitCode: 0, error: null }),
    });
    const missing = structuredClone(report);
    missing.claims[0].checks.pop();
    expect(validateReleaseClaimCiResult(missing)).not.toEqual([]);
    const duplicate = structuredClone(report);
    duplicate.claims[0].checks.push(duplicate.claims[0].checks[0]);
    expect(validateReleaseClaimCiResult(duplicate)).not.toEqual([]);
    const extra = structuredClone(report);
    extra.claims[0].checks.push({
      ...extra.claims[0].checks[0],
      id: "unreviewed.check",
      testId: "unreviewed.check",
    });
    expect(validateReleaseClaimCiResult(extra)).not.toEqual([]);
  });

  it("rejects caller-selected output paths and existing result files", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const execute = async () => ({ exitCode: 0, error: null });
    await expect(
      runReleaseClaimCi({
        root,
        env: runtimeEnv,
        execute,
        outputPath: "elsewhere.json",
      }),
    ).rejects.toThrow(`output must be ${RELEASE_CLAIM_CI_RESULT_PATH}`);
    await runReleaseClaimCi({ root, env: runtimeEnv, execute });
    await expect(
      runReleaseClaimCi({ root, env: runtimeEnv, execute }),
    ).rejects.toThrow();
  }, 15_000);

  it("refuses a result when a source changes while checks are running", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    let mutated = false;
    await expect(
      runReleaseClaimCi({
        root,
        env: runtimeEnv,
        execute: async () => {
          if (!mutated) {
            mutated = true;
            writeFileSync(
              join(root, RELEASE_CLAIM_CI_CONSTANTS_PATH),
              "export const changed = true;\n",
            );
          }
          return { exitCode: 0, error: null };
        },
      }),
    ).rejects.toThrow(
      "release claim source tree changed while checks were running",
    );
    expect(existsSync(join(root, RELEASE_CLAIM_CI_RESULT_PATH))).toBe(false);
  });

  it.each(["skip-worktree", "assume-unchanged"])(
    "rejects a modified tracked source hidden by %s index state",
    async (flag) => {
      const root = fixtureRoot();
      const runtimeEnv = releaseEnv(root);
      const path = RELEASE_CLAIM_CI_CONSTANTS_PATH;
      git(root, ["update-index", `--${flag}`, path]);
      writeFileSync(join(root, path), "export const hidden = true;\n");
      expect(git(root, ["status", "--porcelain=v1"])).toBe("");

      const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
      await expect(
        runReleaseClaimCi({ root, env: runtimeEnv, execute }),
      ).rejects.toThrow("skip-worktree or assume-unchanged");
      expect(execute).not.toHaveBeenCalled();
      expect(existsSync(join(root, RELEASE_CLAIM_CI_RESULT_PATH))).toBe(false);
    },
  );

  it("rejects an index staged from bytes that differ from the triggering tree", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    writeFileSync(
      join(root, RELEASE_CLAIM_CI_CONSTANTS_PATH),
      "export const staged = true;\n",
    );
    git(root, ["add", RELEASE_CLAIM_CI_CONSTANTS_PATH]);

    const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
    await expect(
      runReleaseClaimCi({ root, env: runtimeEnv, execute }),
    ).rejects.toThrow("index differs from the triggering commit");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not let repository config hide untracked source or launch an fsmonitor hook", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const marker = join(root, ".git", "fsmonitor-ran");
    const hook = join(root, ".git", "malicious-fsmonitor");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    const excludes = join(root, ".git", "attacker-excludes");
    writeFileSync(excludes, "attacker.mjs\n");
    git(root, ["config", "core.fsmonitor", hook]);
    git(root, ["config", "core.excludesFile", excludes]);
    writeFileSync(join(root, "attacker.mjs"), "throw new Error('hidden');\n");

    const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
    await expect(
      runReleaseClaimCi({ root, env: runtimeEnv, execute }),
    ).rejects.toThrow("source tree changed while checks were running");
    expect(existsSync(marker)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a hard-linked tracked source even when its bytes match HEAD", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const outside = mkdtempSync(join(tmpdir(), "skytwin-release-ci-link-"));
    roots.push(outside);
    linkSync(
      join(root, RELEASE_CLAIM_CI_HARNESS_PATH),
      join(outside, "linked-harness.mjs"),
    );

    const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
    await expect(
      runReleaseClaimCi({ root, env: runtimeEnv, execute }),
    ).rejects.toThrow("single-link regular file");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a tracked executable-mode change even when bytes match HEAD", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    chmodSync(join(root, RELEASE_CLAIM_CI_CONSTANTS_PATH), 0o755);

    const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
    await expect(
      runReleaseClaimCi({ root, env: runtimeEnv, execute }),
    ).rejects.toThrow("source tree changed while checks were running");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects replacing a tracked symlink with identical regular-file bytes", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const trackedLink = join(root, "tracked-link.txt");
    rmSync(trackedLink);
    writeFileSync(trackedLink, "tracked-link-target.txt");

    const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
    await expect(
      runReleaseClaimCi({ root, env: runtimeEnv, execute }),
    ).rejects.toThrow("is not a single-link symbolic link");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["delete", "rename"])(
    "rejects a %s of a required focused test before execution",
    async (mutation) => {
      const root = fixtureRoot();
      const runtimeEnv = releaseEnv(root);
      const testPath = join(
        root,
        "apps/api/src/__tests__/oauth-google-disabled.test.ts",
      );
      if (mutation === "delete") rmSync(testPath);
      else renameSync(testPath, `${testPath}.renamed`);
      const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
      await expect(
        runReleaseClaimCi({ root, env: runtimeEnv, execute }),
      ).rejects.toThrow(
        "release claim source tree changed while checks were running",
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rejects a package/test mutation before a later command can restore it", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const packagePath = join(root, "apps/api/package.json");
    const original = readFileSync(packagePath, "utf8");
    let invocation = 0;
    await expect(
      runReleaseClaimCi({
        root,
        env: runtimeEnv,
        execute: async () => {
          invocation += 1;
          if (invocation === 1)
            writeFileSync(packagePath, '{"scripts":{"test":"exit 0"}}\n');
          else writeFileSync(packagePath, original);
          return { exitCode: 0, error: null };
        },
      }),
    ).rejects.toThrow(
      "release claim source tree changed while checks were running",
    );
    expect(invocation).toBe(1);
    expect(existsSync(join(root, RELEASE_CLAIM_CI_RESULT_PATH))).toBe(false);
  });

  it("ignores lifecycle PATH and Node package-manager environment poisoning", () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const commandEnv = releaseClaimCommandEnvironment({
      nodePath: runtimeEnv.SKYTWIN_RELEASE_CI_NODE_PATH,
    });
    expect(commandEnv.PATH.startsWith(`${dirname(process.execPath)}:`)).toBe(
      true,
    );
    for (const name of [
      "GITHUB_PATH",
      "NODE_OPTIONS",
      "PNPM_HOME",
      "COREPACK_HOME",
    ])
      expect(commandEnv).not.toHaveProperty(name);
  });

  it("refuses a result when the captured delegated pnpm bundle changes", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    let mutated = false;
    await expect(
      runReleaseClaimCi({
        root,
        env: runtimeEnv,
        execute: async () => {
          if (!mutated) {
            mutated = true;
            writeFileSync(
              runtimeEnv.SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH,
              "// changed delegated pnpm CLI bundle\n",
            );
          }
          return { exitCode: 0, error: null };
        },
      }),
    ).rejects.toThrow("pnpm entry runtime identity changed after capture");
    expect(existsSync(join(root, RELEASE_CLAIM_CI_RESULT_PATH))).toBe(false);
  });

  it("rejects a hard-linked captured runtime before executing a command", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const outside = mkdtempSync(
      join(tmpdir(), "skytwin-release-runtime-link-"),
    );
    roots.push(outside);
    linkSync(
      runtimeEnv.SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH,
      join(outside, "linked-pnpm.cjs"),
    );

    const execute = vi.fn(async () => ({ exitCode: 0, error: null }));
    await expect(
      runReleaseClaimCi({ root, env: runtimeEnv, execute }),
    ).rejects.toThrow("pnpm entry runtime identity changed after capture");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a runtime mutation before a later command can restore it", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const original = readFileSync(
      runtimeEnv.SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH,
      "utf8",
    );
    let invocation = 0;
    await expect(
      runReleaseClaimCi({
        root,
        env: runtimeEnv,
        execute: async () => {
          invocation += 1;
          if (invocation === 1)
            writeFileSync(
              runtimeEnv.SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH,
              "// malicious delegated bundle\n",
            );
          else
            writeFileSync(
              runtimeEnv.SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH,
              original,
            );
          return { exitCode: 0, error: null };
        },
      }),
    ).rejects.toThrow("pnpm entry runtime identity changed after capture");
    expect(invocation).toBe(1);
    expect(existsSync(join(root, RELEASE_CLAIM_CI_RESULT_PATH))).toBe(false);
  });

  it("does not touch an outside target through a symlinked output directory", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const outside = mkdtempSync(join(tmpdir(), "skytwin-release-ci-outside-"));
    roots.push(outside);
    symlinkSync(outside, join(root, "release-claims-ci"));
    await expect(
      runReleaseClaimCi({
        root,
        env: runtimeEnv,
        execute: async () => ({ exitCode: 0, error: null }),
      }),
    ).rejects.toThrow(
      "release claim source tree changed while checks were running",
    );
    expect(existsSync(join(outside, "result.json"))).toBe(false);
  });

  it("rejects an in-process output-directory substitution", async () => {
    const root = fixtureRoot();
    const runtimeEnv = releaseEnv(root);
    const outside = mkdtempSync(join(tmpdir(), "skytwin-release-ci-outside-"));
    roots.push(outside);
    let substituted = false;
    await expect(
      runReleaseClaimCi({
        root,
        env: runtimeEnv,
        execute: async () => {
          if (!substituted) {
            substituted = true;
            symlinkSync(outside, join(root, "release-claims-ci"));
          }
          return { exitCode: 0, error: null };
        },
      }),
    ).rejects.toThrow(
      "release claim source tree changed while checks were running",
    );
    expect(existsSync(join(outside, "result.json"))).toBe(false);
  });

  it.each(["symlink", "hardlink"])(
    "does not replace an existing %s result target",
    async (linkKind) => {
      const root = fixtureRoot();
      const runtimeEnv = releaseEnv(root);
      const outside = mkdtempSync(
        join(tmpdir(), "skytwin-release-ci-outside-"),
      );
      roots.push(outside);
      const outsideTarget = join(outside, "result.json");
      writeFileSync(outsideTarget, "outside remains unchanged\n");
      mkdirSync(join(root, "release-claims-ci"));
      const resultPath = join(root, RELEASE_CLAIM_CI_RESULT_PATH);
      if (linkKind === "symlink") symlinkSync(outsideTarget, resultPath);
      else linkSync(outsideTarget, resultPath);
      await expect(
        runReleaseClaimCi({
          root,
          env: runtimeEnv,
          execute: async () => ({ exitCode: 0, error: null }),
        }),
      ).rejects.toThrow();
      expect(readFileSync(outsideTarget, "utf8")).toBe(
        "outside remains unchanged\n",
      );
    },
    15_000,
  );

  it("uses spawn with an explicit no-shell execution boundary", () => {
    const source = readFileSync(
      new URL("./run-release-claim-ci.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain("spawn(executable, args, {");
    expect(source).toContain("shell: false");
    expect(source).not.toMatch(/\bexec(?:File)?(?:Sync)?\s*\(/u);
  });
});
