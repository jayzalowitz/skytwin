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
  RELEASE_SUBJECT_DIRECTORY,
  assertSourceCheckout,
  buildReport,
  downloadAndVerifyModel,
  inspectReleaseSubject,
  inspectStableRegularFile,
  observePinnedLicense,
  observePinnedMetadata,
  parseCanonicalArgs,
  readRunIdentity,
  resolveCurrentRun,
  resolveAttemptProvenance,
  resolveReleaseArtifact,
  writeReport,
} from "./verifiers/models.verified-delivery.mjs";
import { verifyMachineEvidenceApplicability } from "./check-release-claims.mjs";

const roots = [];
const FIXTURE_LICENSE_BYTES = Buffer.from("fixture Apache license bytes\n");

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
  const licenseBlobId = createHash("sha1")
    .update(`blob ${FIXTURE_LICENSE_BYTES.length}\0`)
    .update(FIXTURE_LICENSE_BYTES)
    .digest("hex");
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
      cardId: "apache-2.0",
      name: "Apache License 2.0",
      url: `https://huggingface.co/owner/model/blob/${"a".repeat(40)}/LICENSE`,
      source: `https://huggingface.co/owner/model/resolve/${"a".repeat(40)}/LICENSE`,
      exactBytes: FIXTURE_LICENSE_BYTES.length,
      sha256: digest(FIXTURE_LICENSE_BYTES),
      blobId: licenseBlobId,
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
    metadataRepository: CANONICAL_MODEL.repository,
    metadataRevision: CANONICAL_MODEL.revision,
    metadataCardLicense: CANONICAL_MODEL.license.cardId,
    metadataSiblingName: CANONICAL_MODEL.name,
    metadataSiblingExactBytes: CANONICAL_MODEL.exactBytes,
    metadataSiblingSha256: CANONICAL_MODEL.sha256,
    metadataLicenseSiblingName: "LICENSE",
    metadataLicenseSiblingExactBytes: CANONICAL_MODEL.license.exactBytes,
    metadataLicenseSiblingBlobId: CANONICAL_MODEL.license.blobId,
    metadataVerificationResult: "pass",
    license: CANONICAL_MODEL.license.spdxId,
    licenseName: CANONICAL_MODEL.license.name,
    licenseUrl: CANONICAL_MODEL.license.url,
    licenseSource: CANONICAL_MODEL.license.source,
    licenseExactBytes: CANONICAL_MODEL.license.exactBytes,
    licenseSha256: CANONICAL_MODEL.license.sha256,
    licenseBlobId: CANONICAL_MODEL.license.blobId,
    licenseVerificationResult: "pass",
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
    releaseArtifactId: 456,
    releaseArtifactSha256: "b".repeat(64),
    releaseArtifactDownloadPath:
      "/home/runner/work/skytwin/skytwin/.release-evidence/model-delivery-subject",
    ...overrides,
  };
}

function attemptProvenance(overrides = {}) {
  return {
    producerJobId: 41,
    producerJobName: "Desktop — Linux (AppImage + deb + rpm)",
    producerJobRunAttempt: 2,
    producerJobConclusion: "success",
    runAttemptStartedAt: "2026-09-15T01:02:00Z",
    runAttemptStartedTimestamp: Date.parse("2026-09-15T01:02:00Z"),
    producerJobStartedAt: "2026-09-15T01:02:01Z",
    producerJobCompletedAt: "2026-09-15T01:02:07Z",
    producerJobStartedTimestamp: Date.parse("2026-09-15T01:02:01Z"),
    producerJobCompletedTimestamp: Date.parse("2026-09-15T01:02:07Z"),
    uploadStartedAt: "2026-09-15T01:02:03Z",
    uploadCompletedAt: "2026-09-15T01:02:05Z",
    uploadStartedTimestamp: Date.parse("2026-09-15T01:02:03Z"),
    uploadCompletedTimestamp: Date.parse("2026-09-15T01:02:05Z"),
    verifierJobId: 42,
    verifierJobName:
      "release-machine-evidence / models.verified-delivery / linux",
    verifierJobRunAttempt: 2,
    verifierJobStatus: "in_progress",
    downloadStepName: "Download exact Linux AppImage for model delivery",
    downloadStepConclusion: "success",
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

function modelMetadata(model, overrides = {}) {
  return {
    id: model.repository,
    sha: model.revision,
    cardData: { license: model.license.cardId },
    siblings: [
      {
        rfilename: model.name,
        size: model.exactBytes,
        lfs: { size: model.exactBytes, sha256: model.sha256 },
      },
      {
        rfilename: "LICENSE",
        size: model.license.exactBytes,
        blobId: model.license.blobId,
      },
    ],
    ...overrides,
  };
}

function deliveryFetch(model, modelResponder) {
  return async (url, options) => {
    if (url === model.metadata) return jsonResponse(modelMetadata(model));
    if (url === model.license.source)
      return bytesResponse(FIXTURE_LICENSE_BYTES);
    return modelResponder(url, options);
  };
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
      SKYTWIN_LINUX_APPIMAGE_ARTIFACT_ID: "456",
      SKYTWIN_LINUX_APPIMAGE_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
      SKYTWIN_MODEL_APPIMAGE_DOWNLOAD_PATH:
        "/home/runner/work/skytwin/skytwin/.release-evidence/model-delivery-subject",
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
      run_started_at: "2026-09-15T01:02:00Z",
    };
    const urls = [];
    await expect(
      resolveCurrentRun(expected, async (url) => {
        urls.push(url);
        return jsonResponse(canonical);
      }),
    ).resolves.toMatchObject({
      run: canonical,
      attempt: canonical,
      runAttemptStartedAt: "2026-09-15T01:02:00Z",
      runAttemptStartedTimestamp: Date.parse("2026-09-15T01:02:00Z"),
    });
    expect(urls).toEqual([
      "https://api.github.com/repos/owner/repo/actions/runs/123",
      "https://api.github.com/repos/owner/repo/actions/runs/123/attempts/2",
    ]);
    for (const mutation of [
      { run_attempt: 1 },
      { head_sha: "b".repeat(40) },
      { head_branch: "main" },
      { event: "workflow_dispatch" },
      { path: ".github/workflows/other.yml" },
      { repository: { full_name: "other/repo" } },
      { run_started_at: "not-a-timestamp" },
    ]) {
      await expect(
        resolveCurrentRun(expected, async () =>
          jsonResponse({ ...canonical, ...mutation }),
        ),
      ).rejects.toThrow(/exact canonical|timestamp is invalid/);
    }
  });
});

describe("current-run release artifact identity", () => {
  it("binds producer and active verifier jobs to the exact workflow attempt", async () => {
    const jobs = [
      {
        id: 41,
        run_id: 123,
        run_attempt: 2,
        head_sha: "a".repeat(40),
        name: "Desktop — Linux (AppImage + deb + rpm)",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-15T01:02:01Z",
        completed_at: "2026-09-15T01:02:07Z",
        steps: [
          { name: "Package Linux desktop app", conclusion: "success" },
          {
            name: "Upload Linux AppImage",
            conclusion: "success",
            started_at: "2026-09-15T01:02:03Z",
            completed_at: "2026-09-15T01:02:05Z",
          },
        ],
      },
      {
        id: 42,
        run_id: 123,
        run_attempt: 2,
        head_sha: "a".repeat(40),
        name: "release-machine-evidence / models.verified-delivery / linux",
        status: "in_progress",
        conclusion: null,
        steps: [
          {
            name: "Download exact Linux AppImage for model delivery",
            status: "completed",
            conclusion: "success",
          },
          {
            name: "Run canonical machine verifier",
            status: "in_progress",
            conclusion: null,
          },
        ],
      },
    ];
    const fetchImpl = async (url) => {
      expect(url).toContain("/runs/123/attempts/2/jobs?");
      return jsonResponse({ total_count: jobs.length, jobs });
    };
    await expect(
      resolveAttemptProvenance(
        identity(),
        "2026-09-15T01:02:00Z",
        fetchImpl,
      ),
    ).resolves.toMatchObject(attemptProvenance());

    const staleJobs = jobs.map((job) => ({ ...job, run_attempt: 1 }));
    await expect(
      resolveAttemptProvenance(
        identity(),
        "2026-09-15T01:02:00Z",
        async () =>
          jsonResponse({ total_count: staleJobs.length, jobs: staleJobs }),
      ),
    ).rejects.toThrow(/exact workflow attempt/);

    const relabeledCarriedForward = jobs.map((job) =>
      job.id === 41
        ? {
            ...job,
            started_at: "2026-09-14T01:02:01Z",
            completed_at: "2026-09-14T01:02:07Z",
          }
        : job,
    );
    await expect(
      resolveAttemptProvenance(
        identity(),
        "2026-09-15T01:02:00Z",
        async () =>
          jsonResponse({
            total_count: relabeledCarriedForward.length,
            jobs: relabeledCarriedForward,
          }),
      ),
    ).rejects.toThrow(/outside the current workflow attempt/);

    const missingExactDownload = jobs.map((job) =>
      job.id === 42
        ? {
            ...job,
            steps: job.steps.filter(
              (step) =>
                step.name !==
                "Download exact Linux AppImage for model delivery",
            ),
          }
        : job,
    );
    await expect(
      resolveAttemptProvenance(
        identity(),
        "2026-09-15T01:02:00Z",
        async () =>
          jsonResponse({
            total_count: missingExactDownload.length,
            jobs: missingExactDownload,
          }),
      ),
    ).rejects.toThrow(/exact-ID Linux AppImage download/);
  });

  it("requires exactly one unexpired digest-bound AppImage artifact and matching detail", async () => {
    const expected = identity();
    const artifact = {
      id: 456,
      name: "SkyTwin-Linux-AppImage",
      digest: `sha256:${"b".repeat(64)}`,
      expired: false,
      created_at: "2026-09-15T01:02:04Z",
      workflow_run: { id: 123, head_sha: "a".repeat(40) },
    };
    const fetchImpl = async (url) =>
      url.endsWith("/actions/artifacts/456")
        ? jsonResponse(artifact)
        : jsonResponse({ total_count: 1, artifacts: [artifact] });
    await expect(
      resolveReleaseArtifact(expected, attemptProvenance(), fetchImpl),
    ).resolves.toEqual({
      artifactId: 456,
      artifactName: "SkyTwin-Linux-AppImage",
      artifactSha256: "b".repeat(64),
      artifactCreatedAt: "2026-09-15T01:02:04Z",
      attemptBindingResult: "workflow-output-and-producer-window-pass",
      kind: "desktop-installer",
    });
  });

  it("accepts GitHub's observed one-second post-upload timestamp but rejects a post-job artifact", async () => {
    const artifact = {
      id: 456,
      name: "SkyTwin-Linux-AppImage",
      digest: `sha256:${"b".repeat(64)}`,
      expired: false,
      created_at: "2026-09-15T01:02:06Z",
      workflow_run: { id: 123, head_sha: "a".repeat(40) },
    };
    const fetchFor = (candidate) => async (url) =>
      url.endsWith("/actions/artifacts/456")
        ? jsonResponse(candidate)
        : jsonResponse({ total_count: 1, artifacts: [candidate] });
    await expect(
      resolveReleaseArtifact(
        identity(),
        attemptProvenance(),
        fetchFor(artifact),
      ),
    ).resolves.toMatchObject({
      artifactCreatedAt: "2026-09-15T01:02:06Z",
      attemptBindingResult: "workflow-output-and-producer-window-pass",
    });

    const postJob = { ...artifact, created_at: "2026-09-15T01:02:08Z" };
    await expect(
      resolveReleaseArtifact(
        identity(),
        attemptProvenance(),
        fetchFor(postJob),
      ),
    ).rejects.toThrow(/producer window/);
  });

  it("rejects a same-run artifact retained from a prior attempt", async () => {
    const stale = {
      id: 456,
      name: "SkyTwin-Linux-AppImage",
      digest: `sha256:${"b".repeat(64)}`,
      expired: false,
      created_at: "2026-09-14T01:02:04Z",
      workflow_run: { id: 123, head_sha: "a".repeat(40) },
    };
    await expect(
      resolveReleaseArtifact(identity(), attemptProvenance(), async (url) =>
        url.endsWith("/actions/artifacts/456")
          ? jsonResponse(stale)
          : jsonResponse({ total_count: 1, artifacts: [stale] }),
      ),
    ).rejects.toThrow(/exact-attempt/);
  });

  it("accepts only the exact derived-version AppImage subject", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "VERSION"), "0.6.102.0\n");
    const directory = join(root, RELEASE_SUBJECT_DIRECTORY);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from("release subject");
    writeFileSync(join(directory, "SkyTwin-0.6.10200.AppImage"), bytes);
    expect(
      inspectReleaseSubject(
        root,
        "v0.6.102.0",
        {
          artifactName: "SkyTwin-Linux-AppImage",
        },
        directory,
      ),
    ).toMatchObject({
      name: "SkyTwin-0.6.10200.AppImage",
      relativePath:
        "artifacts/SkyTwin-Linux-AppImage/SkyTwin-0.6.10200.AppImage",
      downloadPath:
        ".release-evidence/model-delivery-subject/SkyTwin-0.6.10200.AppImage",
      sha256: digest(bytes),
    });
    renameSync(
      join(directory, "SkyTwin-0.6.10200.AppImage"),
      join(directory, "SkyTwin-latest.AppImage"),
    );
    expect(() =>
      inspectReleaseSubject(
        root,
        "v0.6.102.0",
        {
          artifactName: "SkyTwin-Linux-AppImage",
        },
        directory,
      ),
    ).toThrow(/canonical/);
  });

  it("ignores a stale same-name rerun artifact outside the exact-ID download path", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "VERSION"), "0.6.102.0\n");
    const exactDirectory = join(root, RELEASE_SUBJECT_DIRECTORY);
    const staleDirectory = join(root, "artifacts", "SkyTwin-Linux-AppImage");
    mkdirSync(exactDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(staleDirectory, { recursive: true });
    const name = "SkyTwin-0.6.10200.AppImage";
    const exactBytes = Buffer.from("current exact-ID artifact");
    const staleBytes = Buffer.from("stale same-name rerun artifact");
    writeFileSync(join(exactDirectory, name), exactBytes);
    writeFileSync(join(staleDirectory, name), staleBytes);

    const observed = inspectReleaseSubject(
      root,
      "v0.6.102.0",
      { artifactName: "SkyTwin-Linux-AppImage" },
      exactDirectory,
    );
    expect(observed.sha256).toBe(digest(exactBytes));
    expect(observed.sha256).not.toBe(digest(staleBytes));
    expect(() =>
      inspectReleaseSubject(
        root,
        "v0.6.102.0",
        { artifactName: "SkyTwin-Linux-AppImage" },
        staleDirectory,
      ),
    ).toThrow(/download path/);
    chmodSync(exactDirectory, 0o755);
    expect(() =>
      inspectReleaseSubject(
        root,
        "v0.6.102.0",
        { artifactName: "SkyTwin-Linux-AppImage" },
        exactDirectory,
      ),
    ).toThrow(/unsafe/);
  });
});

describe("pinned model delivery", () => {
  it("observes immutable repository metadata, LFS identity, and LICENSE bytes", async () => {
    const model = testModel();
    await expect(
      observePinnedMetadata(model, async (url, options) => {
        expect(url).toBe(model.metadata);
        expect(options.redirect).toBe("manual");
        return jsonResponse(modelMetadata(model));
      }),
    ).resolves.toMatchObject({
      repository: model.repository,
      revision: model.revision,
      cardLicense: model.license.cardId,
      modelSiblingExactBytes: model.exactBytes,
      modelSiblingSha256: model.sha256,
      verificationResult: "pass",
    });
    for (const metadata of [
      modelMetadata(model, { id: "attacker/model" }),
      modelMetadata(model, { sha: "b".repeat(40) }),
      modelMetadata(model, { cardData: { license: "other" } }),
      modelMetadata(model, {
        siblings: modelMetadata(model).siblings.map((sibling) =>
          sibling.rfilename === model.name
            ? { ...sibling, lfs: { ...sibling.lfs, sha256: "f".repeat(64) } }
            : sibling,
        ),
      }),
    ])
      await expect(
        observePinnedMetadata(model, async () => jsonResponse(metadata)),
      ).rejects.toThrow(/metadata/);

    await expect(
      observePinnedLicense(model, async (url, options) => {
        expect(url).toBe(model.license.source);
        expect(options.redirect).toBe("manual");
        return bytesResponse(FIXTURE_LICENSE_BYTES);
      }),
    ).resolves.toMatchObject({
      source: model.license.source,
      exactBytes: model.license.exactBytes,
      sha256: model.license.sha256,
      blobId: model.license.blobId,
      verificationResult: "pass",
    });
    const resolveKey = `/${model.repository}/resolve/${model.revision}/LICENSE`;
    const cacheLocation =
      `https://huggingface.co/api/resolve-cache/models/${model.repository}/${model.revision}/LICENSE` +
      `?${encodeURIComponent(resolveKey)}=&etag=${encodeURIComponent(`\"${model.license.blobId}\"`)}`;
    let licenseCalls = 0;
    const redirected = await observePinnedLicense(model, async () => {
      licenseCalls += 1;
      return licenseCalls === 1
        ? bytesResponse(Buffer.alloc(0), {
            status: 307,
            headers: { location: cacheLocation },
          })
        : bytesResponse(FIXTURE_LICENSE_BYTES);
    });
    expect(licenseCalls).toBe(2);
    expect(JSON.stringify(redirected)).not.toContain("resolve-cache");
    expect(JSON.stringify(redirected)).not.toContain("etag");
    await expect(
      observePinnedLicense(model, async () =>
        bytesResponse(Buffer.alloc(0), {
          status: 302,
          headers: {
            location:
              "https://huggingface.co/api/resolve-cache/models/attacker/model?token=secret",
          },
        }),
      ),
    ).rejects.toThrow(/immutable Hugging Face/);
  });

  it("accepts exact bytes from the reviewed source and deletes its isolated candidate", async () => {
    const bytes = Buffer.from("immutable model bytes");
    const model = testModel(bytes);
    const parent = temporaryRoot();
    const observed = await downloadAndVerifyModel(model, {
      temporaryParent: parent,
      fetchImpl: deliveryFetch(model, async (url, options) => {
        expect(url).toBe(model.source);
        expect(options.redirect).toBe("manual");
        return bytesResponse(bytes);
      }),
    });
    expect(observed).toMatchObject({
      id: model.id,
      name: model.name,
      source: model.source,
      exactBytes: bytes.length,
      sha256: model.sha256,
      metadataRepository: model.repository,
      metadataRevision: model.revision,
      metadataSiblingSha256: model.sha256,
      metadataVerificationResult: "pass",
      licenseExactBytes: model.license.exactBytes,
      licenseSha256: model.license.sha256,
      licenseBlobId: model.license.blobId,
      licenseVerificationResult: "pass",
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
      fetchImpl: deliveryFetch(model, async () => {
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
      }),
    });
    expect(observed.deliveryHost).toBe("cdn.example.test");
    expect(JSON.stringify(observed)).not.toContain("pinned-object");
    expect(JSON.stringify(observed)).not.toContain("do-not-persist");
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: deliveryFetch(model, async () =>
          bytesResponse(Buffer.alloc(0), {
            status: 302,
            headers: { location: "https://attacker.example/model" },
          }),
        ),
      }),
    ).rejects.toThrow(/allowlist/);
  });

  it("fails closed on absent, short, oversized, or digest-mismatched candidate bytes", async () => {
    const bytes = Buffer.from("immutable model bytes");
    const model = testModel(bytes);
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: deliveryFetch(
          model,
          async () => new Response(null, { status: 404 }),
        ),
      }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: deliveryFetch(model, async () =>
          bytesResponse(bytes.subarray(0, bytes.length - 1), {
            headers: { "content-length": String(model.exactBytes) },
          }),
        ),
      }),
    ).rejects.toThrow(/incomplete/);
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: deliveryFetch(model, async () =>
          bytesResponse(Buffer.concat([bytes, Buffer.from("x")]), {
            headers: { "content-length": String(model.exactBytes) },
          }),
        ),
      }),
    ).rejects.toThrow(/exceeded/);
    const wrong = Buffer.from(bytes);
    wrong[0] ^= 1;
    await expect(
      downloadAndVerifyModel(model, {
        temporaryParent: temporaryRoot(),
        fetchImpl: deliveryFetch(model, async () => bytesResponse(wrong)),
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
        artifactCreatedAt: "2026-09-15T01:02:04Z",
        attemptBindingResult: "workflow-output-and-producer-window-pass",
        kind: "desktop-installer",
      },
      attemptProvenance: attemptProvenance(),
      releaseSubject: {
        name: "SkyTwin-0.6.10200.AppImage",
        relativePath:
          "artifacts/SkyTwin-Linux-AppImage/SkyTwin-0.6.10200.AppImage",
        downloadPath:
          ".release-evidence/model-delivery-subject/SkyTwin-0.6.10200.AppImage",
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
      runAttemptStartedAt: "2026-09-15T01:02:00Z",
      releaseArtifactCreatedAt: "2026-09-15T01:02:04Z",
      desktopProducerJobId: 41,
      desktopProducerJobRunAttempt: 2,
      desktopProducerJobStartedAt: "2026-09-15T01:02:01Z",
      desktopProducerJobCompletedAt: "2026-09-15T01:02:07Z",
      verifierJobId: 42,
      verifierJobRunAttempt: 2,
      releaseArtifactDownloadPath:
        ".release-evidence/model-delivery-subject/SkyTwin-0.6.10200.AppImage",
      releaseArtifactDownloadStepConclusion: "success",
      releaseArtifactDownloadBindingResult:
        "exact-artifact-id-action-download-pass",
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
