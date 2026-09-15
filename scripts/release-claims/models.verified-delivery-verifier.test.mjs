import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_REGISTRY } from "../../packages/embedded-llm/src/model-registry.ts";
import {
  CANONICAL_MODEL,
  CHECK_IDS,
  assertSourceCheckout,
  buildReport,
  downloadAndVerifyModel,
  inspectReleaseSubject,
  inspectStableRegularFile,
  parseCanonicalArgs,
  readRunIdentity,
  resolveCurrentRun,
  resolveReleaseArtifact,
  writeReport,
} from "./verifiers/models.verified-delivery.mjs";
import { verifyMachineEvidenceApplicability } from "./check-release-claims.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix = "model-delivery-test-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function testModel(bytes = Buffer.from("immutable model bytes")) {
  return {
    id: "fixture-model",
    name: "fixture-model.gguf",
    repository: "owner/model",
    revision: "a".repeat(40),
    source: `https://huggingface.co/owner/model/resolve/${"a".repeat(40)}/fixture-model.gguf`,
    metadata: `https://huggingface.co/api/models/owner/model/revision/${"a".repeat(40)}?blobs=true`,
    allowedRedirectHosts: ["cdn.example.test"],
    exactBytes: bytes.length,
    sha256: digest(bytes),
    license: {
      spdxId: "Apache-2.0",
      name: "Apache License 2.0",
      url: `https://huggingface.co/owner/model/blob/${"a".repeat(40)}/LICENSE`,
    },
  };
}

function canonicalModelArtifact() {
  return {
    id: CANONICAL_MODEL.id,
    name: CANONICAL_MODEL.name,
    source: CANONICAL_MODEL.source,
    deliveryHost: CANONICAL_MODEL.allowedRedirectHosts[0],
    sourceRepository: CANONICAL_MODEL.repository,
    sourceRevision: CANONICAL_MODEL.revision,
    metadata: CANONICAL_MODEL.metadata,
    license: CANONICAL_MODEL.license.spdxId,
    licenseName: CANONICAL_MODEL.license.name,
    licenseUrl: CANONICAL_MODEL.license.url,
    exactBytes: CANONICAL_MODEL.exactBytes,
    sha256: CANONICAL_MODEL.sha256,
    digestVerificationResult: "pass",
    stableFileIdentityResult: "pass",
    deletionResult: "pass",
  };
}

function bytesResponse(bytes, overrides = {}) {
  return new Response(bytes, {
    status: overrides.status ?? 200,
    headers: {
      "content-length": String(bytes.length),
      ...overrides.headers,
    },
  });
}

function identity(overrides = {}) {
  return {
    sourceCommit: "a".repeat(40),
    repository: "owner/repo",
    releaseTag: "v0.6.102.0",
    ref: "refs/tags/v0.6.102.0",
    runId: 123,
    runAttempt: 2,
    token: "token-that-is-long-enough",
    ...overrides,
  };
}

function git(root, args, env = {}) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    },
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function sourceCheckout() {
  const root = temporaryRoot("model-source-checkout-");
  writeFileSync(join(root, "tracked.txt"), "reviewed source\n");
  writeFileSync(join(root, "target.txt"), "reviewed target\n");
  symlinkSync("target.txt", join(root, "tracked-link"));
  git(root, ["init", "--quiet"]);
  git(root, ["add", "--all"]);
  git(root, [
    "-c",
    "user.name=Verifier Test",
    "-c",
    "user.email=verifier@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return {
    root,
    identity: identity({ sourceCommit: git(root, ["rev-parse", "HEAD"]) }),
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("reviewed model pin", () => {
  it("exactly mirrors the sole maintained registry recommendation", () => {
    expect(MODEL_REGISTRY).toHaveLength(1);
    const registry = MODEL_REGISTRY[0];
    expect(CANONICAL_MODEL).toMatchObject({
      id: registry.id,
      name: registry.source.filename,
      repository: registry.source.repository,
      revision: registry.source.revision,
      source: registry.source.downloadUrl,
      metadata: registry.source.metadataUrl,
      allowedRedirectHosts: [...registry.source.allowedRedirectHosts],
      exactBytes: registry.exactBytes,
      sha256: registry.sha256,
      license: { ...registry.license },
    });
  });
});

describe("source checkout identity", () => {
  it.each(["--skip-worktree", "--assume-unchanged"])(
    "rejects a hidden tracked modification marked %s",
    (flag) => {
      const fixture = sourceCheckout();
      git(fixture.root, ["update-index", flag, "tracked.txt"]);
      writeFileSync(join(fixture.root, "tracked.txt"), "unreviewed source\n");
      expect(
        git(fixture.root, ["status", "--porcelain=v1", "--untracked-files=no"]),
      ).toBe("");
      expect(() =>
        assertSourceCheckout(fixture.root, fixture.identity),
      ).toThrow(/skip-worktree|assume-unchanged/);
    },
  );

  it("uses the absolute Git binary and ignores inherited config, index, and fsmonitor authority", () => {
    const fixture = sourceCheckout();
    const attacker = temporaryRoot("model-git-attacker-");
    const pathMarker = join(attacker, "path-git-ran");
    const monitorMarker = join(attacker, "fsmonitor-ran");
    const fakeGit = join(attacker, "git");
    const fakeMonitor = join(attacker, "fsmonitor");
    writeFileSync(fakeGit, `#!/bin/sh\n: > '${pathMarker}'\nexit 1\n`);
    writeFileSync(fakeMonitor, `#!/bin/sh\n: > '${monitorMarker}'\nexit 1\n`);
    chmodSync(fakeGit, 0o755);
    chmodSync(fakeMonitor, 0o755);
    git(fixture.root, ["config", "core.fsmonitor", fakeMonitor]);

    const names = [
      "PATH",
      "GIT_INDEX_FILE",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ];
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      process.env.PATH = attacker;
      process.env.GIT_INDEX_FILE = join(attacker, "alternate-index");
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
      process.env.GIT_CONFIG_VALUE_0 = fakeMonitor;
      expect(() =>
        assertSourceCheckout(fixture.root, fixture.identity),
      ).not.toThrow();
      expect(existsSync(pathMarker)).toBe(false);
      expect(existsSync(monitorMarker)).toBe(false);
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });

  it("rejects executable-mode, symlink-type, and hard-link changes", () => {
    const executable = sourceCheckout();
    chmodSync(join(executable.root, "tracked.txt"), 0o755);
    expect(() =>
      assertSourceCheckout(executable.root, executable.identity),
    ).toThrow(/source tree changed/);

    const symlink = sourceCheckout();
    unlinkSync(join(symlink.root, "tracked-link"));
    writeFileSync(join(symlink.root, "tracked-link"), "target.txt");
    expect(() => assertSourceCheckout(symlink.root, symlink.identity)).toThrow(
      /symbolic link/,
    );

    const hardlink = sourceCheckout();
    const linked = join(hardlink.root, "linked-copy");
    linkSync(join(hardlink.root, "tracked.txt"), linked);
    expect(() =>
      assertSourceCheckout(hardlink.root, hardlink.identity),
    ).toThrow(/single-link/);
  });
});

describe("canonical invocation and run identity", () => {
  it("accepts only the exact Linux report command", () => {
    expect(
      parseCanonicalArgs([
        "--platform",
        "linux",
        "--output",
        ".release-evidence/reports/models.verified-delivery.json",
      ]),
    ).toEqual({
      platform: "linux",
      output: ".release-evidence/reports/models.verified-delivery.json",
    });
    expect(() =>
      parseCanonicalArgs(["--platform", "macos", "--output", "report.json"]),
    ).toThrow(/canonical/);
    expect(() =>
      parseCanonicalArgs(["--platform", "linux", "--output", "../report.json"]),
    ).toThrow(/canonical/);
  });

  it("requires the exact tag push, runner, run, attempt, and repository identity", () => {
    const env = {
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      GITHUB_EVENT_NAME: "push",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_REF_NAME: "v0.6.102.0",
      GITHUB_REF: "refs/tags/v0.6.102.0",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_TOKEN: "token-that-is-long-enough",
    };
    expect(readRunIdentity(env)).toEqual(identity());
    expect(() =>
      readRunIdentity({ ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }),
    ).toThrow(/tag push/);
    expect(() => readRunIdentity({ ...env, GITHUB_RUN_ATTEMPT: "0" })).toThrow(
      /positive/,
    );
    expect(() =>
      readRunIdentity({ ...env, GITHUB_REF: "refs/heads/main" }),
    ).toThrow(/match|invalid/);
  });

  it("rejects a current-run response with any mismatched immutable identity", async () => {
    const expected = identity();
    const canonical = {
      id: expected.runId,
      run_attempt: expected.runAttempt,
      repository: { full_name: expected.repository },
      head_sha: expected.sourceCommit,
      head_branch: expected.releaseTag,
      event: "push",
      path: ".github/workflows/build.yml",
    };
    await expect(
      resolveCurrentRun(expected, async () => jsonResponse(canonical)),
    ).resolves.toEqual(canonical);
    for (const mutation of [
      { run_attempt: 1 },
      { head_sha: "b".repeat(40) },
      { head_branch: "main" },
      { event: "workflow_dispatch" },
      { path: ".github/workflows/other.yml" },
      { repository: { full_name: "other/repo" } },
    ]) {
      await expect(
        resolveCurrentRun(expected, async () =>
          jsonResponse({ ...canonical, ...mutation }),
        ),
      ).rejects.toThrow(/exact canonical/);
    }
  });
});

describe("current-run release artifact identity", () => {
  it("requires exactly one unexpired digest-bound AppImage artifact and matching detail", async () => {
    const expected = identity();
    const artifact = {
      id: 456,
      name: "SkyTwin-Linux-AppImage",
      digest: `sha256:${"b".repeat(64)}`,
      expired: false,
      workflow_run: { id: 123, head_sha: "a".repeat(40) },
    };
    const fetchImpl = async (url) =>
      url.endsWith("/actions/artifacts/456")
        ? jsonResponse(artifact)
        : jsonResponse({ total_count: 1, artifacts: [artifact] });
    await expect(resolveReleaseArtifact(expected, fetchImpl)).resolves.toEqual({
      artifactId: 456,
      artifactName: "SkyTwin-Linux-AppImage",
      artifactSha256: "b".repeat(64),
      kind: "desktop-installer",
    });
  });

  it.each([
    { total_count: 0, artifacts: [] },
    {
      total_count: 2,
      artifacts: [
        { id: 1, name: "SkyTwin-Linux-AppImage" },
        { id: 2, name: "SkyTwin-Linux-AppImage" },
      ],
    },
  ])("rejects missing or duplicate release artifacts", async (inventory) => {
    await expect(
      resolveReleaseArtifact(identity(), async () => jsonResponse(inventory)),
    ).rejects.toThrow(/one current-run/);
  });

  it("accepts only the exact derived-version AppImage subject", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "VERSION"), "0.6.102.0\n");
    const directory = join(root, "artifacts", "SkyTwin-Linux-AppImage");
    mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from("release subject");
    writeFileSync(join(directory, "SkyTwin-0.6.10200.AppImage"), bytes);
    expect(
      inspectReleaseSubject(root, "v0.6.102.0", {
        artifactName: "SkyTwin-Linux-AppImage",
      }),
    ).toMatchObject({
      name: "SkyTwin-0.6.10200.AppImage",
      relativePath:
        "artifacts/SkyTwin-Linux-AppImage/SkyTwin-0.6.10200.AppImage",
      sha256: digest(bytes),
    });
    renameSync(
      join(directory, "SkyTwin-0.6.10200.AppImage"),
      join(directory, "SkyTwin-latest.AppImage"),
    );
    expect(() =>
      inspectReleaseSubject(root, "v0.6.102.0", {
        artifactName: "SkyTwin-Linux-AppImage",
      }),
    ).toThrow(/canonical/);
  });
});

describe("pinned model delivery", () => {
  it("accepts exact bytes from the reviewed source and deletes its isolated candidate", async () => {
    const bytes = Buffer.from("immutable model bytes");
    const model = testModel(bytes);
    const parent = temporaryRoot();
    const observed = await downloadAndVerifyModel(model, {
      temporaryParent: parent,
      fetchImpl: async (url, options) => {
        expect(url).toBe(model.source);
        expect(options.redirect).toBe("manual");
        return bytesResponse(bytes);
      },
    });
    expect(observed).toMatchObject({
      id: model.id,
      name: model.name,
      source: model.source,
      exactBytes: bytes.length,
      sha256: model.sha256,
      digestVerificationResult: "pass",
      stableFileIdentityResult: "pass",
      deletionResult: "pass",
    });
    expect(readdirSync(parent)).toEqual([]);
  });

  it("permits only an explicitly allowlisted HTTPS redirect", async () => {
    const bytes = Buffer.from("immutable model bytes");
    const model = testModel(bytes);
    let calls = 0;
    const observed = await downloadAndVerifyModel(model, {
      temporaryParent: temporaryRoot(),
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? bytesResponse(Buffer.alloc(0), {
              status: 302,
              headers: {
                location:
                  "https://cdn.example.test/pinned-object?token=do-not-persist",
              },
            })
          : bytesResponse(bytes);
      },
    });
    expect(observed.deliveryHost).toBe("cdn.example.test");
    expect(JSON.stringify(observed)).not.toContain("pinned-object");
    expect(JSON.stringify(observed)).not.toContain("do-not-persist");
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: async () =>
          bytesResponse(Buffer.alloc(0), {
            status: 302,
            headers: { location: "https://attacker.example/model" },
          }),
      }),
    ).rejects.toThrow(/allowlist/);
  });

  it("fails closed on absent, short, oversized, or digest-mismatched candidate bytes", async () => {
    const bytes = Buffer.from("immutable model bytes");
    const model = testModel(bytes);
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: async () =>
          bytesResponse(bytes.subarray(0, bytes.length - 1), {
            headers: { "content-length": String(model.exactBytes) },
          }),
      }),
    ).rejects.toThrow(/incomplete/);
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: async () =>
          bytesResponse(Buffer.concat([bytes, Buffer.from("x")]), {
            headers: { "content-length": String(model.exactBytes) },
          }),
      }),
    ).rejects.toThrow(/exceeded/);
    const wrong = Buffer.from(bytes);
    wrong[0] ^= 1;
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: async () => bytesResponse(wrong),
      }),
    ).rejects.toThrow(/digest/);
  });

  it("rejects an unsafe model identity before it can escape the private download root", async () => {
    const model = { ...testModel(), name: "../escape.gguf" };
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: async () => {
          throw new Error("network must not be reached");
        },
      }),
    ).rejects.toThrow(/identity/);
  });

  it("rejects path replacement and mutation while hashing", () => {
    const root = temporaryRoot();
    const bytes = Buffer.from("stable bytes");
    const path = join(root, "model.gguf");
    writeFileSync(path, bytes);
    expect(() =>
      inspectStableRegularFile(
        root,
        path,
        "model",
        bytes.length,
        digest(bytes),
        {
          afterOpen: () => {
            renameSync(path, join(root, "old.gguf"));
            writeFileSync(path, bytes);
          },
        },
      ),
    ).toThrow(/replaced|changed/);
  });

  it("rejects symlink and hard-link candidates", () => {
    const root = temporaryRoot();
    const outside = join(root, "outside.gguf");
    const symlink = join(root, "symlink.gguf");
    const hardlink = join(root, "hardlink.gguf");
    const bytes = Buffer.from("stable bytes");
    writeFileSync(outside, bytes);
    symlinkSync(outside, symlink);
    linkSync(outside, hardlink);
    expect(() =>
      inspectStableRegularFile(
        root,
        symlink,
        "model",
        bytes.length,
        digest(bytes),
      ),
    ).toThrow(/regular|symlink/);
    expect(() =>
      inspectStableRegularFile(
        root,
        hardlink,
        "model",
        bytes.length,
        digest(bytes),
      ),
    ).toThrow(/private/);
  });
});

describe("machine report", () => {
  it("binds the exact tag run, attempt, release subject, verifier, model pin, and canonical checks", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "scripts", "release-claims", "verifiers"), {
      recursive: true,
    });
    writeFileSync(
      join(
        root,
        "scripts",
        "release-claims",
        "verifiers",
        "models.verified-delivery.mjs",
      ),
      "reviewed verifier\n",
    );
    const report = buildReport({
      root,
      identity: identity(),
      artifact: {
        artifactId: 456,
        artifactName: "SkyTwin-Linux-AppImage",
        artifactSha256: "b".repeat(64),
        kind: "desktop-installer",
      },
      releaseSubject: {
        name: "SkyTwin-0.6.10200.AppImage",
        relativePath:
          "artifacts/SkyTwin-Linux-AppImage/SkyTwin-0.6.10200.AppImage",
        sha256: "c".repeat(64),
      },
      modelArtifact: canonicalModelArtifact(),
      runtime: { platform: "linux", arch: "x64" },
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      claimId: "models.verified-delivery",
      result: "pass",
      sourceCommit: "a".repeat(40),
      runId: 123,
      runAttempt: 2,
      subjectSha256: "c".repeat(64),
      verifierSha256: digest(Buffer.from("reviewed verifier\n")),
    });
    expect(report.checks.map(({ id }) => id)).toEqual(CHECK_IDS);
    expect(
      verifyMachineEvidenceApplicability(
        "models.verified-delivery",
        report,
        [],
      ),
    ).toEqual([]);
  });

  it("creates the report exclusively and refuses symlinked parents or overwrite", () => {
    const root = temporaryRoot();
    writeReport(
      root,
      ".release-evidence/reports/models.verified-delivery.json",
      { result: "pass" },
    );
    expect(() =>
      writeReport(
        root,
        ".release-evidence/reports/models.verified-delivery.json",
        { result: "pass" },
      ),
    ).toThrow();

    const unsafe = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(unsafe, ".release-evidence"));
    symlinkSync(outside, join(unsafe, ".release-evidence", "reports"));
    expect(() =>
      writeReport(
        unsafe,
        ".release-evidence/reports/models.verified-delivery.json",
        { result: "pass" },
      ),
    ).toThrow(/unsafe/);
  });
});
